import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatchwayError } from "@latchway/client";
import { createLatchwayClient, errorFromResponse } from "../src/index.js";
import type { LatchwayClient } from "../src/types.js";
import { installNativeModuleForTesting } from "../src/testing.js";

interface ProtocolFixture {
  contract_version: string;
  wire_protocol: { current: number };
  sdk_kinds: string[];
}

interface DPoPFixture {
  vectors: Array<{ proof: string; expected: { valid: boolean } }>;
}

interface BindingFixture {
  vectors: Array<{ sha256_base64url: string }>;
}

const clients: LatchwayClient[] = [];
const ANDROID_REQUEST_ID = "android:550e8400-e29b-41d4-a716-446655440000";
const OPERATION_ID = "arq_0123456789ABCDEFGHJKMNPQRS";
let restoreNative: (() => void) | undefined;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => { await client.dispose(); }));
  restoreNative?.();
  restoreNative = undefined;
});

describe("React Native Latchway client", () => {
  it("authorizes exact-origin fetches and strips caller-supplied credentials", async () => {
    const native = new FakeNativeModule();
    install(native);
    let outbound: Request | undefined;
    const client = create({
      fetch: async (request) => {
        outbound = request as Request;
        return new Response("ok");
      },
    });

    const response = await client.fetch("/v1/responses", {
      latchwayFeature: "habit_assistant",
      headers: {
        Authorization: "Bearer caller-secret",
        "X-Api-Key": "upstream-secret",
        "Anthropic-Api-Key": "upstream-secret",
        "OpenAI_Api_Key": "upstream-secret",
        "X-Amz-Security-Token": "upstream-secret",
        "X-Goog-Credential": "upstream-secret",
        DPoP: "caller-proof",
        "X-Latchway-Request-ID": "caller-request",
      },
    });

    expect(await response.text()).toBe("ok");
    expect(outbound?.headers.get("Authorization")).toBe("DPoP native-access-token");
    expect(outbound?.headers.get("X-Api-Key")).toBeNull();
    expect(outbound?.headers.get("Anthropic-Api-Key")).toBeNull();
    expect(outbound?.headers.get("OpenAI_Api_Key")).toBeNull();
    expect(outbound?.headers.get("X-Amz-Security-Token")).toBeNull();
    expect(outbound?.headers.get("X-Goog-Credential")).toBeNull();
    expect(outbound?.headers.get("DPoP")).toBe("header.payload.signature");
    expect(outbound?.headers.get("X-Latchway-Feature")).toBe("habit_assistant");
    expect(outbound?.headers.get("X-Latchway-SDK")).toBe("react-native");
    expect(outbound?.headers.get("X-Latchway-Protocol-Version")).toBe("1");
    expect(outbound?.headers.get("X-Latchway-Request-ID")).toBe(ANDROID_REQUEST_ID);
    expect(native.lastIdentityToken).toBe("app-owned-identity-token");
    expect(native.authorizations[0]?.encoded).not.toContain("app-owned-identity-token");
  });

  it("rejects cross-origin targets before requesting identity", async () => {
    const native = new FakeNativeModule();
    install(native);
    const getIdentityToken = vi.fn(async () => "identity");
    const client = create({ getIdentityToken });
    await expect(client.fetch("https://attacker.invalid/v1", { latchwayFeature: "chat" }))
      .rejects.toMatchObject({ code: "client_configuration_invalid" });
    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(native.authorizations).toHaveLength(0);
  });

  it("rejects encoded and case-varied provider credentials in the query before authorization or dispatch", async () => {
    const native = new FakeNativeModule();
    install(native);
    const getIdentityToken = vi.fn(async () => "identity");
    const dispatch = vi.fn(async () => new Response("must not dispatch"));
    const client = create({ getIdentityToken, fetch: dispatch });
    const credential = "synthetic-provider-secret-marker";

    for (const name of [
      "AUTHORIZATION",
      "Proxy-Authorization",
      "Api-Key",
      "API_KEY",
      "%61pi%5Fkey",
      "X-Api-Key",
      "OpenAI-Api-Key",
      "OPENAI_API_KEY",
      "X-OpenAI-Api-Key",
      "Anthropic-Api-Key",
      "ANTHROPIC_API_KEY",
      "X-Goog-Api-Key",
      "X-Goog_API_KEY",
      "Access%5FToken",
      "AUTH_TOKEN",
      "X-Auth-Token",
      "Cookie",
      "KEY",
      "ToKeN",
      "X-Amz-Credential",
      "X-Amz-Security-Token",
      "x-amz-signature",
      "X-Goog-Credential",
      "X-Goog-Signature",
    ]) {
      const failure: unknown = await client.fetch(`/v1/models?${name}=${credential}`, { latchwayFeature: "chat" })
        .then(() => undefined, (error: unknown) => error);
      expect(failure).toMatchObject({
        code: "request_invalid",
        message: "Upstream provider credentials must not be supplied in the request URL.",
      });
      expect(String(failure)).not.toContain(credential);
    }

    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(native.authorizations).toHaveLength(0);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("shares one native client across equivalent JavaScript instances", async () => {
    const native = new FakeNativeModule();
    install(native);
    const first = create();
    const second = create();
    await Promise.all([first.ready, second.ready]);
    expect(native.configureCalls).toBe(1);
    await first.dispose();
    expect(native.disposeCalls).toBe(0);
    await second.dispose();
    expect(native.disposeCalls).toBe(1);
  });

  it("rejects conflicting active native configuration for one scope", async () => {
    const native = new FakeNativeModule();
    install(native);
    const first = create();
    await first.ready;
    const second = create({ android: { keyPolicy: "software_allowed" } });
    await expect(second.ready).rejects.toMatchObject({ code: "client_configuration_invalid" });
  });

  it("fails closed on a native contract mismatch and disposes partial native state", async () => {
    const native = new FakeNativeModule();
    native.compatibility = { contractVersion: "9.9.9" };
    install(native);
    const client = create();

    await expect(client.ready).rejects.toMatchObject({ code: "protocol_response_invalid" });
    expect(native.disposeCalls).toBe(1);
  });

  it("performs one safe DPoP nonce retry and preserves the request ID", async () => {
    const native = new FakeNativeModule();
    install(native);
    let calls = 0;
    const client = create({
      fetch: async () => {
        calls += 1;
        if (calls === 1) {
          return problem("dpop_nonce_required", {
            "DPoP-Nonce": "nonce-0123456789abcdef",
          });
        }
        return new Response("retried");
      },
    });

    expect(await (await client.fetch("/v1/models", { latchwayFeature: "chat" })).text()).toBe("retried");
    expect(calls).toBe(2);
    expect(native.authorizations).toHaveLength(2);
    expect(native.authorizations[1]?.request.nonce).toBe("nonce-0123456789abcdef");
    expect(native.authorizations[1]?.request.requestID).toBe(ANDROID_REQUEST_ID);
  });

  it("refreshes once after a validated bodyless session-expired rejection", async () => {
    const native = new FakeNativeModule();
    install(native);
    let calls = 0;
    const client = create({
      fetch: async () => ++calls === 1 ? problem("session_expired") : new Response("refreshed"),
    });
    expect(await (await client.fetch("/v1/models", { latchwayFeature: "chat" })).text()).toBe("refreshed");
    expect(native.refreshCalls).toBe(1);
    expect(calls).toBe(2);
  });

  it("exposes explicit session rotation without returning credentials", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    await expect(client.refresh()).resolves.toBeUndefined();
    expect(native.refreshCalls).toBe(1);
    expect(native.lastIdentityToken).toBe("app-owned-identity-token");
  });

  it("does not replay requests with a body", async () => {
    const native = new FakeNativeModule();
    install(native);
    let calls = 0;
    const client = create({ fetch: async () => { calls += 1; return problem("session_expired"); } });
    const response = await client.fetch("/v1/responses", {
      method: "POST",
      body: "prompt",
      latchwayFeature: "chat",
    });
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
    expect(native.refreshCalls).toBe(0);
  });

  it("does not clone or replay a streamed request body", async () => {
    const native = new FakeNativeModule();
    install(native);
    const clone = vi.spyOn(Request.prototype, "clone");
    let calls = 0;
    const client = create({
      fetch: async (request) => {
        calls += 1;
        expect(await (request as Request).text()).toBe("streamed-prompt");
        return problem("session_expired");
      },
    });
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("streamed-"));
        controller.enqueue(new TextEncoder().encode("prompt"));
        controller.close();
      },
    });
    const request = new Request("https://gateway.example.test/v1/responses", {
      method: "POST",
      body: source,
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    const response = await client.fetch(request, { latchwayFeature: "chat" });

    expect(response.status).toBe(401);
    expect(calls).toBe(1);
    expect(native.refreshCalls).toBe(0);
    expect(clone).not.toHaveBeenCalled();
  });

  it("requires retryable and request-correlated problem metadata before replay", async () => {
    const native = new FakeNativeModule();
    install(native);
    const responses = [
      problem("session_expired", {}, false),
      problem("session_expired", { "X-Latchway-Request-ID": "request-00000002" }),
    ];
    let calls = 0;
    const client = create({
      fetch: async () => {
        calls += 1;
        const response = responses.shift();
        if (response === undefined) throw new Error("unexpected replay");
        return response;
      },
    });

    const notRetryable = await client.fetch("/v1/models?case=retryable", { latchwayFeature: "chat" });
    const mismatched = await client.fetch("/v1/models?case=request-id", { latchwayFeature: "chat" });

    expect(notRetryable.status).toBe(401);
    expect(mismatched.status).toBe(401);
    expect(calls).toBe(2);
    expect(native.refreshCalls).toBe(0);
  });

  it("requires the exact canonical pre-dispatch problem before replay", async () => {
    const native = new FakeNativeModule();
    install(native);
    const responses = [
      problem("session_expired", {}, true, { type: "https://example.test/problems/session_expired" }),
      problem("session_expired", {}, true, { title: "Request rejected" }),
      problem("session_expired", {}, true, { detail: "Please refresh this session." }),
      problem("session_expired", {}, true, { status: 400 }),
      problem("session_expired", {}, true, { feature: "chat" }),
      problem("session_expired", {}, true, { detail: undefined }),
      problem("dpop_nonce_required"),
      problem("dpop_nonce_required", { "DPoP-Nonce": "nonce-0123456789,second-nonce" }),
      problem("dpop_nonce_required", { "DPoP-Nonce": "nonce-0123456789 abcdef" }),
      problem("session_expired", { "DPoP-Nonce": "nonce-0123456789abcdef" }),
      duplicateProblem(false),
      duplicateProblem(true),
      oversizedProblem(),
    ];
    const invalidCount = responses.length;
    const dispatch = vi.fn(async () => {
      const response = responses.shift();
      if (response === undefined) throw new Error("unexpected replay");
      return response;
    });
    const client = create({ fetch: dispatch });

    for (let index = 0; index < invalidCount; index += 1) {
      const response = await client.fetch(`/v1/models?case=invalid-${index}`, { latchwayFeature: "chat" });
      expect(response.status).toBe(401);
      if (index === invalidCount - 1) expect(await response.text()).toHaveLength(65_537);
    }

    expect(dispatch).toHaveBeenCalledTimes(invalidCount);
    expect(native.authorizations).toHaveLength(invalidCount);
    expect(native.refreshCalls).toBe(0);
  });

  it("returns the fetch response stream without consuming or replacing it", async () => {
    const native = new FakeNativeModule();
    install(native);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: first\n\n"));
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    const delivered = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    const client = create({ fetch: async () => delivered });

    const received = await client.fetch("/v1/responses", { latchwayFeature: "chat" });

    expect(received).toBe(delivered);
    expect(received.body).toBe(stream);
    await expect(received.text()).resolves.toBe("data: first\n\ndata: [DONE]\n\n");
  });

  it("cancels the native operation when the fetch signal aborts", async () => {
    const native = new FakeNativeModule();
    native.authorizationGate = new Promise<string>(() => {});
    install(native);
    const controller = new AbortController();
    const client = create();
    const pending = client.fetch("/v1/models", { latchwayFeature: "chat", signal: controller.signal });
    await vi.waitFor(() => { expect(native.authorizations).toHaveLength(1); });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(native.cancelCalls).toHaveLength(1);
  });

  it("maps quota and redacted diagnostics without credential material", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    expect(await client.quota("chat")).toEqual({
      feature: "chat",
      observed_at: "2026-08-27T00:00:00Z",
      limits: [{ metric: "requests", maximum: 10, remaining: 9, hard: true }],
    });
    const diagnostics = await client.diagnostics();
    expect(diagnostics).toMatchObject({
      platform: "react_native_ios",
      contractVersion: "0.4.0",
      protocolVersion: 1,
      keyStorage: "secure_enclave",
      attestation: { provider: "app_attest", trustLevel: "device_verified" },
      session: { state: "active" },
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|proof|evidence|private/iu);
  });

  it("redacts secret-shaped native error messages", async () => {
    const native = new FakeNativeModule();
    native.error = Object.assign(new Error(`identity_token eyJ${"a".repeat(80)}`), {
      code: "identity_token_invalid",
      requestID: ANDROID_REQUEST_ID,
    });
    install(native);
    const client = create();
    await expect(client.quota("chat")).rejects.toMatchObject({
      name: "LatchwayError",
      code: "identity_token_invalid",
      message: "Sensitive native error detail was redacted.",
      requestID: ANDROID_REQUEST_ID,
    });
  });

  it("preserves a canonical native reconciliation ID for indeterminate operations", async () => {
    const native = new FakeNativeModule();
    native.error = Object.assign(new Error(`identity_token eyJ${"a".repeat(80)}`), {
      code: "operation_indeterminate",
      userInfo: {
        code: "operation_indeterminate",
        requestID: ANDROID_REQUEST_ID,
        operationID: OPERATION_ID,
        status: 503,
        retryable: true,
      },
    });
    install(native);
    const client = create();

    await expect(client.quota("chat")).rejects.toMatchObject({
      name: "LatchwayError",
      code: "operation_indeterminate",
      requestID: ANDROID_REQUEST_ID,
      operationID: OPERATION_ID,
      status: 503,
      retryable: true,
      message: "Sensitive native error detail was redacted.",
    });
  });

  it("fails closed on missing, malformed, conflicting, or forbidden native operation IDs", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    const failures = [
      { code: "operation_indeterminate" },
      { code: "operation_indeterminate", operationID: "arq_invalid" },
      {
        code: "operation_indeterminate",
        operationID: OPERATION_ID,
        userInfo: { operation_id: "arq_0ZZZZZZZZZZZZZZZZZZZZZZZZZ" },
      },
      {
        code: "operation_indeterminate",
        requestID: ANDROID_REQUEST_ID,
        operationID: OPERATION_ID,
        status: 500,
        retryable: true,
      },
      { code: "internal_error", operationID: OPERATION_ID },
    ];

    for (const metadata of failures) {
      native.error = Object.assign(new Error(`identity_token eyJ${"a".repeat(80)}`), metadata);
      await expect(client.quota("chat")).rejects.toMatchObject({
        code: "protocol_response_invalid",
        message: "Latchway returned invalid native error metadata.",
        operationID: undefined,
        retryable: false,
      });
    }
  });

  it("exports HTTP problem conversion with canonical operation reconciliation metadata", async () => {
    const error = await errorFromResponse(new Response(JSON.stringify({
      type: "https://latchway.dev/problems/operation_indeterminate",
      title: "Operation outcome indeterminate",
      status: 503,
      detail: "The administrative operation outcome must be reconciled.",
      code: "operation_indeterminate",
      request_id: ANDROID_REQUEST_ID,
      retryable: true,
      operation_id: OPERATION_ID,
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/problem+json",
        "X-Latchway-Request-ID": ANDROID_REQUEST_ID,
      },
    }));

    expect(error).toMatchObject({
      code: "operation_indeterminate",
      requestID: ANDROID_REQUEST_ID,
      operationID: OPERATION_ID,
      status: 503,
      retryable: true,
    });
  });

  it("does not misclassify a server configuration error as local SDK configuration", async () => {
    const native = new FakeNativeModule();
    native.error = Object.assign(new Error("The active server revision is invalid."), {
      code: "configuration_invalid",
      requestID: ANDROID_REQUEST_ID,
      status: 503,
    });
    install(native);
    const client = create();

    await expect(client.quota("chat")).rejects.toMatchObject({
      code: "configuration_invalid",
      requestID: ANDROID_REQUEST_ID,
      status: 503,
    });
  });

  it("rejects insecure and ambiguous configuration synchronously", () => {
    expect(() => createLatchwayClient(baseOptions({ baseURL: "http://gateway.example.test" })))
      .toThrow(LatchwayError);
    expect(() => createLatchwayClient(baseOptions({
      getIdentityToken: async () => "one",
      identityTokenProvider: { getIdentityToken: async () => "two" },
    }))).toThrow(/either getIdentityToken or identityTokenProvider/iu);
    expect(() => createLatchwayClient(baseOptions({
      android: { playIntegrityCloudProjectNumber: "not-a-project-number" },
    }))).toThrow(/Google Cloud project number/iu);
    for (const applicationID of [
      "habitify",
      "app_habitify",
      "app_81J00000000000000000000000",
      "app_01j00000000000000000000000",
      "app_01J0000000000000000000000",
    ]) {
      expect(() => createLatchwayClient(baseOptions({ applicationID })))
        .toThrow(/canonical app_ resource ID/iu);
    }
  });

  it("consumes the pinned canonical protocol and DPoP vectors", async () => {
    const fixtureRoot = new URL("fixtures/contract/", import.meta.url);
    const protocol = JSON.parse(await readFile(new URL("protocol-version.json", fixtureRoot), "utf8")) as ProtocolFixture;
    const dpop = JSON.parse(await readFile(new URL("dpop-v1.json", fixtureRoot), "utf8")) as DPoPFixture;
    const binding = JSON.parse(await readFile(new URL("attestation-binding-v1.json", fixtureRoot), "utf8")) as BindingFixture;
    expect(protocol.contract_version).toBe("0.4.0");
    expect(protocol.wire_protocol.current).toBe(1);
    expect(protocol.sdk_kinds).toContain("react-native");
    expect(dpop.vectors.filter((vector: { expected: { valid: boolean } }) => vector.expected.valid)).toHaveLength(3);
    expect(dpop.vectors.at(2)?.proof.split(".")).toHaveLength(3);
    expect(binding.vectors.map((vector) => vector.sha256_base64url))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)]));
  });
});

function install(native: FakeNativeModule): void {
  restoreNative = installNativeModuleForTesting(native);
}

function create(overrides: Partial<Parameters<typeof createLatchwayClient>[0]> = {}): LatchwayClient {
  const client = createLatchwayClient(baseOptions(overrides));
  clients.push(client);
  return client;
}

function baseOptions(overrides: Partial<Parameters<typeof createLatchwayClient>[0]> = {}): Parameters<typeof createLatchwayClient>[0] {
  return {
    baseURL: "https://gateway.example.test",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    getIdentityToken: async () => "app-owned-identity-token",
    ...overrides,
  };
}

function problem(
  code: "dpop_nonce_required" | "session_expired",
  extraHeaders: Record<string, string> = {},
  retryable = true,
  overrides: Record<string, unknown> = {},
): Response {
  const definition = code === "dpop_nonce_required"
    ? { title: "DPoP nonce required", detail: "A fresh server DPoP nonce is required." }
    : { title: "Session expired", detail: "The Latchway session is expired." };
  return new Response(JSON.stringify({
    type: `https://latchway.dev/problems/${code}`,
    title: definition.title,
    status: 401,
    detail: definition.detail,
    code,
    request_id: ANDROID_REQUEST_ID,
    retryable,
    ...overrides,
  }), {
    status: 401,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Latchway-Request-ID": ANDROID_REQUEST_ID,
      ...extraHeaders,
    },
  });
}

function oversizedProblem(): Response {
  return new Response("x".repeat(65_537), {
    status: 401,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Latchway-Request-ID": ANDROID_REQUEST_ID,
    },
  });
}

function duplicateProblem(escaped: boolean): Response {
  const duplicate = escaped ? "c\\u006fde" : "code";
  const body = `{` +
    `"type":"https://latchway.dev/problems/session_expired",` +
    `"title":"Session expired",` +
    `"status":401,` +
    `"detail":"The Latchway session is expired.",` +
    `"code":"session_expired",` +
    `"${duplicate}":"session_expired",` +
    `"request_id":"${ANDROID_REQUEST_ID}",` +
    `"retryable":true` +
    `}`;
  return new Response(body, {
    status: 401,
    headers: {
      "Content-Type": "application/problem+json",
      "X-Latchway-Request-ID": ANDROID_REQUEST_ID,
    },
  });
}

class FakeNativeModule {
  configureCalls = 0;
  disposeCalls = 0;
  refreshCalls = 0;
  readonly cancelCalls: string[] = [];
  readonly authorizations: Array<{
    encoded: string;
    request: { url: string; method: string; feature: string; nonce: string | null; requestID: string | null };
  }> = [];
  lastIdentityToken: string | undefined;
  authorizationGate: Promise<string> | undefined;
  error: Error | undefined;
  compatibility: Partial<{
    platform: string;
    nativeSDKVersion: string;
    contractVersion: string;
    protocolVersion: number;
  }> = {};

  async configure(_clientID: string, configurationJSON: string): Promise<string> {
    this.configureCalls += 1;
    const config = JSON.parse(configurationJSON) as { contractVersion: string; protocolVersion: number };
    return JSON.stringify({
      platform: "react_native_ios",
      nativeSDKVersion: "0.1.0",
      contractVersion: config.contractVersion,
      protocolVersion: config.protocolVersion,
      ...this.compatibility,
    });
  }

  async authorize(
    _clientID: string,
    _operationID: string,
    identityToken: string,
    encoded: string,
  ): Promise<string> {
    this.lastIdentityToken = identityToken;
    const request = JSON.parse(encoded) as FakeNativeModule["authorizations"][number]["request"];
    this.authorizations.push({ encoded, request });
    if (this.error !== undefined) throw this.error;
    if (this.authorizationGate !== undefined) return this.authorizationGate;
    return JSON.stringify({
      authorization: "DPoP native-access-token",
      dpop: "header.payload.signature",
      requestID: request.requestID ?? ANDROID_REQUEST_ID,
    });
  }

  async refresh(_clientID: string, _operationID: string, identityToken: string): Promise<void> {
    this.lastIdentityToken = identityToken;
    this.refreshCalls += 1;
    if (this.error !== undefined) throw this.error;
  }

  async quota(_clientID: string, _operationID: string, identityToken: string, feature: string): Promise<string> {
    this.lastIdentityToken = identityToken;
    if (this.error !== undefined) throw this.error;
    return JSON.stringify({
      feature,
      observed_at: "2026-08-27T00:00:00Z",
      limits: [{ metric: "requests", maximum: 10, remaining: 9, hard: true }],
    });
  }

  async diagnostics(_clientID: string, _operationID: string, identityToken: string): Promise<string> {
    this.lastIdentityToken = identityToken;
    if (this.error !== undefined) throw this.error;
    return JSON.stringify({
      contractVersion: "0.4.0",
      protocolVersion: 1,
      keyStorage: "secure_enclave",
      attestation: { support: "supported", provider: "app_attest", trustLevel: "device_verified" },
      session: { state: "active", expiresAt: "2026-08-28T00:00:00Z", refreshAvailable: true },
      installation: { id: "ins_0000000000000001", status: "active" },
      server: { version: "0.1.0", lastRequestID: "request-00000001" },
    });
  }

  async revoke(_clientID: string, _operationID: string, identityToken: string): Promise<void> {
    this.lastIdentityToken = identityToken;
    if (this.error !== undefined) throw this.error;
  }

  cancel(_clientID: string, operationID: string): void {
    this.cancelCalls.push(operationID);
  }

  async dispose(_clientID: string): Promise<void> {
    this.disposeCalls += 1;
  }
}
