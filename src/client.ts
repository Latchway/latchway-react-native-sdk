import { LatchwayError } from "@latchway/client";
import type { LatchwayErrorCode } from "@latchway/client";
import type { RuntimeConfiguration } from "./config.js";
import { acquire, type NativeLease } from "./coordinator.js";
import { abortError, fromNativeError } from "./errors.js";
import type {
  LatchwayClient,
  LatchwayFetchInit,
  QuotaLimit,
  QuotaSnapshot,
  ReactNativeDiagnostics,
} from "./types.js";
import { isCanonicalRequestID } from "./request-id.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_KIND, SDK_VERSION } from "./version.js";

const forbiddenCredentialHeaders = [
  "authorization",
  "proxy-authorization",
  "api-key",
  "api_key",
  "apikey",
  "x-api-key",
  "openai-api-key",
  "openai_api_key",
  "x-openai-api-key",
  "anthropic-api-key",
  "anthropic_api_key",
  "x-goog-api-key",
  "x-goog_api_key",
  "access_token",
  "auth_token",
  "x-auth-token",
  "cookie",
  "key",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
  "dpop",
  "x-latchway-feature",
  "x-latchway-protocol-version",
  "x-latchway-request-id",
  "x-latchway-sdk",
  "x-latchway-sdk-version",
];

const forbiddenCredentialQueryNames = new Set([
  "authorization",
  "proxy-authorization",
  "access_token",
  "api-key",
  "api_key",
  "apikey",
  "x-api-key",
  "openai-api-key",
  "openai_api_key",
  "x-openai-api-key",
  "anthropic-api-key",
  "anthropic_api_key",
  "x-goog-api-key",
  "x-goog_api_key",
  "auth_token",
  "x-auth-token",
  "cookie",
  "key",
  "token",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
]);

const preDispatchProblems = {
  dpop_nonce_required: {
    title: "DPoP nonce required",
    detail: "A fresh server DPoP nonce is required.",
  },
  session_expired: {
    title: "Session expired",
    detail: "The Latchway session is expired.",
  },
} as const;

const preDispatchProblemFields = [
  "type",
  "title",
  "status",
  "detail",
  "code",
  "request_id",
  "retryable",
] as const;

type PreDispatchProblemCode = keyof typeof preDispatchProblems;
type VerifiedPreDispatchRejection =
  | Readonly<{ code: "dpop_nonce_required"; nonce: string }>
  | Readonly<{ code: "session_expired" }>;

interface NativeAuthorization {
  authorization: string;
  dpop: string;
  requestID: string;
}

let nextOperationID = 1;

export class DefaultLatchwayClient implements LatchwayClient {
  readonly ready: Promise<void>;
  private readonly lease: Promise<NativeLease>;
  private disposed = false;

  constructor(private readonly config: RuntimeConfiguration) {
    this.lease = acquire(config);
    this.ready = this.lease.then(async (lease) => { await lease.ready; });
  }

  async fetch(input: RequestInfo | URL, init: LatchwayFetchInit = {}): Promise<Response> {
    this.assertActive();
    const { latchwayFeature, ...requestInit } = init;
    const request = this.createRequest(input, requestInit);
    const feature = latchwayFeature ?? request.headers.get("X-Latchway-Feature") ?? undefined;
    assertFeature(feature);
    this.assertGatewayTarget(request.url);
    if (request.bodyUsed) {
      throw new LatchwayError("request_not_replayable", "The request body has already been consumed.");
    }
    const safeToRetry = canSafelyRetry(request);
    const signal = request.signal;
    // A body-bearing Request must not be cloned: cloning tees its stream and can
    // buffer an unconsumed branch. Only bodyless requests need a retry template.
    const template = safeToRetry ? this.sanitize(request) : undefined;
    let nonce: string | undefined;
    let preservedRequestID: string | undefined;
    let sessionRetried = false;
    let nonceRetried = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const candidate = template === undefined ? request : template.clone();
      const outbound = await this.authorizeWithNonce(candidate, feature, nonce, preservedRequestID, signal);
      let response: Response;
      try {
        response = await this.config.fetch(outbound);
      } catch (cause) {
        if (outbound.signal.aborted) throw abortError();
        throw new LatchwayError("network_error", "The authorized Latchway request failed.", {
          retryable: true,
          cause,
        });
      }
      if (!safeToRetry || response.status !== 401 || !isLatchwayProblem(response)) return response;
      const rejection = await verifiedPreDispatchRejection(response);
      if (rejection === undefined) return response;
      if (!nonceRetried && rejection.code === "dpop_nonce_required") {
        await response.body?.cancel();
        preservedRequestID = outbound.headers.get("X-Latchway-Request-ID") ?? undefined;
        nonce = rejection.nonce;
        nonceRetried = true;
        continue;
      }
      if (!sessionRetried && rejection.code === "session_expired") {
        await response.body?.cancel();
        preservedRequestID = outbound.headers.get("X-Latchway-Request-ID") ?? undefined;
        await this.nativeVoid("refresh", signal);
        sessionRetried = true;
        continue;
      }
      return response;
    }
    throw new LatchwayError("protocol_response_invalid", "Latchway exhausted the safe request retry path.");
  }

  async authorize(request: Request, feature: string): Promise<Request> {
    return this.authorizeWithNonce(request, feature, undefined, undefined);
  }

  async quota(feature: string): Promise<QuotaSnapshot> {
    this.assertActive();
    assertFeature(feature);
    const encoded = await this.nativeString("quota", undefined, feature);
    return parseQuota(encoded, feature);
  }

  async diagnostics(): Promise<ReactNativeDiagnostics> {
    this.assertActive();
    const lease = await this.lease;
    const compatibility = await lease.ready;
    const encoded = await this.nativeString("diagnostics");
    return parseDiagnostics(encoded, compatibility.platform, compatibility.nativeSDKVersion);
  }

  async revokeCurrentInstallation(): Promise<void> {
    this.assertActive();
    await this.nativeVoid("revoke");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const lease = await this.lease;
    await lease.release();
  }

  private async authorizeWithNonce(
    request: Request,
    feature: string,
    nonce: string | undefined,
    preservedRequestID: string | undefined,
    signal: AbortSignal = request.signal,
  ): Promise<Request> {
    this.assertActive();
    assertFeature(feature);
    this.assertGatewayTarget(request.url);
    if (request.bodyUsed) {
      throw new LatchwayError("request_not_replayable", "The request body has already been consumed.");
    }
    const sanitized = this.sanitize(request);
    const encoded = await this.nativeString("authorize", signal, JSON.stringify({
      url: request.url,
      method: request.method.toUpperCase(),
      feature,
      nonce: nonce ?? null,
      requestID: preservedRequestID ?? null,
    }));
    const authorization = parseAuthorization(encoded);
    const headers = new Headers(sanitized.headers);
    headers.set("Authorization", authorization.authorization);
    headers.set("DPoP", authorization.dpop);
    headers.set("X-Latchway-Feature", feature);
    headers.set("X-Latchway-Protocol-Version", String(PROTOCOL_VERSION));
    headers.set("X-Latchway-SDK", SDK_KIND);
    headers.set("X-Latchway-SDK-Version", SDK_VERSION);
    headers.set("X-Latchway-Request-ID", authorization.requestID);
    return new Request(sanitized, {
      headers,
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
    });
  }

  private async nativeString(
    method: "authorize" | "quota" | "diagnostics",
    signal?: AbortSignal,
    argument?: string,
  ): Promise<string> {
    const lease = await this.lease;
    await lease.ready;
    const operationID = makeOperationID();
    const identityToken = await token(this.config.getIdentityToken, signal);
    let operation: Promise<string>;
    if (method === "authorize") {
      operation = lease.module.authorize(lease.clientID, operationID, identityToken, argument ?? "");
    } else if (method === "quota") {
      operation = lease.module.quota(lease.clientID, operationID, identityToken, argument ?? "");
    } else {
      operation = lease.module.diagnostics(lease.clientID, operationID, identityToken);
    }
    return abortable(operation, signal, () => { lease.module.cancel(lease.clientID, operationID); });
  }

  private async nativeVoid(method: "refresh" | "revoke", signal?: AbortSignal): Promise<void> {
    const lease = await this.lease;
    await lease.ready;
    const operationID = makeOperationID();
    const identityToken = await token(this.config.getIdentityToken, signal);
    const operation = method === "refresh"
      ? lease.module.refresh(lease.clientID, operationID, identityToken)
      : lease.module.revoke(lease.clientID, operationID, identityToken);
    await abortable(operation, signal, () => { lease.module.cancel(lease.clientID, operationID); });
  }

  private createRequest(input: RequestInfo | URL, init: RequestInit): Request {
    if (input instanceof Request) return new Request(input, init);
    const resolved = input instanceof URL ? input : new URL(input, this.config.baseURL);
    return new Request(resolved, init);
  }

  private sanitize(request: Request): Request {
    const headers = new Headers(request.headers);
    for (const name of forbiddenCredentialHeaders) headers.delete(name);
    return new Request(request, { headers });
  }

  private assertGatewayTarget(input: string): void {
    const target = new URL(input);
    if (target.origin !== this.config.baseURL.origin) {
      throw new LatchwayError(
        "client_configuration_invalid",
        "Latchway only authorizes requests to the configured gateway origin.",
      );
    }
    target.searchParams.forEach((_value, name) => {
      if (forbiddenCredentialQueryNames.has(name.toLowerCase())) {
        throw new LatchwayError(
          "request_invalid",
          "Upstream provider credentials must not be supplied in the request URL.",
        );
      }
    });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new LatchwayError("client_configuration_invalid", "This Latchway client has been disposed.");
    }
  }
}

function parseAuthorization(encoded: string): NativeAuthorization {
  const value = parseRecord(encoded, "native authorization");
  if (typeof value.authorization !== "string" || !/^DPoP [\u0021-\u007e]{16,8192}$/u.test(value.authorization) ||
      typeof value.dpop !== "string" || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(value.dpop) ||
      !isCanonicalRequestID(value.requestID)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native authorization metadata.");
  }
  return value as unknown as NativeAuthorization;
}

function parseQuota(encoded: string, expectedFeature: string): QuotaSnapshot {
  const value = parseRecord(encoded, "quota snapshot");
  if (value.feature !== expectedFeature || typeof value.observed_at !== "string" || !Array.isArray(value.limits)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota snapshot.");
  }
  const limits: QuotaLimit[] = value.limits.map((item) => {
    if (!isRecord(item) || typeof item.metric !== "string" || typeof item.hard !== "boolean") {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota limit.");
    }
    for (const field of ["maximum", "used", "reserved", "remaining"] as const) {
      const counter = item[field];
      if (counter !== undefined && (!Number.isSafeInteger(counter) || (counter as number) < 0)) {
        throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota counter.");
      }
    }
    if (item.resets_at !== undefined && typeof item.resets_at !== "string") {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota reset time.");
    }
    return item as unknown as QuotaLimit;
  });
  return { feature: expectedFeature, observed_at: value.observed_at, limits };
}

function parseDiagnostics(
  encoded: string,
  platform: "react_native_ios" | "react_native_android",
  nativeSDKVersion: string,
): ReactNativeDiagnostics {
  const value = parseRecord(encoded, "diagnostics");
  if (value.contractVersion !== CONTRACT_VERSION || value.protocolVersion !== PROTOCOL_VERSION ||
      typeof value.keyStorage !== "string" || !isRecord(value.attestation) || !isRecord(value.session) ||
      !isRecord(value.installation) || !isRecord(value.server)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native diagnostics.");
  }
  const support = value.attestation.support;
  const state = value.session.state;
  if ((support !== "supported" && support !== "unsupported" && support !== "unknown") ||
      typeof state !== "string" ||
      !new Set(["absent", "establishing", "active", "refreshing", "expired", "revoked", "failed"]).has(state)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native diagnostic state.");
  }
  const provider = optionalString(value.attestation.provider);
  const trustLevel = optionalString(value.attestation.trustLevel);
  const lastOperation = optionalString(value.attestation.lastOperation);
  const expiresAt = optionalString(value.session.expiresAt);
  const installationID = optionalString(value.installation.id);
  const installationStatus = optionalString(value.installation.status);
  const serverVersion = optionalString(value.server.version);
  const lastRequestID = optionalString(value.server.lastRequestID);
  const lastErrorCode = optionalString(value.lastErrorCode);
  return {
    sdkVersion: SDK_VERSION,
    nativeSDKVersion,
    contractVersion: CONTRACT_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    platform,
    keyStorage: value.keyStorage,
    attestation: {
      support,
      ...(provider === undefined ? {} : { provider }),
      ...(trustLevel === undefined ? {} : { trustLevel }),
      ...(lastOperation === undefined ? {} : { lastOperation }),
    },
    session: {
      state: state as ReactNativeDiagnostics["session"]["state"],
      ...(expiresAt === undefined ? {} : { expiresAt }),
      ...(typeof value.session.refreshAvailable === "boolean" ? { refreshAvailable: value.session.refreshAvailable } : {}),
    },
    installation: {
      ...(installationID === undefined ? {} : { id: installationID }),
      ...(installationStatus === undefined ? {} : { status: installationStatus }),
    },
    server: {
      ...(serverVersion === undefined ? {} : { version: serverVersion }),
      ...(lastRequestID === undefined ? {} : { lastRequestID }),
    },
    ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
  };
}

async function token(provider: () => Promise<string>, signal?: AbortSignal): Promise<string> {
  let result: string;
  try {
    result = await abortable(Promise.resolve().then(provider), signal);
  } catch (cause) {
    if (isAbort(cause)) throw cause;
    throw new LatchwayError("identity_token_invalid", "The identity token provider failed.", { cause });
  }
  if (typeof result !== "string" || result.length === 0 || result.length > 65_536 || /\p{Cc}/u.test(result)) {
    throw new LatchwayError("identity_token_invalid", "The identity token provider returned an invalid token.");
  }
  return result;
}

async function abortable<T>(operation: Promise<T>, signal?: AbortSignal, cancel?: () => void): Promise<T> {
  if (signal === undefined) {
    try { return await operation; } catch (cause) { throw fromNativeError(cause); }
  }
  if (signal.aborted) {
    cancel?.();
    throw abortError();
  }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      cancel?.();
      reject(abortError());
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try {
    return await Promise.race([operation.catch((cause: unknown) => { throw fromNativeError(cause); }), aborted]);
  } finally {
    if (listener !== undefined) signal.removeEventListener("abort", listener);
  }
}

function makeOperationID(): string {
  return `op-${nextOperationID++}`;
}

function assertFeature(value: string | undefined): asserts value is string {
  if (value === undefined || !/^[a-z][a-z0-9_-]{0,62}$/u.test(value)) {
    throw new LatchwayError("client_configuration_invalid", "A valid latchwayFeature is required.");
  }
}

function canSafelyRetry(request: Request): boolean {
  return request.body === null && new Set(["GET", "HEAD", "OPTIONS"]).has(request.method.toUpperCase());
}

function isLatchwayProblem(response: Response): boolean {
  return response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase() === "application/problem+json";
}

async function verifiedPreDispatchRejection(
  response: Response,
): Promise<VerifiedPreDispatchRejection | undefined> {
  const responseRequestID = response.headers.get("X-Latchway-Request-ID");
  if (response.status !== 401 || responseRequestID === null ||
      !isCanonicalRequestID(responseRequestID)) return undefined;
  const problem = await boundedProblem(response);
  if (problem === undefined || !hasOnlyKeys(problem, preDispatchProblemFields) ||
      (problem.code !== "dpop_nonce_required" && problem.code !== "session_expired")) return undefined;
  const code: PreDispatchProblemCode = problem.code;
  const definition = preDispatchProblems[code];
  if (problem.type !== `https://latchway.dev/problems/${code}` || problem.title !== definition.title ||
      problem.status !== 401 || problem.status !== response.status || problem.detail !== definition.detail ||
      problem.request_id !== responseRequestID || problem.retryable !== true) return undefined;
  const suppliedNonce = response.headers.get("DPoP-Nonce");
  if (code === "dpop_nonce_required") {
    return isUsableDPoPNonce(suppliedNonce) ? { code, nonce: suppliedNonce } : undefined;
  }
  return suppliedNonce === null ? { code } : undefined;
}

async function boundedProblem(response: Response): Promise<Record<string, unknown> | undefined> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader();
    if (reader === undefined) return undefined;
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 65_536) {
        // Awaiting cancellation of one branch of a cloned/teed response can
        // wait forever for the untouched application branch to cancel too.
        // Initiate branch cancellation and return the original response.
        void reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(chunk.value);
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const encoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (!hasUniqueTopLevelMemberNames(encoded)) return undefined;
    const value: unknown = JSON.parse(encoded);
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  } finally {
    reader?.releaseLock();
  }
}

function parseRecord(encoded: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (isRecord(value)) return value;
  } catch {
    // Never include native payload text in an error.
  }
  throw new LatchwayError("protocol_response_invalid", `Latchway returned invalid ${label}.`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 512 ? value : undefined;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function hasUniqueTopLevelMemberNames(encoded: string): boolean {
  const names = new Set<string>();
  let index = skipJSONWhitespace(encoded, 0);
  if (encoded[index] !== "{") return false;
  index += 1;
  let depth = 1;
  let expectsName = true;
  while (index < encoded.length) {
    index = skipJSONWhitespace(encoded, index);
    const character = encoded[index];
    if (character === undefined) return false;
    if (depth === 1 && expectsName) {
      if (character === "}") return true;
      if (character !== '"') return false;
      const end = jsonStringEnd(encoded, index);
      if (end === undefined) return false;
      let name: unknown;
      try {
        name = JSON.parse(encoded.slice(index, end + 1));
      } catch {
        return false;
      }
      if (typeof name !== "string" || names.has(name)) return false;
      names.add(name);
      index = skipJSONWhitespace(encoded, end + 1);
      if (encoded[index] !== ":") return false;
      index += 1;
      expectsName = false;
      continue;
    }
    if (character === '"') {
      const end = jsonStringEnd(encoded, index);
      if (end === undefined) return false;
      index = end + 1;
      continue;
    }
    if (character === "{" || character === "[") {
      depth += 1;
    } else if (character === "}" || character === "]") {
      depth -= 1;
      if (depth === 0) return true;
    } else if (character === "," && depth === 1) {
      expectsName = true;
    }
    index += 1;
  }
  return false;
}

function jsonStringEnd(encoded: string, start: number): number | undefined {
  for (let index = start + 1; index < encoded.length; index += 1) {
    const character = encoded[index];
    if (character === '"') return index;
    if (character === "\\") index += 1;
  }
  return undefined;
}

function skipJSONWhitespace(encoded: string, start: number): number {
  let index = start;
  while (encoded[index] === " " || encoded[index] === "\t" ||
         encoded[index] === "\n" || encoded[index] === "\r") index += 1;
  return index;
}

function isUsableDPoPNonce(value: string | null): value is string {
  // Exclude spaces, control characters, commas (including joined duplicate
  // header values), and non-ASCII bytes from the one-use nonce input.
  return value !== null && /^[\u0021-\u002b\u002d-\u007e]{16,512}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

export type { LatchwayErrorCode };
