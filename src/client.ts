import { LatchwayError } from "@latchway/client";
import { ReadableStream as PonyfillReadableStream } from "web-streams-polyfill";
import type { RuntimeConfiguration } from "./config.js";
import { acquire, type NativeLease } from "./coordinator.js";
import { abortError, fromNativeError } from "./errors.js";
import { assertNoCredentialFields } from "./native-output.js";
import type {
  LatchwayClient,
  LatchwayFetch,
  LatchwayFetchInit,
  QuotaLimit,
  QuotaSnapshot,
  ReactNativeDiagnostics,
} from "./types.js";
import { CONTRACT_VERSION, PROTOCOL_VERSION, SDK_VERSION } from "./version.js";

const MAXIMUM_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const MAXIMUM_NATIVE_REQUEST_BYTES = 12 * 1024 * 1024;
const MAXIMUM_RESPONSE_CHUNK_BYTES = 32 * 1024;
const MAXIMUM_HEADERS = 128;
const MAXIMUM_HEADER_BYTES = 128 * 1024;

const allowedDataPlanePaths = new Set([
  "/v1/responses",
  "/v1/chat/completions",
  "/v1/embeddings",
  "/v1/messages",
]);

const opaqueDataPlaneMethods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

const forbiddenCredentialHeaders = new Set([
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
  "connection",
  "content-length",
  "expect",
  "host",
  "key",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "token",
  "upgrade",
  "x-amz-credential",
  "x-amz-security-token",
  "x-amz-signature",
  "x-goog-credential",
  "x-goog-signature",
  "dpop",
  "dpop-nonce",
  "x-latchway-feature",
  "x-latchway-framework",
  "x-latchway-framework-version",
  "x-latchway-protocol-version",
  "x-latchway-request-id",
  "x-latchway-sdk",
  "x-latchway-sdk-version",
]);

const forbiddenCredentialQueryNames = new Set([
  ...forbiddenCredentialHeaders,
  "refresh_token",
  "identity_token",
  "private_key",
  "client_data_hash",
  "request_hash",
  "integrity_token",
]);

const forbiddenCredentialNameFragments = [
  "authorization",
  "dpop",
  "apikey",
  "accesstoken",
  "authtoken",
  "refreshtoken",
  "identitytoken",
  "integritytoken",
  "sessiontoken",
  "privatekey",
  "clientsecret",
  "credential",
  "attestationevidence",
  "clientdatahash",
  "requesthash",
  "xamzsignature",
  "xgoogsignature",
] as const;

const forbiddenExactCredentialNames = new Set([
  "key", "token", "secret", "bearer", "cookie", "password", "passwd",
]);

const safeResponseHeaderNames = new Set([
  "accept-ranges",
  "age",
  "cache-control",
  "content-encoding",
  "content-language",
  "content-length",
  "content-range",
  "content-type",
  "date",
  "etag",
  "expires",
  "last-modified",
  "request-id",
  "retry-after",
  "server-timing",
  "vary",
  "x-request-id",
  "x-latchway-operation-id",
  "x-latchway-request-id",
  "x-latchway-server-version",
]);

const nativeControlledHeaders = new Set([
  "x-latchway-feature",
  "x-latchway-framework",
  "x-latchway-framework-version",
  "x-latchway-protocol-version",
  "x-latchway-request-id",
  "x-latchway-sdk",
  "x-latchway-sdk-version",
]);

interface NativeResponseMetadata {
  responseID: string;
  status: number;
  statusText: string;
  headers: Array<[string, string]>;
}

interface NativeResponseChunk {
  done: boolean;
  chunk?: Uint8Array;
}

let nextOperationID = 1;

export class DefaultLatchwayClient implements LatchwayClient {
  readonly gatewayURL: string;
  readonly ready: Promise<void>;
  private readonly lease: Promise<NativeLease>;
  private disposed = false;

  constructor(private readonly config: RuntimeConfiguration) {
    this.gatewayURL = config.baseURL.origin;
    this.lease = acquire(config);
    this.ready = this.lease.then(async (lease) => { await lease.ready; });
  }

  async fetch(input: RequestInfo | URL, init: LatchwayFetchInit = {}): Promise<Response> {
    this.assertActive();
    const { latchwayFeature, ...requestInit } = init;
    const bodyExpected = requestBodyExpected(input, requestInit);
    const request = this.createRequest(input, requestInit);
    const feature = latchwayFeature ?? request.headers.get("X-Latchway-Feature") ?? undefined;
    assertFeature(feature);
    this.assertGatewayTarget(request.url, request.method, feature);
    if (request.bodyUsed) {
      throw new LatchwayError("request_not_replayable", "The request body has already been consumed.");
    }

    const lease = await this.lease;
    await lease.ready;
    const signal = request.signal;
    const headers = sanitizedRequestHeaders(request.headers);
    const bodyBase64 = await encodedRequestBody(request, signal, bodyExpected);
    const requestJSON = JSON.stringify({
      url: request.url,
      method: request.method.toUpperCase(),
      feature,
      headers,
      bodyBase64,
    });
    if (new TextEncoder().encode(requestJSON).byteLength > MAXIMUM_NATIVE_REQUEST_BYTES) {
      throw new LatchwayError("request_invalid", "The Latchway request exceeds the native bridge limit.");
    }

    const operationID = makeOperationID();
    const identityToken = await token(this.config.getIdentityToken, signal);
    const start = lease.module.startRequest(lease.clientID, operationID, identityToken, requestJSON);
    const observedStart = start.then(async (value) => {
      if (signal.aborted) {
        const responseID = recoverResponseID(value);
        if (responseID !== undefined) await ignoreFailure(lease.module.closeResponse(lease.clientID, responseID));
      }
      return value;
    });
    const encoded = await abortable(
      observedStart,
      signal,
      () => { lease.module.cancel(lease.clientID, operationID); },
    );
    let metadata: NativeResponseMetadata;
    try {
      metadata = parseResponseMetadata(encoded);
    } catch (cause) {
      const responseID = recoverResponseID(encoded);
      if (responseID !== undefined) await ignoreFailure(lease.module.closeResponse(lease.clientID, responseID));
      throw cause;
    }
    if (signal.aborted) {
      await ignoreFailure(lease.module.closeResponse(lease.clientID, metadata.responseID));
      throw abortError();
    }

    const hasBody = request.method.toUpperCase() !== "HEAD" &&
      metadata.status !== 204 && metadata.status !== 205 && metadata.status !== 304;
    const body = hasBody ? nativeResponseBody(lease, metadata.responseID, signal) : null;
    if (!hasBody) await ignoreFailure(lease.module.closeResponse(lease.clientID, metadata.responseID));
    return responseWithNativeBody(body, {
      status: metadata.status,
      statusText: metadata.statusText,
      headers: metadata.headers,
    });
  }

  fetchFor(feature: string): LatchwayFetch {
    this.assertActive();
    assertFeature(feature);
    return async (input, init = {}) => aliasFrameworkRequestID(
      await this.fetch(input, { ...init, latchwayFeature: feature }),
    );
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

  async refresh(): Promise<void> {
    this.assertActive();
    await this.nativeVoid("refresh");
  }

  async revokeCurrentInstallation(): Promise<void> {
    this.assertActive();
    await this.nativeVoid("revoke");
  }

  async revokeCurrentInstallationFamily(): Promise<void> {
    this.assertActive();
    await this.nativeVoid("revokeFamily");
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const lease = await this.lease;
    await lease.release();
  }

  private async nativeString(
    method: "quota" | "diagnostics",
    signal?: AbortSignal,
    argument?: string,
  ): Promise<string> {
    const lease = await this.lease;
    await lease.ready;
    const operationID = makeOperationID();
    const identityToken = await token(this.config.getIdentityToken, signal);
    const operation = method === "quota"
      ? lease.module.quota(lease.clientID, operationID, identityToken, argument ?? "")
      : lease.module.diagnostics(lease.clientID, operationID, identityToken);
    return abortable(operation, signal, () => { lease.module.cancel(lease.clientID, operationID); });
  }

  private async nativeVoid(method: "refresh" | "revoke" | "revokeFamily", signal?: AbortSignal): Promise<void> {
    const lease = await this.lease;
    await lease.ready;
    const operationID = makeOperationID();
    const identityToken = await token(this.config.getIdentityToken, signal);
    const operation = method === "refresh"
      ? lease.module.refresh(lease.clientID, operationID, identityToken)
      : method === "revoke"
        ? lease.module.revoke(lease.clientID, operationID, identityToken)
        : lease.module.revokeFamily(lease.clientID, operationID, identityToken);
    await abortable(operation, signal, () => { lease.module.cancel(lease.clientID, operationID); });
  }

  private createRequest(input: RequestInfo | URL, init: RequestInit): Request {
    if (input instanceof Request && Reflect.ownKeys(init).length === 0) return input;
    if (input instanceof Request) return new Request(input, init);
    const resolved = input instanceof URL ? input : new URL(input, this.config.baseURL);
    return new Request(resolved, init);
  }

  private assertGatewayTarget(input: string, method: string, feature: string): void {
    const target = new URL(input);
    const pathname = policyPathname(input, target);
    if (target.origin !== this.config.baseURL.origin || target.hash !== "") {
      throw new LatchwayError(
        "client_configuration_invalid",
        "Latchway only dispatches requests to the configured gateway origin.",
      );
    }
    if (!isAllowedDataPlaneTarget(target, pathname, method, feature)) {
      throw new LatchwayError(
        "transport_destination_not_allowed",
        "Latchway only authorizes methods and paths declared by the client contract.",
      );
    }
    target.searchParams.forEach((_value, name) => {
      if (isForbiddenCredentialName(decodedCredentialName(name))) {
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

/**
 * Provider SDKs conventionally read `X-Request-ID`. Preserve Latchway's
 * canonical header and add the alias without consuming or buffering the body.
 */
function aliasFrameworkRequestID(response: Response): Response {
  const requestID = response.headers.get("X-Latchway-Request-ID");
  if (requestID === null || response.headers.get("X-Request-ID") === requestID) return response;
  response.headers.set("X-Request-ID", requestID);
  return response;
}

function responseWithNativeBody(body: ReadableStream<Uint8Array> | null, init: ResponseInit): Response {
  let response: Response;
  try {
    response = new Response(body, init);
  } catch {
    // Some React Native Response implementations reject ponyfill streams even
    // though the instance body is attached below and consumed directly.
    response = new Response(null, init);
  }
  if (body === null) return response;
  const exposed = (response as Response & { body?: ReadableStream<Uint8Array> | null }).body;
  if (exposed !== undefined && exposed !== null && typeof exposed.getReader === "function") {
    return response;
  }
  // React Native 0.82's built-in Response accepts the stream but does not
  // expose it through `body`. Restore the exact native-owned pull stream on
  // the instance; no bytes are buffered and the native cancel/close lifecycle
  // remains authoritative.
  Object.defineProperty(response, "body", {
    configurable: true,
    enumerable: true,
    value: body,
  });
  return response;
}

function policyPathname(input: string, target: URL): string {
  // React Native's built-in URL polyfill appends `/` when an absolute URL has
  // no query or fragment. Request.url is already serialized at this point, so
  // recognize only that exact mutation instead of broadening the route set to
  // accept genuinely trailing-slash destinations.
  if (target.pathname.length > 1 && !input.includes("?") && !input.includes("#") &&
      !input.endsWith("/") && target.href === `${input}/`) {
    return target.pathname.slice(0, -1);
  }
  return target.pathname;
}

function isAllowedDataPlaneTarget(
  target: URL,
  pathname: string,
  method: string,
  feature: string,
): boolean {
  const normalizedMethod = method.toUpperCase();
  if (normalizedMethod === "POST" && allowedDataPlanePaths.has(pathname)) return true;

  const prefix = `/proxy/${encodeURIComponent(feature)}/`;
  if (!opaqueDataPlaneMethods.has(normalizedMethod) || target.search !== "" ||
      !pathname.startsWith(prefix)) return false;
  const remaining = pathname.slice(prefix.length);
  const lowerRemaining = remaining.toLowerCase();
  return remaining.length >= 1 && remaining.length <= 2_048 &&
    remaining.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..") &&
    !lowerRemaining.includes("%2e") && !lowerRemaining.includes("%2f") &&
    !lowerRemaining.includes("%5c") && !remaining.includes("\\") &&
    !lowerRemaining.startsWith("http:") && !lowerRemaining.startsWith("https:");
}

function sanitizedRequestHeaders(source: Headers): Array<[string, string]> {
  const result: Array<[string, string]> = [];
  let size = 0;
  source.forEach((value, name) => {
    const normalized = name.toLowerCase();
    if (nativeControlledHeaders.has(normalized)) return;
    if (isForbiddenCredentialName(normalized)) return;
    if (!isHeaderName(normalized) || !isHeaderValue(value)) {
      throw new LatchwayError("request_invalid", "The request contains an invalid header.");
    }
    size += normalized.length + value.length;
    if (result.length >= MAXIMUM_HEADERS || size > MAXIMUM_HEADER_BYTES) {
      throw new LatchwayError("request_invalid", "The request headers exceed the native bridge limit.");
    }
    result.push([normalized, value]);
  });
  return result;
}

function requestBodyExpected(input: RequestInfo | URL, init: RequestInit): boolean {
  if (Object.prototype.hasOwnProperty.call(init, "body")) return init.body !== null && init.body !== undefined;
  if (!(input instanceof Request)) return false;
  const body = (input as Request & { body?: ReadableStream<Uint8Array> | null }).body;
  if (body !== null && body !== undefined) return true;
  return (input as Request & { _bodyInit?: unknown })._bodyInit !== null &&
    (input as Request & { _bodyInit?: unknown })._bodyInit !== undefined;
}

async function encodedRequestBody(
  request: Request,
  signal: AbortSignal,
  bodyExpected: boolean,
): Promise<string | null> {
  const body = (request as Request & { body?: ReadableStream<Uint8Array> | null }).body;
  if (body === null || (body === undefined && !bodyExpected)) return null;
  if (body === undefined || typeof body.getReader !== "function") {
    try {
      const encoded = await abortable(request.arrayBuffer(), signal, () => {});
      const bytes = new Uint8Array(encoded);
      if (bytes.byteLength > MAXIMUM_REQUEST_BODY_BYTES) {
        throw new LatchwayError("request_invalid", "The request body exceeds the 8 MiB native transport limit.");
      }
      return bytesToBase64(bytes);
    } catch (cause) {
      if (cause instanceof LatchwayError || isAbort(cause)) throw cause;
      throw new LatchwayError("request_not_replayable", "The request body could not be read for native dispatch.", { cause });
    }
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const result = await readWithAbort(reader, signal);
      if (result.done) break;
      size += result.value.byteLength;
      if (size > MAXIMUM_REQUEST_BODY_BYTES) {
        await reader.cancel("Latchway request body limit exceeded");
        throw new LatchwayError("request_invalid", "The request body exceeds the 8 MiB native transport limit.");
      }
      chunks.push(result.value);
    }
  } catch (cause) {
    if (cause instanceof LatchwayError || isAbort(cause)) throw cause;
    throw new LatchwayError("request_not_replayable", "The request body could not be read for native dispatch.", { cause });
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytesToBase64(bytes);
}

async function readWithAbort(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  if (signal.aborted) {
    void reader.cancel();
    throw abortError();
  }
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => {
      void reader.cancel();
      reject(abortError());
    };
    signal.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([reader.read(), aborted]); }
  finally { if (listener !== undefined) signal.removeEventListener("abort", listener); }
}

function nativeResponseBody(lease: NativeLease, responseID: string, signal: AbortSignal): ReadableStream<Uint8Array> {
  let finished = false;
  let nativeClosed = false;
  let activeOperationID: string | undefined;
  let abortListener: (() => void) | undefined;

  const closeNative = async (): Promise<void> => {
    if (nativeClosed) return;
    nativeClosed = true;
    await ignoreFailure(lease.module.closeResponse(lease.clientID, responseID));
  };
  const finish = (): void => {
    if (finished) return;
    finished = true;
    if (abortListener !== undefined) signal.removeEventListener("abort", abortListener);
  };

  const ReadableStreamConstructor = typeof globalThis.ReadableStream === "function"
    ? globalThis.ReadableStream
    : PonyfillReadableStream as unknown as typeof globalThis.ReadableStream;
  return new ReadableStreamConstructor<Uint8Array>({
    start(controller) {
      abortListener = () => {
        if (finished) return;
        finish();
        void closeNative();
        controller.error(abortError());
      };
      signal.addEventListener("abort", abortListener, { once: true });
    },
    async pull(controller) {
      if (finished) return;
      if (signal.aborted) {
        finish();
        await closeNative();
        controller.error(abortError());
        return;
      }
      const operationID = makeOperationID();
      activeOperationID = operationID;
      try {
        const encoded = await abortable(
          lease.module.readResponseChunk(
            lease.clientID,
            operationID,
            responseID,
            MAXIMUM_RESPONSE_CHUNK_BYTES,
          ),
          signal,
          () => { lease.module.cancel(lease.clientID, operationID); },
        );
        const chunk = parseResponseChunk(encoded);
        if (chunk.done) {
          finish();
          controller.close();
          await closeNative();
        } else if (chunk.chunk !== undefined) {
          controller.enqueue(chunk.chunk);
        }
      } catch (cause) {
        if (!finished) {
          finish();
          controller.error(isAbort(cause) ? abortError() : cause);
        }
        await closeNative();
      } finally {
        if (activeOperationID === operationID) activeOperationID = undefined;
      }
    },
    async cancel() {
      finish();
      if (activeOperationID !== undefined) lease.module.cancel(lease.clientID, activeOperationID);
      await closeNative();
    },
  }, { highWaterMark: 0 });
}

function parseResponseMetadata(encoded: string): NativeResponseMetadata {
  const value = parseRecord(encoded, "native response metadata");
  assertNoCredentialFields(value);
  if (!hasOnlyKeys(value, ["responseID", "status", "statusText", "headers"]) ||
      typeof value.responseID !== "string" || !/^rsp_[A-Za-z0-9_-]{16,96}$/u.test(value.responseID) ||
      !Number.isInteger(value.status) || (value.status as number) < 200 || (value.status as number) > 599 ||
      typeof value.statusText !== "string" || value.statusText.length > 128 || /\p{Cc}/u.test(value.statusText) ||
      !Array.isArray(value.headers) || value.headers.length > MAXIMUM_HEADERS) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native response metadata.");
  }
  const headers: Array<[string, string]> = [];
  let headerBytes = 0;
  for (const header of value.headers) {
    if (!Array.isArray(header) || header.length !== 2 || typeof header[0] !== "string" ||
        typeof header[1] !== "string") {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native response headers.");
    }
    const name = header[0].toLowerCase();
    const headerValue = header[1];
    if (!isSafeResponseHeader(name) || !isHeaderValue(headerValue)) {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned unsafe native response headers.");
    }
    headerBytes += name.length + headerValue.length;
    if (headerBytes > MAXIMUM_HEADER_BYTES) {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned oversized native response headers.");
    }
    headers.push([name, headerValue]);
  }
  return {
    responseID: value.responseID,
    status: value.status as number,
    statusText: value.statusText,
    headers,
  };
}

function parseResponseChunk(encoded: string): NativeResponseChunk {
  if (encoded.length > MAXIMUM_RESPONSE_CHUNK_BYTES * 2) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned an oversized native response chunk.");
  }
  const value = parseRecord(encoded, "native response chunk");
  assertNoCredentialFields(value);
  if (!hasOnlyKeys(value, ["done", "chunk"]) || typeof value.done !== "boolean") {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid native response chunk.");
  }
  if (value.done) {
    if (value.chunk !== undefined && value.chunk !== null) {
      throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid final native response chunk.");
    }
    return { done: true };
  }
  if (typeof value.chunk !== "string") {
    throw new LatchwayError("protocol_response_invalid", "Latchway omitted native response bytes.");
  }
  const chunk = base64ToBytes(value.chunk);
  if (chunk.byteLength === 0 || chunk.byteLength > MAXIMUM_RESPONSE_CHUNK_BYTES) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native response bytes.");
  }
  return { done: false, chunk };
}

function parseQuota(encoded: string, expectedFeature: string): QuotaSnapshot {
  const value = parseRecord(encoded, "quota snapshot");
  assertNoCredentialFields(value);
  if (!hasOnlyKeys(value, ["feature", "observed_at", "limits"]) ||
      value.feature !== expectedFeature || typeof value.observed_at !== "string" || !Array.isArray(value.limits)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid quota snapshot.");
  }
  const limits: QuotaLimit[] = value.limits.map((item) => {
    if (!isRecord(item) ||
        !hasOnlyKeys(item, ["metric", "maximum", "used", "reserved", "remaining", "resets_at", "hard"]) ||
        typeof item.metric !== "string" || typeof item.hard !== "boolean") {
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
  assertNoCredentialFields(value);
  if (!hasOnlyKeys(value, [
    "contractVersion", "protocolVersion", "keyStorage", "attestation", "session", "installation", "server",
    "lastErrorCode",
  ]) || value.contractVersion !== CONTRACT_VERSION || value.protocolVersion !== PROTOCOL_VERSION ||
      typeof value.keyStorage !== "string" || !isRecord(value.attestation) || !isRecord(value.session) ||
      !isRecord(value.installation) || !isRecord(value.server)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned invalid native diagnostics.");
  }
  if (!hasOnlyKeys(value.attestation, ["support", "provider", "trustLevel", "lastOperation"]) ||
      !hasOnlyKeys(value.session, ["state", "expiresAt", "refreshAvailable"]) ||
      !hasOnlyKeys(value.installation, ["id", "status"]) ||
      !hasOnlyKeys(value.server, ["version", "lastRequestID"])) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned unexpected native diagnostics.");
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
  if (value === undefined || !validIdentifier(value)) {
    throw new LatchwayError("client_configuration_invalid", "A valid latchwayFeature is required.");
  }
}

function validIdentifier(value: string): boolean {
  return /^[a-z][a-z0-9_-]{0,62}$/u.test(value);
}

function parseRecord(encoded: string, label: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(encoded);
    if (isRecord(value)) return value;
  } catch {
    // Native output is intentionally not reflected into the safe error.
  }
  throw new LatchwayError("protocol_response_invalid", `Latchway returned invalid ${label}.`);
}

function hasOnlyKeys(value: Record<string, unknown>, names: readonly string[]): boolean {
  const expected = new Set(names);
  return Object.keys(value).every((name) => expected.has(name));
}

function isSafeResponseHeader(name: string): boolean {
  return safeResponseHeaderNames.has(name) || name.startsWith("x-ratelimit-") || name.startsWith("ratelimit-");
}

function recoverResponseID(encoded: string): string | undefined {
  if (encoded.length > 256 * 1024) return undefined;
  try {
    const value: unknown = JSON.parse(encoded);
    if (isRecord(value) && typeof value.responseID === "string" && /^rsp_[A-Za-z0-9_-]{16,96}$/u.test(value.responseID)) {
      return value.responseID;
    }
  } catch {
    // Invalid output has no safely recoverable response handle.
  }
  return undefined;
}

function isHeaderName(value: string): boolean {
  return /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u.test(value);
}

function isHeaderValue(value: string): boolean {
  if (value.length > 8_192) return false;
  for (const character of value) {
    const scalar = character.codePointAt(0) ?? 0;
    if (scalar <= 0x08 || (scalar >= 0x0a && scalar <= 0x1f) || scalar === 0x7f) return false;
  }
  return true;
}

function decodedCredentialName(value: string): string {
  let decoded = value;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      break;
    }
  }
  // Fail closed on deeper nested escapes instead of letting an attacker move a
  // credential name past the bounded decoder with another layer of `%25`.
  if (/%[0-9A-Fa-f]{2}/u.test(decoded)) return "credential-encoded-name";
  return decoded.toLowerCase();
}

function isForbiddenCredentialName(value: string): boolean {
  const normalized = value.toLowerCase();
  if (forbiddenCredentialHeaders.has(normalized) || forbiddenCredentialQueryNames.has(normalized)) return true;
  const compact = normalized.replace(/[^a-z0-9]/gu, "");
  return forbiddenExactCredentialNames.has(compact) ||
    forbiddenCredentialNameFragments.some((fragment) => compact.includes(fragment));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 16_384) {
    const end = Math.min(offset + 16_384, bytes.length);
    for (let index = offset; index < end; index += 1) binary += String.fromCharCode(bytes[index] ?? 0);
  }
  return btoa(binary);
}

function base64ToBytes(encoded: string): Uint8Array {
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned malformed native response bytes.");
  }
  let binary: string;
  try { binary = atob(encoded); } catch {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned malformed native response bytes.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  if (bytesToBase64(bytes) !== encoded) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned non-canonical native response bytes.");
  }
  return bytes;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /\p{Cc}/u.test(value)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway returned an invalid native diagnostic value.");
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAbort(value: unknown): boolean {
  return value instanceof Error && value.name === "AbortError";
}

async function ignoreFailure(operation: Promise<void>): Promise<void> {
  try { await operation; } catch { /* cleanup is idempotent and best-effort */ }
}
