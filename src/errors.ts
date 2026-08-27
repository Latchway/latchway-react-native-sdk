import { LatchwayError } from "@latchway/client";
import type { LatchwayErrorCode } from "@latchway/client";

const knownCodes = new Set<LatchwayErrorCode>([
  "request_invalid", "identity_token_missing", "identity_token_invalid", "identity_token_expired",
  "identity_reauthentication_required", "attestation_required", "attestation_unsupported",
  "attestation_invalid", "attestation_stale", "attestation_step_up_required", "dpop_missing",
  "dpop_invalid", "dpop_replayed", "dpop_nonce_required", "session_expired", "session_revoked",
  "refresh_token_reused", "installation_revoked", "feature_not_found", "feature_not_allowed",
  "model_not_allowed", "quota_exceeded", "concurrency_exceeded", "output_limit_exceeded",
  "pricing_unavailable", "route_not_found", "upstream_unavailable", "upstream_timeout",
  "upstream_protocol_error", "configuration_invalid", "server_not_ready",
  "protocol_version_unsupported", "authentication_required", "permission_denied", "resource_not_found",
  "conflict", "etag_required", "etag_mismatch", "bootstrap_disabled", "rate_limited", "internal_error",
  "client_configuration_invalid", "storage_unavailable", "crypto_unavailable",
  "attestation_provider_missing", "protocol_response_invalid", "request_not_replayable", "network_error",
]);

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
  if (isAbortError(value)) return abortError();
  const record = isRecord(value) ? value : {};
  const userInfo = isRecord(record.userInfo) ? record.userInfo : {};
  const rawCode = firstString(record.code, userInfo.code);
  const mapped = rawCode === undefined
    ? "internal_error"
    : localCodeMap[rawCode] ?? (knownCodes.has(rawCode as LatchwayErrorCode)
      ? rawCode as LatchwayErrorCode
      : "internal_error");
  const requestID = canonicalRequestID(firstString(record.requestID, record.request_id, userInfo.requestID, userInfo.request_id));
  const status = safeStatus(record.status ?? userInfo.status);
  const retryable = record.retryable === true || userInfo.retryable === true;
  return new LatchwayError(mapped, safeMessage(firstString(record.message, userInfo.message)), {
    requestID,
    status,
    retryable,
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

function canonicalRequestID(value: string | undefined): string | undefined {
  return value !== undefined && /^[A-Za-z0-9_-]{8,128}$/u.test(value) ? value : undefined;
}

function safeStatus(value: unknown): number | undefined {
  return Number.isInteger(value) && (value as number) >= 100 && (value as number) <= 599
    ? value as number
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
