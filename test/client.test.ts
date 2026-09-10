import { sharedFixtureClient, sharedDescriptor } from "./shared-fixture.js";
import type { LatchwayAppOptions } from "../src/app.js";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LatchwayError } from "@latchway/client";
import type { LatchwayErrorCode } from "@latchway/client";
import { createLatchwayComponentClient, errorFromResponse } from "../src/index.js";
import { fromNativeError } from "../src/errors.js";
import type { LatchwayClient, LatchwayComponentClient, ReactNativeIOSComponent } from "../src/types.js";
import { installNativeModuleForTesting } from "../src/testing.js";

interface ProtocolFixture {
  contract_version: string;
  contract_status: string;
  wire_protocol: { current: number; supported: number[] };
  bundle: { required_entries: string[] };
  component_attestation_binding: {
    version: number;
    purpose: string;
    canonicalization: string;
    hash: string;
  };
  sdk_kinds: string[];
}

interface DPoPFixture {
  vectors: Array<{ proof: string; expected: { valid: boolean } }>;
}

interface BindingFixture {
  vectors: Array<{ sha256_base64url: string }>;
}

interface ComponentBindingFixture {
  contract_version: string;
  binding_version: number;
  canonicalization: string;
  hash: string;
  vectors: Array<{
    id: string;
    input: {
      version: number;
      purpose: string;
      component_definition_id: string;
      platform: string;
    };
    canonical_json: string;
    utf8_hex: string;
    sha256_hex: string;
    sha256_base64url: string;
  }>;
}

interface InstallationFamilyFixture {
  contract_version: string;
  wire_protocol_version: number;
  family: { id: string; status: string };
  root_component: { id: string; granted_features: string[]; is_root: boolean };
  root_session_claims: {
    installation_family_id: string;
    component_id: string;
    features: string[];
    trust: { source: string };
    installation_id?: never;
  };
  provisioned_components: Array<{
    response: { component_id: string; installation_family_id: string; granted_features: string[] };
    expected_session_claims: {
      component_id: string;
      features: string[];
      trust: { source: string; parent_component_id: string };
      installation_id?: never;
    };
  }>;
  revocations: Array<{ scope: string; expected_family_status: string }>;
}

interface NativeRequestRecord {
  encoded: string;
  identityToken?: never;
  operationID: string;
  request: {
    url: string;
    method: string;
    feature: string;
    headers: Array<[string, string]>;
    bodyBase64: string | null;
  };
}

interface ResponseFixture {
  status?: number;
  statusText?: string;
  headers?: Array<[string, string]>;
  chunks?: string[];
}

const clients: LatchwayClient[] = [];
const componentClients: LatchwayComponentClient[] = [];
const REQUEST_ID = "android:550e8400-e29b-41d4-a716-446655440000";
const OPERATION_ID = "arq_0123456789ABCDEFGHJKMNPQRS";
const DIRECT_COMPONENT = {
  definitionID: "action_extension",
  kind: "action_extension",
  keychainAccessGroup: "ABCDE12345.com.example.app.action-extension",
  requestedFeatures: ["habit_assistant"],
} as const;
const APP_INTENT_COMPONENT = {
  definitionID: "app_intent",
  kind: "app_intent_extension",
  keychainAccessGroup: "ABCDE12345.com.example.app.shared",
  requestedFeatures: ["habit_assistant"],
} as const;
let restoreNative: (() => void) | undefined;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => { await client.dispose(); }));
  await Promise.allSettled(componentClients.splice(0).map(async (client) => { await client.dispose(); }));
  restoreNative?.();
  restoreNative = undefined;
  vi.unstubAllGlobals();
});

describe("React Native Latchway native-owned fetch", () => {
  it("dispatches through native and exposes only safe response metadata and streamed bytes", async () => {
    const native = new FakeNativeModule();
    native.responses.push({
      status: 201,
      headers: [
        ["content-type", "text/event-stream"],
        ["x-latchway-request-id", REQUEST_ID],
      ],
      chunks: ["data: first\n", "data: [DONE]\n\n"],
    });
    install(native);
    const javascriptFetch = vi.fn(async () => new Response("credential leak"));
    vi.stubGlobal("fetch", javascriptFetch);
    const client = create();

    const response = await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "habit_assistant",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: "hello" }),
    });

    expect(response.status).toBe(201);
    expect(response.headers.get("x-latchway-request-id")).toBe(REQUEST_ID);
    expect(await response.text()).toBe("data: first\ndata: [DONE]\n\n");
    expect(javascriptFetch).not.toHaveBeenCalled();
    expect(native.requests).toHaveLength(1);
    expect(native.requests[0]?.request).toMatchObject({
      url: "https://gateway.example.test/v1/responses",
      method: "POST",
      feature: "habit_assistant",
    });
    expect(native.requests[0]?.request.headers).toContainEqual(["content-type", "application/json"]);
    expect(decodeBase64(native.requests[0]?.request.bodyBase64)).toBe('{"prompt":"hello"}');
    expect(native.requests[0]?.encoded).not.toContain("app-owned-identity-token");
    expect(native.requests[0]?.identityToken).toBe(undefined);
  });

  it("restores the native pull stream when React Native Response omits body", async () => {
    const StandardResponse = Response;
    class ReactNativeResponse extends StandardResponse {
      constructor(_body?: BodyInit | null, init?: ResponseInit) {
        super(null, init);
        Object.defineProperty(this, "body", {
          configurable: true,
          enumerable: true,
          value: undefined,
        });
      }
    }
    vi.stubGlobal("Response", ReactNativeResponse);
    const native = new FakeNativeModule();
    native.responses.push({ chunks: ["native ", "stream"] });
    install(native);
    const client = create();

    const response = await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "habit_assistant",
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing restored response stream");
    const decoder = new TextDecoder();
    let output = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();

    expect(output).toBe("native stream");
    expect(native.closeCalls).toHaveLength(1);
  });

  it("encodes the request body when React Native Request omits its stream", async () => {
    const StandardRequest = Request;
    class ReactNativeRequest extends StandardRequest {
      constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        Object.defineProperty(this, "body", {
          configurable: true,
          enumerable: true,
          value: undefined,
        });
      }
    }
    vi.stubGlobal("Request", ReactNativeRequest);
    const native = new FakeNativeModule();
    install(native);
    const client = create();

    const response = await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "habit_assistant",
      body: "react-native-body",
    });
    await response.body?.cancel();

    expect(decodeBase64(native.requests[0]?.request.bodyBase64)).toBe("react-native-body");
  });

  it("uses the bundled ponyfill when React Native has no global ReadableStream", async () => {
    vi.stubGlobal("ReadableStream", undefined);
    const native = new FakeNativeModule();
    native.responses.push({ chunks: ["ponyfill ", "stream"] });
    install(native);
    const client = create();

    const response = await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "habit_assistant",
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing ponyfill response stream");
    const decoder = new TextDecoder();
    let output = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      output += decoder.decode(chunk.value, { stream: true });
    }
    output += decoder.decode();

    expect(output).toBe("ponyfill stream");
    expect(native.closeCalls).toHaveLength(1);
  });

  it("returns a fetch-compatible function permanently bound to one feature", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    const chatFetch = client.fetchFor("chat");

    await expect((await chatFetch("/v1/chat/completions", { method: "POST", body: "{}" })).text())
      .resolves.toBe("ok");
    expect(native.requests[0]?.request.feature).toBe("chat");
  });

  it("preserves exact routes when React Native reparses absolute URLs with a trailing slash", async () => {
    const StandardURL = URL;
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    const structured = new Request("https://gateway.example.test/v1/chat/completions", {
      method: "POST",
      body: "{}",
    });
    const opaque = new Request("https://gateway.example.test/proxy/chat/vendor/models", {
      method: "GET",
    });
    const genuinelyTrailing = new Request("https://gateway.example.test/v1/chat/completions/", {
      method: "POST",
      body: "{}",
    });
    class ReactNativeURL extends StandardURL {
      constructor(input: string | { toString(): string }, base?: string | { toString(): string }) {
        const serializedInput = String(input);
        super(serializedInput, base === undefined ? undefined : String(base));
        if (base === undefined && /^https?:\/\//u.test(serializedInput) &&
            !serializedInput.includes("?") && !serializedInput.includes("#") &&
            !serializedInput.endsWith("/") && this.pathname !== "/") {
          this.pathname = `${this.pathname}/`;
        }
      }
    }
    vi.stubGlobal("URL", ReactNativeURL);

    await client.fetch(structured, {
      latchwayFeature: "chat",
    });
    await client.fetch(opaque, {
      latchwayFeature: "chat",
    });

    expect(native.requests.map(({ request }) => request.url)).toEqual([
      "https://gateway.example.test/v1/chat/completions",
      "https://gateway.example.test/proxy/chat/vendor/models",
    ]);
    await expect(client.fetch(genuinelyTrailing, {
      latchwayFeature: "chat",
    })).rejects.toMatchObject({ code: "transport_destination_not_allowed" });
  });

  it("dispatches a canonical feature-bound opaque route", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();

    await expect((await client.fetch("/proxy/chat/vendor/v1/models", {
      method: "GET",
      latchwayFeature: "chat",
    })).text()).resolves.toBe("ok");
    expect(native.requests[0]?.request).toMatchObject({
      url: "https://gateway.example.test/proxy/chat/vendor/v1/models",
      method: "GET",
      feature: "chat",
    });
  });

  it("FW-AUTH-109 rejects wrong methods and paths before identity or native dispatch", async () => {
    const native = new FakeNativeModule();
    install(native);
    const getIdentityToken = vi.fn(async () => "identity");
    const client = create({ getIdentityToken });
    const invalidTargets = [
      ["GET", "/v1/responses"],
      ["OPTIONS", "/proxy/chat/vendor/models"],
      ["GET", "/proxy/other/vendor/models"],
      ["GET", "/proxy/chat/"],
      ["GET", "/proxy/chat/vendor/models?region=us"],
      ["GET", "/proxy/chat/vendor//models"],
      ["GET", "/proxy/chat/vendor/%2Fmodels"],
      ["GET", "/proxy/chat/vendor/%5Cmodels"],
      ["GET", "/proxy/chat/vendor/%2emodels"],
      ["GET", "/proxy/chat/http:attacker.invalid"],
    ] as const;

    for (const [method, target] of invalidTargets) {
      await expect(client.fetch(target, { method, latchwayFeature: "chat" })).rejects.toMatchObject({
        code: "transport_destination_not_allowed",
      });
    }
    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(native.requests).toHaveLength(0);
  });

  it("strips caller credentials and native-owned protocol headers before crossing the bridge", async () => {
    const native = new FakeNativeModule();
    install(native);
    const getIdentityToken = vi.fn(async () => "identity");
    const client = create({ getIdentityToken });

    await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      headers: { Authorization: "Bearer provider-secret" },
    });
    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(native.requests[0]?.request.headers).toEqual([]);

    await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      headers: {
        "X-Latchway-Feature": "caller-feature",
        "X-Latchway-Request-ID": "caller-request-id",
        "X-Latchway-Protocol-Version": "0",
      },
    });
    expect(native.requests[1]?.request.headers).toEqual([]);
  });

  it("FW-SEC-102 strips duplicate Authorization values before TurboModule dispatch", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    const headers = new Headers();
    headers.append("Authorization", "Bearer first-provider-secret");
    headers.append("Authorization", "Bearer second-provider-secret");

    await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      headers,
    });

    expect(native.requests[0]?.request.headers).toEqual([]);
    expect(native.requests[0]?.encoded).not.toContain("first-provider-secret");
    expect(native.requests[0]?.encoded).not.toContain("second-provider-secret");
  });

  it.each([
    "access-token",
    "AccessToken",
    "client-secret",
    "x-provider-credential",
    "DPoP",
  ])("normalizes and strips credential-shaped request header %s", async (header) => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      headers: { [header]: "synthetic-secret" },
    });
    expect(native.requests[0]?.request.headers).toEqual([]);
  });

  it("FW-AUTH-108 rejects a wrong URI before identity or native dispatch", async () => {
    const native = new FakeNativeModule();
    install(native);
    const getIdentityToken = vi.fn(async () => "identity");
    const client = create({ getIdentityToken });
    const targets = [
      "https://attacker.invalid/v1/responses",
      "/v1/models",
      "/v1/responses#fragment",
      "/v1/responses?%2561ccess_token=provider-secret",
      "/v1/responses?%2525252561ccess_token=provider-secret",
      "/v1/responses?X-Amz-Security-Token=provider-secret",
      "/v1/responses?access-token=provider-secret",
      "/v1/responses?clientSecret=provider-secret",
      "/v1/responses?provider_credential=provider-secret",
    ];

    for (const target of targets) {
      await expect(client.fetch(target, { method: "POST", latchwayFeature: "chat" }))
        .rejects.toBeInstanceOf(LatchwayError);
    }
    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(native.requests).toHaveLength(0);
  });

  it("buffers a bounded request body for native dispatch and fails before identity above 8 MiB", async () => {
    const native = new FakeNativeModule();
    install(native);
    const getIdentityToken = vi.fn(async () => "identity");
    const client = create({ getIdentityToken });
    const oversized = new Uint8Array(8 * 1024 * 1024 + 1);

    await expect(client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      body: oversized,
    })).rejects.toMatchObject({ code: "request_invalid" });
    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(native.requests).toHaveLength(0);
  });

  it("pulls native response chunks on demand and closes the opaque handle after EOF", async () => {
    const native = new FakeNativeModule();
    native.responses.push({ chunks: ["one", "two"] });
    install(native);
    const client = create();
    const response = await client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing response stream");

    expect(native.readCalls).toBe(0);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("one");
    expect(native.readCalls).toBe(1);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("two");
    expect(native.readCalls).toBe(2);
    expect((await reader.read()).done).toBe(true);
    expect(native.readCalls).toBe(3);
    expect(native.closeCalls).toHaveLength(1);
  });

  it("closes a native response when the JavaScript consumer cancels", async () => {
    const native = new FakeNativeModule();
    native.responses.push({ chunks: ["first", "second"] });
    install(native);
    const client = create();
    const response = await client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing response stream");
    await reader.cancel("done");
    expect(native.closeCalls).toHaveLength(1);
  });

  it("preserves response correlation and prevents replay after a failed body read", async () => {
    const native = new FakeNativeModule();
    native.responses.push({ headers: [["x-latchway-request-id", REQUEST_ID]], chunks: ["partial"] });
    install(native);
    const client = create();
    const response = await client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing response stream");
    expect((await reader.read()).done).toBe(false);
    native.error = Object.assign(new Error("The native response stream was interrupted."), { code: "network_unavailable" });
    await expect(reader.read()).rejects.toMatchObject({
      code: "network_error", requestID: REQUEST_ID, status: 200, retryable: false,
    });
    expect(native.requests).toHaveLength(1);
    expect(native.closeCalls).toHaveLength(1);
  });

  it("cancels native dispatch when aborted before response headers", async () => {
    const native = new FakeNativeModule();
    native.startGate = new Promise<string>(() => {});
    install(native);
    const controller = new AbortController();
    const client = create();
    const pending = client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      signal: controller.signal,
    });
    await vi.waitFor(() => { expect(native.requests).toHaveLength(1); });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(native.cancelCalls).toHaveLength(1);
  });

  it("cancels an active native read and closes its response on abort", async () => {
    const native = new FakeNativeModule();
    native.responses.push({ chunks: ["blocked"] });
    native.readGate = new Promise<void>(() => {});
    install(native);
    const controller = new AbortController();
    const client = create();
    const response = await client.fetch("/v1/responses", {
      method: "POST",
      latchwayFeature: "chat",
      signal: controller.signal,
    });
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error("missing response stream");
    const pending = reader.read();
    await vi.waitFor(() => { expect(native.readCalls).toBe(1); });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(native.cancelCalls).toHaveLength(1);
    expect(native.closeCalls).toHaveLength(1);
  });

  it("closes bodyless native responses without requesting a chunk", async () => {
    const native = new FakeNativeModule();
    native.responses.push({ status: 204, chunks: [] });
    install(native);
    const client = create();
    const response = await client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" });
    expect(response.body).toBeNull();
    expect(native.readCalls).toBe(0);
    expect(native.closeCalls).toHaveLength(1);
  });

  it.each([
    "authorization",
    "dpop",
    "accessToken",
    "refresh_token",
    "privateKey",
    "session_token",
    "attestationEvidence",
  ])("fails closed if native response metadata contains credential field %s", async (field) => {
    const native = new FakeNativeModule();
    native.metadataExtra = { [field]: "synthetic-secret" };
    install(native);
    const client = create();
    await expect(client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" }))
      .rejects.toMatchObject({
      code: "protocol_response_invalid",
      message: "Latchway native output crossed the credential boundary.",
    });
    expect(native.closeCalls).toHaveLength(1);
  });

  it("fails closed if native metadata exposes a credential header", async () => {
    const native = new FakeNativeModule();
    native.responses.push({ headers: [["authorization", "DPoP secret"]] });
    install(native);
    const client = create();
    await expect(client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" }))
      .rejects.toMatchObject({ code: "protocol_response_invalid" });
    expect(native.closeCalls).toHaveLength(1);
  });

  it("fails closed and closes the response if a chunk envelope contains a credential field", async () => {
    const native = new FakeNativeModule();
    native.chunkExtra = { refreshToken: "synthetic-secret" };
    install(native);
    const client = create();
    const response = await client.fetch("/v1/responses", { method: "POST", latchwayFeature: "chat" });
    await expect(response.text()).rejects.toMatchObject({ code: "protocol_response_invalid" });
    expect(native.closeCalls).toHaveLength(1);
  });

  it("keeps independent disposable native leases on the same shared account", async () => {
    const native = new FakeNativeModule();
    install(native);
    const first = create();
    const second = create();
    await Promise.all([first.ready, second.ready]);
    expect(native.configureCalls).toBe(2);
    await first.dispose();
    expect(native.disposeCalls).toBe(1);
    await second.dispose();
    expect(native.disposeCalls).toBe(2);
  });

  it("fails closed on a native contract mismatch and disposes partial state", async () => {
    const native = new FakeNativeModule();
    native.compatibility = { contractVersion: "9.9.9" };
    install(native);
    const client = create();
    await expect(client.ready).rejects.toMatchObject({ code: "protocol_response_invalid" });
    expect(native.disposeCalls).toBe(0);
  });

  it("fails closed if native compatibility metadata contains credential fields", async () => {
    const native = new FakeNativeModule();
    native.compatibility = { accessToken: "synthetic-secret" };
    install(native);
    const client = create();
    await expect(client.ready).rejects.toMatchObject({
      code: "protocol_response_invalid",
      message: "Latchway native output crossed the credential boundary.",
    });
    expect(native.disposeCalls).toBe(0);
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
      contractVersion: "1.1.0",
      protocolVersion: 3,
      keyStorage: "secure_enclave",
      session: { state: "active" },
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|proof|evidence|private/iu);
  });

  it("opens an account-bound delegated component without root credentials", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = createComponent();

    await client.ready;
    const diagnostics = await client.diagnostics();

    expect(native.componentConfigureInputs).toHaveLength(1);
    const configured = native.componentConfigureInputs[0];
    expect(JSON.parse(configured?.componentJSON ?? "null")).toEqual(DIRECT_COMPONENT);
    expect(configured?.configurationJSON).not.toMatch(/identity|token|evidence|proof|client.?data|request.?hash/iu);
    expect(diagnostics).toEqual({
      familyID: "fam_0000000000000001",
      componentID: "cmp_0000000000000001",
      definitionID: DIRECT_COMPONENT.definitionID,
      keychainAccessGroup: DIRECT_COMPONENT.keychainAccessGroup,
      keyAvailable: true,
      keyStorage: "secure_enclave",
      grantAvailable: true,
      sessionAvailable: true,
      trustSource: "delegated_direct_attested",
      trustExpiresAt: "2026-08-28T00:00:00Z",
      containingAppActionRequired: false,
    });
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|proof|evidence|private|client.?data|request.?hash/iu);
  });

  it("exports only a captured component handoff and permits a later generation to open independently", async () => {
    const native = new FakeNativeModule();
    install(native);
    const root = create();
    const account = await root.componentAccount();
    expect(account).toBe(componentOptions().account);
    const first = createComponent();
    await first.ready;
    const second = createLatchwayComponentClient({...componentOptions(), account: btoa(JSON.stringify({
      generationID: "41fa3a6c-c52e-4a51-a42e-77dc1949aada", appScope: "a".repeat(64), accountScope: "b".repeat(64),
    }))});
    componentClients.push(second);
    await second.ready;
    expect(native.componentConfigureInputs).toHaveLength(2);
    expect(native.componentConfigureInputs[0]?.configurationJSON).not.toContain("rootKeychainAccessGroup");
    await first.dispose();
    expect((await second.diagnostics()).grantAvailable).toBe(true);
  });

  it("requires an account-bound component configuration with no legacy root options", () => {
    for (const account of ["", "not base64", "a".repeat(4097)]) {
      expect(() => createLatchwayComponentClient({...componentOptions(), account}))
        .toThrow(expect.objectContaining({code: "client_configuration_invalid"}));
    }
    expect(() => createLatchwayComponentClient({...componentOptions(), apple: {rootKeychainAccessGroup: "TEAM.root"}} as never))
      .toThrow(expect.objectContaining({code: "client_configuration_invalid"}));
  });

  it("rejects malformed or evidence-bearing component descriptors before native dispatch", async () => {
    const native = new FakeNativeModule();
    install(native);
    const invalid = [
      { ...DIRECT_COMPONENT, kind: "watch_extension" },
      { ...DIRECT_COMPONENT, keychainAccessGroup: "$(AppIdentifierPrefix).unsafe" },
      { ...DIRECT_COMPONENT, requestedFeatures: ["habit_assistant", "habit_assistant"] },
      { ...DIRECT_COMPONENT, attestationEvidence: "synthetic" },
    ];

    for (const component of invalid) {
      expect(() => createLatchwayComponentClient(componentOptions(component as never))).toThrowError(
        expect.objectContaining({ code: "client_configuration_invalid" }),
      );
    }
    expect(native.componentConfigureInputs).toHaveLength(0);
  });

  it("fails closed if component diagnostics contain credential material", async () => {
    const native = new FakeNativeModule();
    native.componentDiagnosticsExtra = { attestationEvidence: "synthetic-secret" };
    install(native);
    const client = createComponent();
    await expect(client.diagnostics()).rejects.toMatchObject({
      code: "protocol_response_invalid",
      message: "Latchway native output crossed the credential boundary.",
    });
  });

  it("preserves Android's explicit unsupported component-client failure", async () => {
    const native = new FakeNativeModule();
    native.componentConfigureError = Object.assign(new Error("unsupported"), {
      code: "attestation_unsupported",
    });
    install(native);
    const client = createComponent();
    await expect(client.ready).rejects.toMatchObject({ code: "attestation_unsupported" });
  });

  it("FW-BEH-107 redacts native errors without logging credential material", async () => {
    const logSpies = (["debug", "info", "log", "warn", "error"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined));
    const native = new FakeNativeModule();
    const secret = `identity_token eyJ${"a".repeat(80)}`;
    native.error = Object.assign(new Error(secret), {
      code: "operation_indeterminate",
      userInfo: {
        code: "operation_indeterminate",
        requestID: REQUEST_ID,
        operationID: OPERATION_ID,
        status: 503,
        retryable: true,
        documentationURL: "https://docs.latchway.dev/errors/operation-indeterminate",
      },
    });
    install(native);
    const client = create();
    try {
      let captured: unknown;
      try {
        await client.quota("chat");
      } catch (error) {
        captured = error;
      }
      expect(captured).toMatchObject({
        code: "operation_indeterminate",
        requestID: REQUEST_ID,
        operationID: OPERATION_ID,
        status: 503,
        retryable: true,
        message: "Sensitive native error detail was redacted.",
      });
      expect(`${String(captured)}\n${JSON.stringify(captured)}`).not.toContain(secret);
      for (const spy of logSpies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of logSpies) spy.mockRestore();
    }
  });

  it("fails closed on missing or mismatched native server documentation URLs", () => {
    const canonical = {
      code: "session_expired",
      requestID: REQUEST_ID,
      status: 401,
      retryable: true,
      documentationURL: "https://docs.latchway.dev/errors/session-expired",
      message: "The session expired.",
    };
    expect(fromNativeError(canonical)).toMatchObject({ code: "session_expired" });
    expect(fromNativeError({ ...canonical, documentationURL: undefined })).toMatchObject({
      code: "protocol_response_invalid",
    });
    expect(fromNativeError({
      ...canonical,
      documentationURL: "https://malicious.invalid/session-expired",
    })).toMatchObject({ code: "protocol_response_invalid" });
  });

  it("preserves validated native error diagnostics and rejects invalid optional metadata", () => {
    const canonical = {
      code: "quota_exceeded", message: "The weekly total token allowance is exhausted.",
      userInfo: {
        code: "quota_exceeded", requestID: REQUEST_ID, status: 429, retryable: true,
        documentationURL: "https://docs.latchway.dev/errors/quota-exceeded",
        retryAfter: "2026-09-14T00:00:00Z", feature: "chat", title: "Quota exceeded",
        instance: `/requests/${REQUEST_ID}`, supportedProtocolVersions: [1, 2, 3],
        validationErrors: [{ path: "quota.total_tokens", message: "The limit is 1000000 tokens per user per week." }],
      },
    };
    expect(fromNativeError(canonical)).toMatchObject({
      code: "quota_exceeded", message: canonical.message, requestID: REQUEST_ID,
      retryAfter: canonical.userInfo.retryAfter, feature: "chat", title: "Quota exceeded",
      instance: canonical.userInfo.instance, supportedProtocolVersions: [1, 2, 3],
      validationErrors: canonical.userInfo.validationErrors,
    });
    for (const invalid of [
      { retryAfter: "tomorrow" }, { feature: "../secret" }, { supportedProtocolVersions: [3, 3] },
      { validationErrors: [{ path: 3, message: "bad" }] }, { instance: "bad uri" },
    ]) {
      expect(fromNativeError({ ...canonical, userInfo: { ...canonical.userInfo, ...invalid } }))
        .toMatchObject({ code: "protocol_response_invalid", requestID: REQUEST_ID, status: 429 });
    }
    expect(fromNativeError({ ...canonical, retryAfter: "2026-09-15T00:00:00Z" }))
      .toMatchObject({ code: "protocol_response_invalid" });
  });

  it("preserves every v1 family, component, framework, and transport native error code", () => {
    const v1Codes = [
      "installation_family_revoked",
      "installation_family_not_found",
      "component_definition_not_found",
      "component_not_configured",
      "component_not_provisioned",
      "component_revoked",
      "component_key_invalid",
      "component_key_replaced",
      "component_delegation_expired",
      "component_feature_not_granted",
      "component_parent_trust_expired",
      "component_direct_attestation_required",
      "containing_app_setup_required",
      "framework_integration_unsupported",
      "framework_version_unsupported",
      "transport_destination_not_allowed",
      "transport_request_not_replayable",
    ] as const satisfies readonly LatchwayErrorCode[];

    for (const code of v1Codes) {
      expect(fromNativeError({ code, message: `Synthetic ${code}` })).toMatchObject({ code });
    }
  });

  it("fails closed if a native rejection envelope contains credential fields", async () => {
    const native = new FakeNativeModule();
    native.error = Object.assign(new Error("synthetic failure"), {
      code: "network_unavailable",
      userInfo: { code: "network_unavailable", refreshToken: "synthetic-secret" },
    });
    install(native);
    const client = create();
    await expect(client.quota("chat")).rejects.toMatchObject({
      code: "protocol_response_invalid",
      message: "Latchway native output crossed the credential boundary.",
    });
  });

  it("supports explicit native session rotation without exposing credentials", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    await client.refresh();
    expect(native.refreshCalls).toBe(1);
    expect(native.lastIdentityToken).toBe(undefined);
  });

  it("prepares native iOS components with only a public descriptor crossing JavaScript", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();

    const diagnostics = await client.prepareComponents([APP_INTENT_COMPONENT]);

    expect(native.prepareComponentInputs).toHaveLength(1);
    expect(JSON.parse(native.prepareComponentInputs[0]?.componentsJSON ?? "null"))
      .toEqual([APP_INTENT_COMPONENT]);
    expect(native.prepareComponentInputs[0]?.identityToken).toBe(undefined);
    expect(diagnostics).toEqual([{
      familyID: "fam_0000000000000001",
      componentID: "cmp_0000000000000001",
      definitionID: APP_INTENT_COMPONENT.definitionID,
      keychainAccessGroup: APP_INTENT_COMPONENT.keychainAccessGroup,
      keyAvailable: true,
      keyStorage: "secure_enclave",
      grantAvailable: true,
      sessionAvailable: false,
      trustSource: "delegated_from_attested_root",
      trustExpiresAt: "2026-08-28T00:00:00Z",
      containingAppActionRequired: false,
    }]);
    expect(JSON.stringify(diagnostics)).not.toMatch(/token|proof|evidence|private|jwk/iu);
  });

  it("rejects unshared, duplicate, or evidence-bearing host component descriptors", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();

    await expect(client.prepareComponents([{
      ...APP_INTENT_COMPONENT,
      keychainAccessGroup: "ABCDE12345.com.example.app.unshared",
    }])).rejects.toMatchObject({ code: "client_configuration_invalid" });
    await expect(client.prepareComponents([APP_INTENT_COMPONENT, APP_INTENT_COMPONENT]))
      .rejects.toMatchObject({ code: "client_configuration_invalid" });
    await expect(client.prepareComponents([{
      ...APP_INTENT_COMPONENT,
      attestationEvidence: "synthetic",
    } as never])).rejects.toMatchObject({ code: "client_configuration_invalid" });
    expect(native.prepareComponentInputs).toHaveLength(0);
  });

  it("fails closed if prepared component diagnostics contain credential material", async () => {
    const native = new FakeNativeModule();
    native.preparedComponentDiagnosticsExtra = { refreshToken: "synthetic-secret" };
    install(native);
    const client = create();

    await expect(client.prepareComponents([APP_INTENT_COMPONENT])).rejects.toMatchObject({
      code: "protocol_response_invalid",
      message: "Latchway native output crossed the credential boundary.",
    });
  });

  it("replaces one component through root identity and returns redacted diagnostics", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();

    const diagnostics = await client.replaceComponent(APP_INTENT_COMPONENT);

    expect(native.replaceComponentInputs).toEqual([{
      componentJSON: JSON.stringify(APP_INTENT_COMPONENT),
          }]);
    expect(diagnostics).toMatchObject({
      definitionID: APP_INTENT_COMPONENT.definitionID,
      keyStorage: "secure_enclave",
      trustSource: "delegated_from_attested_root",
    });
  });

  it("reads root-side component diagnostics without requesting identity", async () => {
    const native = new FakeNativeModule();
    install(native);
    const identity = vi.fn(async () => "unused-identity");
    const client = create({ getIdentityToken: identity });
    await client.ready;
    identity.mockClear();

    const diagnostics = await client.componentDiagnostics(APP_INTENT_COMPONENT);

    expect(identity).not.toHaveBeenCalled();
    expect(native.rootComponentDiagnosticsInputs).toEqual([
      JSON.stringify(APP_INTENT_COMPONENT),
    ]);
    expect(diagnostics.definitionID).toBe(APP_INTENT_COMPONENT.definitionID);
  });

  it("snapshots descriptors before asynchronous native component operations", async () => {
    for (const operation of ["prepare", "replace", "diagnostics"] as const) {
      const native = new FakeNativeModule();
      let release!: () => void;
      native.componentOperationGate = new Promise<void>((resolve) => { release = resolve; });
      install(native);
      const component: ReactNativeIOSComponent = {
        ...APP_INTENT_COMPONENT,
        requestedFeatures: [...APP_INTENT_COMPONENT.requestedFeatures],
      };
      const client = create();
      await client.ready;
      const result = operation === "prepare"
        ? client.prepareComponents([component])
        : operation === "replace"
          ? client.replaceComponent(component)
          : client.componentDiagnostics(component);
      component.definitionID = "mutated_definition";
      (component.requestedFeatures as string[])[0] = "mutated_feature";
      release();

      const diagnostics = await result;
      const first = Array.isArray(diagnostics) ? diagnostics[0] : diagnostics;
      expect(first?.definitionID, operation).toBe(APP_INTENT_COMPONENT.definitionID);
      restoreNative?.();
      restoreNative = undefined;
    }
  });

  it("rejects component descriptor batches larger than the native bridge limit", async () => {
    const native = new FakeNativeModule();
    install(native);
    const identity = vi.fn(async () => "unused-identity");
    const client = create({ getIdentityToken: identity });
    const features = Array.from({ length: 128 }, (_, index) => `feature_${index}`);
    const components: ReactNativeIOSComponent[] = Array.from({ length: 256 }, (_, index) => ({
      ...APP_INTENT_COMPONENT,
      definitionID: `app_intent_${index}`,
      requestedFeatures: features,
    }));

    await expect(client.prepareComponents(components)).rejects.toMatchObject({
      code: "client_configuration_invalid",
    });
    expect(native.prepareComponentInputs).toHaveLength(0);
    expect(identity).not.toHaveBeenCalled();
  });

  it("revokes one native iOS component through its exact public descriptor", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();

    await client.revokeComponent(APP_INTENT_COMPONENT);

    expect(native.revokeComponentInputs).toEqual([{
      componentJSON: JSON.stringify(APP_INTENT_COMPONENT),
          }]);
  });

  it("FW-AUTH-105 uses native durable component discovery for family revocation", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    await client.prepareComponents([APP_INTENT_COMPONENT]);
    await client.revokeCurrentInstallationFamily();
    expect(native.revokeFamilyCalls).toBe(1);
    expect(native.lastIdentityToken).toBe(undefined);
  });

  it("exports canonical HTTP problem conversion", async () => {
    const error = await errorFromResponse(new Response(JSON.stringify({
      type: "https://docs.latchway.dev/errors/operation-indeterminate",
      documentation_url: "https://docs.latchway.dev/errors/operation-indeterminate",
      title: "Operation outcome indeterminate",
      status: 503,
      detail: "The administrative operation outcome must be reconciled.",
      code: "operation_indeterminate",
      request_id: REQUEST_ID,
      retryable: true,
      operation_id: OPERATION_ID,
    }), {
      status: 503,
      headers: {
        "Content-Type": "application/problem+json",
        "X-Latchway-Request-ID": REQUEST_ID,
      },
    }));
    expect(error).toMatchObject({
      code: "operation_indeterminate",
      requestID: REQUEST_ID,
      operationID: OPERATION_ID,
      status: 503,
      retryable: true,
    });
  });

  it("serializes the exact root and current component Keychain groups to native", async () => {
    const native = new FakeNativeModule();
    install(native);
    const client = create();
    await client.ready;
    const apple = (JSON.parse(native.configureInputs[0] ?? "null") as {
      apple: Record<string, unknown>;
    }).apple;
    expect(apple).toMatchObject({
      rootKeychainAccessGroup: "ABCDE12345.com.example.app",
      sharedKeychainAccessGroups: ["ABCDE12345.com.example.app.shared"],
    });
  });

  it("consumes the pinned canonical protocol and cryptographic vectors", async () => {
    const fixtureRoot = new URL("fixtures/contract/", import.meta.url);
    const protocol = JSON.parse(await readFile(new URL("protocol-version.json", fixtureRoot), "utf8")) as ProtocolFixture;
    const dpop = JSON.parse(await readFile(new URL("dpop-v1.json", fixtureRoot), "utf8")) as DPoPFixture;
    const binding = JSON.parse(await readFile(new URL("attestation-binding-v1.json", fixtureRoot), "utf8")) as BindingFixture;
    const componentBinding = JSON.parse(
      await readFile(new URL("component-attestation-binding-v2.json", fixtureRoot), "utf8"),
    ) as ComponentBindingFixture;
    const family = JSON.parse(
      await readFile(new URL("installation-family-v2.json", fixtureRoot), "utf8"),
    ) as InstallationFamilyFixture;
    expect(protocol.contract_version).toBe("1.1.0");
    expect(protocol.contract_status).toBe("released");
    expect(protocol.wire_protocol.current).toBe(3);
    expect(protocol.wire_protocol.supported).toEqual([1, 2, 3]);
    expect(protocol.bundle.required_entries).toContain("component-attestation-binding.schema.json");
    expect(protocol.component_attestation_binding).toEqual({
      version: 2,
      purpose: "component_attestation_step_up",
      canonicalization: "RFC 8785 JCS",
      hash: "SHA-256",
    });
    expect(protocol.sdk_kinds).toContain("react-native");
    expect(dpop.vectors.filter((vector) => vector.expected.valid)).toHaveLength(3);
    expect(binding.vectors.map((vector) => vector.sha256_base64url))
      .toEqual(expect.arrayContaining([expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)]));
    expect(componentBinding).toMatchObject({
      contract_version: "1.0.0",
      binding_version: 2,
      canonicalization: "RFC 8785 JCS",
      hash: "SHA-256",
    });
    expect(componentBinding.vectors).toHaveLength(1);
    const componentVector = componentBinding.vectors.at(0);
    if (componentVector === undefined) throw new Error("missing component attestation binding vector");
    expect(componentVector.id).toBe("ios_action_extension_app_attest");
    expect(componentVector.input).toEqual({
      version: 2,
      purpose: "component_attestation_step_up",
      component_definition_id: "action_extension",
      platform: "ios",
      challenge_id: "chl_01J00000000000000000000003",
      challenge_nonce: "IiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiIiI",
      application_id: "app_habitify",
      environment: "production",
      principal_id: "usr_01J00000000000000000000000",
      installation_family_id: "fam_01J00000000000000000000000",
      client_component_id: "cmp_01J00000000000000000000003",
      component_key_id: "cky_01J00000000000000000000003",
      dpop_jkt: "bX0yCl562RPdpf8cJHVLBeUXu6PWExYJ0w-Bydre3q8",
      issued_at: 1787820003,
    });
    expect(componentVector.sha256_hex)
      .toBe("531faf52c337ce4d1eb9e10c702ca282b713e7a0556e8200c44362d6299c9c18");
    expect(componentVector.sha256_base64url).toBe("Ux-vUsM3zk0eueEMcCyigrcT56BVboIAxENi1imcnBg");
    expect(Buffer.from(componentVector.utf8_hex, "hex").toString("utf8"))
      .toBe(componentVector.canonical_json);
    expect(createHash("sha256").update(componentVector.canonical_json).digest("hex"))
      .toBe(componentVector.sha256_hex);
    expect(createHash("sha256").update(componentVector.canonical_json).digest("base64url"))
      .toBe(componentVector.sha256_base64url);
    expect(family).toMatchObject({
      contract_version: "1.0.0",
      wire_protocol_version: 2,
      family: { status: "active" },
      root_component: { is_root: true },
    });
    expect(family.root_session_claims).toMatchObject({
      installation_family_id: family.family.id,
      component_id: family.root_component.id,
      features: family.root_component.granted_features,
      trust: { source: "direct_attested" },
    });
    expect(family.root_session_claims).not.toHaveProperty("installation_id");
    expect(family.provisioned_components.every(
      (component) => component.response.installation_family_id === family.family.id,
    )).toBe(true);
    expect(family.provisioned_components.every((component) =>
      component.expected_session_claims.component_id === component.response.component_id &&
      JSON.stringify(component.expected_session_claims.features) ===
        JSON.stringify(component.response.granted_features) &&
      component.expected_session_claims.trust.source === "delegated_from_attested_root" &&
      component.expected_session_claims.trust.parent_component_id === family.root_component.id &&
      !("installation_id" in component.expected_session_claims),
    )).toBe(true);
    expect(family.revocations.map((revocation) => revocation.scope)).toEqual(["component", "family"]);
  });
});

function install(native: FakeNativeModule): void {
  restoreNative = installNativeModuleForTesting(native);
}

function create(overrides: Partial<LatchwayAppOptions & {getIdentityToken?: () => Promise<string>}> = {}): LatchwayClient {
  const client = sharedFixtureClient(baseOptions(overrides));
  clients.push(client);
  return client;
}

function createComponent(): LatchwayComponentClient {
  const client = createLatchwayComponentClient(componentOptions());
  componentClients.push(client);
  return client;
}

function componentOptions(
  component: typeof DIRECT_COMPONENT = DIRECT_COMPONENT,
): Parameters<typeof createLatchwayComponentClient>[0] {
  return {
    baseURL: "https://gateway.example.test",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    component,
    account: btoa(JSON.stringify({ generationID: sharedDescriptor.generationID, appScope: "a".repeat(64), accountScope: "b".repeat(64) })),
  };
}

function baseOptions(
  overrides: Partial<LatchwayAppOptions & {getIdentityToken?: () => Promise<string>}> = {},
): LatchwayAppOptions & {getIdentityToken?: () => Promise<string>} {
  return {
    baseURL: "https://gateway.example.test",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    apple: {
      rootKeychainAccessGroup: "ABCDE12345.com.example.app",
      sharedKeychainAccessGroups: ["ABCDE12345.com.example.app.shared"],
    },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "getIdentityToken")),
  };
}

function decodeBase64(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return new TextDecoder().decode(Uint8Array.from(atob(value), (character) => character.charCodeAt(0)));
}

class FakeNativeModule {
  async appCommand(encoded: string): Promise<string> {
    const input = JSON.parse(encoded) as Record<string, unknown>;
    if (input.operation === "configure") { this.configureInputs.push(encoded); this.configureCalls++; }
    if (input.operation === "componentAccount") return JSON.stringify({account: componentOptions().account});
    return JSON.stringify({...sharedDescriptor, ...this.compatibility});
  }
  configureCalls = 0;
  disposeCalls = 0;
  refreshCalls = 0;
  revokeFamilyCalls = 0;
  readCalls = 0;
  lastIdentityToken: string | undefined;
  error: Error | undefined;
  startGate: Promise<string> | undefined;
  readGate: Promise<void> | undefined;
  metadataExtra: Record<string, unknown> = {};
  chunkExtra: Record<string, unknown> = {};
  componentDiagnosticsExtra: Record<string, unknown> = {};
  preparedComponentDiagnosticsExtra: Record<string, unknown> = {};
  componentOperationGate: Promise<void> | undefined;
  readonly requests: NativeRequestRecord[] = [];
  componentConfigureError: Error | undefined;
  readonly componentConfigureInputs: Array<{ configurationJSON: string; componentJSON: string }> = [];
  readonly prepareComponentInputs: Array<{ componentsJSON: string; identityToken?: never }> = [];
  readonly replaceComponentInputs: Array<{ componentJSON: string; identityToken?: never }> = [];
  readonly rootComponentDiagnosticsInputs: string[] = [];
  readonly revokeComponentInputs: Array<{ componentJSON: string; identityToken?: never }> = [];
  readonly configureInputs: string[] = [];
  readonly configuredComponents = new Map<string, typeof DIRECT_COMPONENT>();
  readonly cancelCalls: string[] = [];
  readonly closeCalls: string[] = [];
  readonly responses: ResponseFixture[] = [];
  readonly active = new Map<string, { chunks: string[] }>();
  compatibility: Partial<{
    platform: string;
    nativeSDKVersion: string;
    contractVersion: string;
    protocolVersion: number;
    accessToken: string;
  }> = {};
  private nextResponse = 1;

  async configureComponent(
    clientID: string,
    configurationJSON: string,
    componentJSON: string,
  ): Promise<string> {
    if (this.componentConfigureError !== undefined) throw this.componentConfigureError;
    const config = JSON.parse(configurationJSON) as { contractVersion: string; protocolVersion: number };
    const component = JSON.parse(componentJSON) as typeof DIRECT_COMPONENT;
    this.componentConfigureInputs.push({ configurationJSON, componentJSON });
    this.configuredComponents.set(clientID, component);
    return JSON.stringify({
      platform: "react_native_ios",
      nativeSDKVersion: "1.0.0",
      nativeAppABI: 3,
      contractVersion: config.contractVersion,
      protocolVersion: config.protocolVersion,
    });
  }

  async startRequest(
    _clientID: string,
    operationID: string,
    encoded: string,
  ): Promise<string> {
    const request = JSON.parse(encoded) as NativeRequestRecord["request"];
    this.requests.push({ encoded, operationID, request });
    if (this.error !== undefined) throw this.error;
    if (this.startGate !== undefined) return this.startGate;
    const fixture = this.responses.shift() ?? {};
    const responseID = `rsp_${String(this.nextResponse++).padStart(16, "0")}`;
    this.active.set(responseID, { chunks: [...(fixture.chunks ?? ["ok"])] });
    return JSON.stringify({
      responseID,
      status: fixture.status ?? 200,
      statusText: fixture.statusText ?? "",
      headers: fixture.headers ?? [["content-type", "text/plain"]],
      ...this.metadataExtra,
    });
  }

  async readResponseChunk(
    _clientID: string,
    _operationID: string,
    responseID: string,
    _maximumBytes: number,
  ): Promise<string> {
    this.readCalls += 1;
    if (this.error !== undefined) throw this.error;
    if (this.readGate !== undefined) await this.readGate;
    const response = this.active.get(responseID);
    if (response === undefined) throw Object.assign(new Error("missing response"), { code: "request_invalid" });
    const chunk = response.chunks.shift();
    if (chunk === undefined) return JSON.stringify({ done: true, ...this.chunkExtra });
    return JSON.stringify({ done: false, chunk: bytesToBase64(new TextEncoder().encode(chunk)), ...this.chunkExtra });
  }

  async closeResponse(_clientID: string, responseID: string): Promise<void> {
    this.closeCalls.push(responseID);
    this.active.delete(responseID);
  }

  async refresh(_clientID: string, _operationID: string): Promise<void> {
    this.refreshCalls += 1;
    if (this.error !== undefined) throw this.error;
  }

  async quota(_clientID: string, _operationID: string, feature: string): Promise<string> {
    if (this.error !== undefined) throw this.error;
    return JSON.stringify({
      feature,
      observed_at: "2026-08-27T00:00:00Z",
      limits: [{ metric: "requests", maximum: 10, remaining: 9, hard: true }],
    });
  }

  async diagnostics(_clientID: string, _operationID: string): Promise<string> {
    if (this.error !== undefined) throw this.error;
    return JSON.stringify({
      contractVersion: "1.1.0",
      protocolVersion: 3,
      keyStorage: "secure_enclave",
      attestation: { support: "supported", provider: "app_attest", trustLevel: "device_verified" },
      session: { state: "active", expiresAt: "2026-08-28T00:00:00Z", refreshAvailable: true },
      installation: { id: "ins_0000000000000001", status: "active" },
      server: { version: "1.0.0", lastRequestID: REQUEST_ID },
    });
  }

  async componentDiagnostics(
    clientID: string,
    _operationID: string,
  ): Promise<string> {
    if (this.error !== undefined) throw this.error;
    const component = this.configuredComponents.get(clientID);
    if (component === undefined) throw new Error("component client is not configured");
    return JSON.stringify({
      familyID: "fam_0000000000000001",
      componentID: "cmp_0000000000000001",
      definitionID: component.definitionID,
      keychainAccessGroup: component.keychainAccessGroup,
      keyAvailable: true,
      keyStorage: "secure_enclave",
      grantAvailable: true,
      sessionAvailable: true,
      trustSource: "delegated_direct_attested",
      trustExpiresAt: "2026-08-28T00:00:00Z",
      containingAppActionRequired: false,
      ...this.componentDiagnosticsExtra,
    });
  }

  async prepareComponents(
    _clientID: string,
    _operationID: string,
    componentsJSON: string,
  ): Promise<string> {
    if (this.error !== undefined) throw this.error;
    this.prepareComponentInputs.push({ componentsJSON });
    if (this.componentOperationGate !== undefined) await this.componentOperationGate;
    const components = JSON.parse(componentsJSON) as Array<typeof APP_INTENT_COMPONENT>;
    return JSON.stringify({
      components: components.map((component) => ({
        familyID: "fam_0000000000000001",
        componentID: "cmp_0000000000000001",
        definitionID: component.definitionID,
        keychainAccessGroup: component.keychainAccessGroup,
        keyAvailable: true,
        keyStorage: "secure_enclave",
        grantAvailable: true,
        sessionAvailable: false,
        trustSource: "delegated_from_attested_root",
        trustExpiresAt: "2026-08-28T00:00:00Z",
        containingAppActionRequired: false,
        ...this.preparedComponentDiagnosticsExtra,
      })),
    });
  }

  async revokeComponent(
    _clientID: string,
    _operationID: string,
    componentJSON: string,
  ): Promise<void> {
    if (this.error !== undefined) throw this.error;
    this.revokeComponentInputs.push({ componentJSON });
  }

  async replaceComponent(
    _clientID: string,
    _operationID: string,
    componentJSON: string,
  ): Promise<string> {
    if (this.error !== undefined) throw this.error;
    this.replaceComponentInputs.push({ componentJSON });
    if (this.componentOperationGate !== undefined) await this.componentOperationGate;
    const component = JSON.parse(componentJSON) as typeof APP_INTENT_COMPONENT;
    return JSON.stringify(componentDiagnosticsFixture(component, this.preparedComponentDiagnosticsExtra));
  }

  async rootComponentDiagnostics(
    _clientID: string,
    _operationID: string,
    componentJSON: string,
  ): Promise<string> {
    if (this.error !== undefined) throw this.error;
    this.rootComponentDiagnosticsInputs.push(componentJSON);
    if (this.componentOperationGate !== undefined) await this.componentOperationGate;
    const component = JSON.parse(componentJSON) as typeof APP_INTENT_COMPONENT;
    return JSON.stringify(componentDiagnosticsFixture(component, this.preparedComponentDiagnosticsExtra));
  }

  async revoke(_clientID: string, _operationID: string): Promise<void> {
    if (this.error !== undefined) throw this.error;
  }

  async revokeFamily(_clientID: string, _operationID: string): Promise<void> {
    this.revokeFamilyCalls += 1;
    if (this.error !== undefined) throw this.error;
  }

  cancel(_clientID: string, operationID: string): void {
    this.cancelCalls.push(operationID);
  }

  async dispose(_clientID: string): Promise<void> {
    this.disposeCalls += 1;
    this.active.clear();
    this.configuredComponents.delete(_clientID);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function componentDiagnosticsFixture(
  component: typeof APP_INTENT_COMPONENT,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    familyID: "fam_0000000000000001",
    componentID: "cmp_0000000000000001",
    definitionID: component.definitionID,
    keychainAccessGroup: component.keychainAccessGroup,
    keyAvailable: true,
    keyStorage: "secure_enclave",
    grantAvailable: true,
    sessionAvailable: false,
    trustSource: "delegated_from_attested_root",
    trustExpiresAt: "2026-08-28T00:00:00Z",
    containingAppActionRequired: false,
    ...extra,
  };
}
