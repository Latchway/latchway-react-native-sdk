import { LatchwayError } from "@latchway/client";
import type { LatchwayErrorCode } from "@latchway/client";
import { isCanonicalRequestID } from "./request-id.js";
import { assertNoCredentialFields } from "./native-output.js";

const knownCodeMap = {
  request_invalid: true,
  identity_token_missing: true,
  identity_token_invalid: true,
  identity_token_expired: true,
  identity_reauthentication_required: true,
  attestation_required: true,
  attestation_unsupported: true,
  attestation_invalid: true,
  attestation_stale: true,
  attestation_step_up_required: true,
  dpop_missing: true,
  dpop_invalid: true,
  dpop_replayed: true,
  dpop_nonce_required: true,
  session_expired: true,
  session_revoked: true,
  refresh_token_reused: true,
  installation_revoked: true,
  installation_family_revoked: true,
  installation_family_not_found: true,
  component_definition_not_found: true,
  component_not_configured: true,
  component_not_provisioned: true,
  component_revoked: true,
  component_key_invalid: true,
  component_key_replaced: true,
  component_delegation_expired: true,
  component_feature_not_granted: true,
  component_parent_trust_expired: true,
  component_direct_attestation_required: true,
  containing_app_setup_required: true,
  framework_integration_unsupported: true,
  framework_version_unsupported: true,
  transport_destination_not_allowed: true,
  transport_request_not_replayable: true,
  feature_not_found: true,
  feature_not_allowed: true,
  model_not_allowed: true,
  quota_exceeded: true,
  concurrency_exceeded: true,
  output_limit_exceeded: true,
  pricing_unavailable: true,
  route_not_found: true,
  upstream_unavailable: true,
  upstream_timeout: true,
  upstream_protocol_error: true,
  configuration_invalid: true,
  server_not_ready: true,
  protocol_version_unsupported: true,
  authentication_required: true,
  permission_denied: true,
  resource_not_found: true,
  conflict: true,
  etag_required: true,
  etag_mismatch: true,
  bootstrap_disabled: true,
  rate_limited: true,
  operation_indeterminate: true,
  internal_error: true,
  client_configuration_invalid: true,
  storage_unavailable: true,
  crypto_unavailable: true,
  attestation_provider_missing: true,
  protocol_response_invalid: true,
  request_not_replayable: true,
  network_error: true,
} as const satisfies Record<LatchwayErrorCode, true>;

const knownCodes: ReadonlySet<string> = new Set(Object.keys(knownCodeMap));

const localCodeMap: Readonly<Record<string, LatchwayErrorCode>> = {
  cancelled: "network_error",
  invalid_configuration: "client_configuration_invalid",
  invalid_request: "request_invalid",
  key_unavailable: "crypto_unavailable",
  secure_enclave_unavailable: "crypto_unavailable",
  secure_state_unavailable: "storage_unavailable",
  key_storage_failure: "storage_unavailable",
  response_invalid: "protocol_response_invalid",
  invalid_server_response: "protocol_response_invalid",
  network_unavailable: "network_error",
  transport_failure: "network_error",
  session_unavailable: "session_expired",
  attestation_unavailable: "attestation_unsupported",
};

export function fromNativeError(value: unknown): Error {
  try {
    assertNoCredentialFields(value);
  } catch (cause) {
    return cause instanceof LatchwayError
      ? cause
      : new LatchwayError("protocol_response_invalid", "Latchway returned unsafe native error metadata.");
  }
  if (isAbortError(value)) return abortError();
  const record = isRecord(value) ? value : {};
  const userInfo = isRecord(record.userInfo) ? record.userInfo : {};
  const rawCode = firstString(record.code, userInfo.code);
  const mapped = rawCode === undefined
    ? "internal_error"
    : localCodeMap[rawCode] ?? (knownCodes.has(rawCode)
      ? rawCode as LatchwayErrorCode
      : "internal_error");
  const codeValues = presentValues(record, userInfo, ["code"]);
  const requestIDValues = presentValues(record, userInfo, ["requestID", "request_id"]);
  const requestIDCandidate = firstString(record.requestID, record.request_id, userInfo.requestID, userInfo.request_id);
  const requestID = isCanonicalRequestID(requestIDCandidate) ? requestIDCandidate : undefined;
  const statusValues = presentValues(record, userInfo, ["status"]);
  const status = safeStatus(record.status ?? userInfo.status);
  const retryableValues = presentValues(record, userInfo, ["retryable"]);
  const retryable = record.retryable === true || userInfo.retryable === true;
  const documentationURLValues = presentValues(
    record,
    userInfo,
    ["documentationURL", "documentation_url"],
  );
  const canonicalNativeDocumentationURL = rawCode !== undefined && isNativeErrorCode(rawCode)
    ? `https://docs.latchway.dev/errors/${rawCode.replaceAll("_", "-")}`
    : undefined;
  const documentationURLIsValid = documentationURLValues.length > 0 &&
    canonicalNativeDocumentationURL !== undefined &&
    documentationURLValues.every((candidate) => candidate === canonicalNativeDocumentationURL);
  const operationValues = presentValues(record, userInfo, ["operationID", "operation_id"]);
  const operationID = operationValues.length > 0 &&
    operationValues.every((candidate) => candidate === operationValues[0]) &&
    isCanonicalOperationID(operationValues[0])
    ? operationValues[0]
    : undefined;
  const validIndeterminateMetadata = operationID !== undefined && requestID !== undefined &&
    status === 503 && retryable && codeValues.length > 0 &&
    codeValues.every((candidate) => candidate === "operation_indeterminate") &&
    requestIDValues.length > 0 && requestIDValues.every((candidate) => candidate === requestID) &&
    statusValues.length > 0 && statusValues.every((candidate) => candidate === 503) &&
    retryableValues.length > 0 && retryableValues.every((candidate) => candidate === true);
  const hasServerMetadata = requestIDValues.length > 0 || statusValues.length > 0;
  if ((documentationURLValues.length > 0 && !documentationURLIsValid) ||
      (hasServerMetadata && !documentationURLIsValid) ||
      (mapped === "operation_indeterminate" && !validIndeterminateMetadata) ||
      (mapped !== "operation_indeterminate" && operationValues.length > 0)) {
    return new LatchwayError(
      "protocol_response_invalid",
      "Latchway returned invalid native error metadata.",
      { requestID, status },
    );
  }
  return new LatchwayError(mapped, safeMessage(firstString(record.message, userInfo.message)), {
    requestID,
    status,
    retryable,
    operationID,
  });
}

export function nativeUnavailable(cause: unknown): LatchwayError {
  return new LatchwayError(
    "client_configuration_invalid",
    "The Latchway native module is unavailable. Rebuild the application after installing the SDK.",
    { cause },
  );
}

export function abortError(): Error {
  if (typeof DOMException === "function") return new DOMException("The operation was aborted.", "AbortError");
  const error = new Error("The operation was aborted.");
  error.name = "AbortError";
  return error;
}

function isAbortError(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const code = firstString(value.code, value.name);
  return code === "cancelled" || code === "E_ABORTED" || code === "AbortError";
}

function safeMessage(value: string | undefined): string {
  if (value === undefined || value.length === 0) return "The Latchway native operation failed.";
  const bounded = value.replace(/\p{Cc}/gu, " ").slice(0, 512);
  if (/eyJ|lwa_|lws_|refresh.?token|identity.?token|integrity.?token|[A-Za-z0-9_-]{64,}/iu.test(bounded)) {
    return "Sensitive native error detail was redacted.";
  }
  return bounded;
}

function safeStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? value as number
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function presentValues(
  record: Record<string, unknown>,
  userInfo: Record<string, unknown>,
  keys: readonly string[],
): unknown[] {
  const values: unknown[] = [];
  for (const source of [record, userInfo]) {
    for (const key of keys) {
      const candidate = source[key];
      if (Object.hasOwn(source, key) && candidate !== undefined && candidate !== null) values.push(candidate);
    }
  }
  return values;
}

function isCanonicalOperationID(value: unknown): value is string {
  return typeof value === "string" && /^arq_[0-7][0-9A-HJKMNPQRSTVWXYZ]{25}$/u.test(value);
}

function isNativeErrorCode(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,62}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
