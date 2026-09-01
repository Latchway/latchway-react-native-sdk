import { readFile } from "node:fs/promises";
import OpenAI from "openai";
import { generateText } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FRAMEWORK_CASES,
  REACT_NATIVE_FRAMEWORK_CASES,
  assertFrameworkCaseCoverage,
  frameworkCaseTitle,
  reactNativeFrameworkCaseTitle,
  type FrameworkCaseID,
  type ReactNativeFrameworkCaseID,
} from "../Conformance/framework/cases.js";
import {
  NativeFrameworkGateway,
  chatReply,
  latchwayProblem,
  providerError,
  responsesReply,
  streamingChatReply,
} from "../Conformance/framework/native-gateway.js";
import {
  createFrameworkConsumers,
  runFrameworkConsumerSmoke,
} from "../example/src/framework-consumers.js";
import { createLatchwayClient, type LatchwayClient } from "../src/index.js";
import { installNativeModuleForTesting } from "../src/testing.js";

const FEATURE = "habit_assistant";
const FRAMEWORK_FEATURES = {
  responses: "habit_responses",
  chat: "habit_chat",
  embeddings: "habit_embeddings",
  anthropic: "habit_anthropic",
} as const;
const GATEWAY = "https://gateway.example.test";
const IDENTITY_TOKEN = "fixture-identity-token-never-returned";
const MANAGED_PLACEHOLDER = "latchway-managed-not-a-provider-secret";
const REQUEST_ID = "req_framework_case_123";

const implementedCaseIDs = new Set<FrameworkCaseID>([
  "FW-AUTH-001",
  "FW-REQ-001",
  "FW-REQ-002",
  "FW-REQ-003",
  "FW-REQ-004",
  "FW-REQ-005",
  "FW-REQ-006",
  "FW-REQ-007",
  "FW-BEH-001",
  "FW-BEH-002",
  "FW-BEH-003",
  "FW-BEH-004",
  "FW-BEH-005",
  "FW-BEH-006",
  "FW-SEC-001",
  "FW-SEC-002",
  "FW-SEC-003",
  "FW-SEC-004",
]);

const implementedReactNativeCaseIDs = new Set<ReactNativeFrameworkCaseID>([
  "RN-FW-REFRESH-001",
  "RN-FW-ANTHROPIC-001",
  "RN-FW-OPAQUE-001",
  "RN-FW-CONSUMER-001",
]);

const clients: LatchwayClient[] = [];
let restoreNative: (() => void) | undefined;

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => { await client.dispose(); }));
  restoreNative?.();
  restoreNative = undefined;
  vi.unstubAllGlobals();
});

describe("React Native framework conformance", () => {
  it("registers every stable react-native-fetch case exactly once", () => {
    expect(() => assertFrameworkCaseCoverage(implementedCaseIDs)).not.toThrow();
    expect(new Set(FRAMEWORK_CASES.map(({ id }) => id))).toEqual(implementedCaseIDs);
    expect(new Set(REACT_NATIVE_FRAMEWORK_CASES.map(({ id }) => id))).toEqual(
      implementedReactNativeCaseIDs,
    );
  });

  it("requires one configured feature for each framework protocol", () => {
    const gateway = new NativeFrameworkGateway();
    expect(() => createFrameworkConsumers(install(gateway), {
      responses: FEATURE,
      chat: FEATURE,
      embeddings: FEATURE,
      anthropic: FEATURE,
    })).toThrow("Framework protocol features must be distinct.");
    expect(gateway.requests).toHaveLength(0);
  });

  it(frameworkCaseTitle("FW-AUTH-001"), async () => {
    const fixture = await readJSON<FrameworkRegistryFixture>(
      new URL("../Conformance/framework/react-native-fetch.json", import.meta.url),
    );
    const rootPackage = await readJSON<PackageFixture>(new URL("../package.json", import.meta.url));
    const examplePackage = await readJSON<PackageFixture>(new URL("../example/package.json", import.meta.url));
    const gateway = new NativeFrameworkGateway();
    const client = install(gateway);
    await client.ready;
    const response = await client.fetchFor(FEATURE)(`${GATEWAY}/v1/responses`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "latchway", input: "framework metadata" }),
    });
    await response.text();

    expect(fixture.registry).toMatchObject({
      id: "react-native-fetch",
      integration: "native_backed_fetch",
      support: "experimental",
      react_native: { minimum: "0.82.0", latest: "0.82.0" },
    });
    expect(fixture.case_ids).toEqual(FRAMEWORK_CASES.map(({ id }) => id));
    expect(fixture.rn_only.case_ids).toEqual(REACT_NATIVE_FRAMEWORK_CASES.map(({ id }) => id));
    expect(rootPackage.devDependencies).toMatchObject({
      "@ai-sdk/anthropic": fixture.rn_only.consumer_versions["vercel-ai-anthropic"],
      openai: fixture.consumer_versions["openai-js"],
      ai: fixture.consumer_versions["vercel-ai-sdk"],
      "@langchain/openai": fixture.consumer_versions["langchain-js"],
      "react-native": fixture.registry.react_native.latest,
    });
    expect(examplePackage.dependencies).toMatchObject({
      "@ai-sdk/anthropic": fixture.rn_only.consumer_versions["vercel-ai-anthropic"],
      openai: fixture.consumer_versions["openai-js"],
      ai: fixture.consumer_versions["vercel-ai-sdk"],
      "@langchain/openai": fixture.consumer_versions["langchain-js"],
      "react-native": fixture.registry.react_native.latest,
    });
    expect(rootPackage.devDependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(examplePackage.dependencies?.["@anthropic-ai/sdk"]).toBeUndefined();
    expect(gateway.configureInputs[0]).toMatchObject({
      sdkVersion: "1.0.0",
      frameworkID: fixture.registry.id,
      frameworkVersion: fixture.registry.react_native.latest,
    });
    expect(gateway.requests[0]?.feature).toBe(FEATURE);
    expect(gateway.requests[0]?.headers.get("X-Latchway-Framework")).toBe(fixture.registry.id);
    expect(gateway.requests[0]?.headers.get("X-Latchway-Framework-Version")).toBe(
      fixture.registry.react_native.latest,
    );
    expect(client.gatewayURL).toBe(GATEWAY);
  });

  it(frameworkCaseTitle("FW-REQ-001"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const response = await consumers.openaiResponses.responses.create({ model: "latchway", input: "hello" });

    expect(response.output_text).toBe("hello from Latchway");
    expect(gateway.requests[0]?.url.pathname).toBe("/v1/responses");
    expect(gateway.requests[0]?.body).toMatchObject({ model: "latchway", input: "hello" });
  });

  it(frameworkCaseTitle("FW-REQ-002"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const response = await consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.choices[0]?.message.content).toBe("hello from Latchway");
    expect(gateway.requests[0]?.url.pathname).toBe("/v1/chat/completions");
    expect(gateway.requests[0]?.body.messages).toEqual([{ role: "user", content: "hello" }]);
  });

  it(frameworkCaseTitle("FW-REQ-003"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    await expect(consumers.langChainEmbeddings.embedQuery("hello")).resolves.toEqual([0.25, 0.75]);

    expect(gateway.requests[0]?.url.pathname).toBe("/v1/embeddings");
    expect(gateway.requests[0]?.body).toMatchObject({ input: "hello", model: "latchway" });
  });

  it(frameworkCaseTitle("FW-REQ-004"), async () => {
    const gateway = new NativeFrameworkGateway(() => {
      const reply = responsesReply();
      return {
        ...reply,
        headers: [...(reply.headers ?? []), ["x-request-id", "upstream_request_id"]],
      };
    });
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);
    const request = consumers.openaiResponses.responses.create({ model: "latchway", input: "hello" }, {
      headers: { "X-Application-Correlation": "safe-correlation" },
    });

    const { request_id: requestID } = await request.withResponse();

    expect(requestID).toBe(REQUEST_ID);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.requests[0]?.headers.get("x-application-correlation")).toBe("safe-correlation");
    expect(gateway.requests[0]?.feature).toBe(FRAMEWORK_FEATURES.responses);
  });

  it(frameworkCaseTitle("FW-REQ-005"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);
    const stream = await consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
      stream_options: { include_usage: true },
    });
    const output: string[] = [];
    let totalTokens: number | undefined;

    for await (const chunk of stream) {
      output.push(chunk.choices[0]?.delta.content ?? "");
      totalTokens = chunk.usage?.total_tokens ?? totalTokens;
    }

    expect(output.join("")).toBe("hello from Latchway");
    expect(totalTokens).toBe(3);
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it(frameworkCaseTitle("FW-REQ-006"), async () => {
    const gateway = new NativeFrameworkGateway(() => ({
      ...streamingChatReply(),
      chunks: [],
      pendingRead: true,
    }));
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);
    const controller = new AbortController();
    const stream = await consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }, { signal: controller.signal });
    const iterator = stream[Symbol.asyncIterator]();
    const pending = iterator.next();
    await vi.waitFor(() => { expect(gateway.requests).toHaveLength(1); });

    controller.abort();

    // OpenAI normalizes an aborted SSE iterator to terminal completion; the
    // transport-level assertion is the native cancellation operation below.
    await expect(pending).resolves.toMatchObject({ done: true });
    expect(gateway.cancelCalls).toHaveLength(1);
  });

  it(frameworkCaseTitle("FW-REQ-007"), async () => {
    const gateway = new NativeFrameworkGateway(() => ({
      ...responsesReply(),
      chunks: [],
      pendingRead: true,
    }));
    const client = install(gateway);
    const openai = new OpenAI({
      apiKey: MANAGED_PLACEHOLDER,
      baseURL: `${client.gatewayURL}/v1`,
      dangerouslyAllowBrowser: true,
      fetch: client.fetchFor(FEATURE),
      maxRetries: 0,
      timeout: 25,
    });

    const error = await captureError(openai.responses.create({
      model: "latchway",
      input: "timeout",
    }));

    expect(String(error)).toMatch(/timed out|abort/i);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.cancelCalls).toHaveLength(1);
  });

  it(frameworkCaseTitle("FW-BEH-001"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);
    const response = await consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "weather" }],
      tools: [{
        type: "function",
        function: {
          name: "lookup_weather",
          description: "Look up weather.",
          parameters: {
            type: "object",
            properties: { city: { type: "string" } },
            required: ["city"],
          },
        },
      }],
    });

    const toolCall = response.choices[0]?.message.tool_calls?.[0];
    expect(toolCall?.type).toBe("function");
    if (toolCall?.type !== "function") throw new Error("The framework response omitted its function call.");
    expect(toolCall.function).toMatchObject({
      name: "lookup_weather",
      arguments: JSON.stringify({ city: "Da Nang" }),
    });
    expect(gateway.requests[0]?.body.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "function" }),
    ]));
  });

  it(frameworkCaseTitle("FW-BEH-002"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);
    const response = await consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "summarize" }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "summary",
          strict: true,
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
        },
      },
    });
    const content = response.choices[0]?.message.content;

    expect(content).toBeDefined();
    expect(JSON.parse(content ?? "") as unknown).toEqual({ summary: "hello from Latchway" });
    expect(gateway.requests[0]?.body.response_format).toMatchObject({ type: "json_schema" });
  });

  it(frameworkCaseTitle("FW-BEH-003"), async () => {
    const gateway = new NativeFrameworkGateway(() => latchwayProblem("quota_exceeded"));
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const error = await captureError(consumers.openaiResponses.responses.create({ model: "latchway", input: "hello" }));

    expect(error).toMatchObject({ status: 429, requestID: REQUEST_ID });
    expect(String(error)).toContain("quota_exceeded");
  });

  it(frameworkCaseTitle("FW-BEH-004"), async () => {
    const gateway = new NativeFrameworkGateway(() => providerError());
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const error = await captureError(consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
    }));

    expect(error).toMatchObject({ status: 502, requestID: REQUEST_ID, code: "upstream_unavailable" });
    expect(String(error)).toContain("temporarily unavailable");
  });

  it(frameworkCaseTitle("FW-BEH-005"), async () => {
    const gateway = new NativeFrameworkGateway((_request, dispatch) =>
      dispatch === 1 ? latchwayProblem("upstream_unavailable") : chatReply());
    const client = install(gateway);
    const openai = new OpenAI({
      apiKey: MANAGED_PLACEHOLDER,
      baseURL: `${client.gatewayURL}/v1`,
      dangerouslyAllowBrowser: true,
      fetch: client.fetchFor(FEATURE),
      maxRetries: 1,
    });

    const response = await openai.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(response.choices[0]?.message.content).toBe("hello from Latchway");
    expect(gateway.requests).toHaveLength(2);
    expect(new Set(gateway.requests.map(({ operationID }) => operationID)).size).toBe(2);
  });

  it(frameworkCaseTitle("FW-BEH-006"), async () => {
    const gateway = new NativeFrameworkGateway();
    gateway.expireNativeSession();
    const getIdentityToken = vi.fn(async () => IDENTITY_TOKEN);
    const consumers = createFrameworkConsumers(
      install(gateway, getIdentityToken),
      FRAMEWORK_FEATURES,
    );

    const response = await consumers.openaiResponses.responses.create({
      model: "latchway",
      input: "recover before dispatch",
    });

    expect(response.output_text).toBe("hello from Latchway");
    expect(gateway.automaticRefreshCalls).toBe(1);
    expect(gateway.refreshCalls).toBe(0);
    expect(gateway.nativeSessionEvents).toEqual([
      "automatic-pre-dispatch-refresh",
      "data-plane-dispatch",
    ]);
    expect(gateway.requests).toHaveLength(1);
    expect(getIdentityToken).toHaveBeenCalledTimes(1);
  });

  it(reactNativeFrameworkCaseTitle("RN-FW-REFRESH-001"), async () => {
    const gateway = new NativeFrameworkGateway();
    const client = install(gateway);
    const consumers = createFrameworkConsumers(client, FRAMEWORK_FEATURES);

    await client.refresh();
    const response = await consumers.openaiChat.chat.completions.create({
      model: "latchway",
      messages: [{ role: "user", content: "after refresh" }],
    });

    expect(gateway.refreshCalls).toBe(1);
    expect(gateway.requests).toHaveLength(1);
    expect(response.choices[0]?.message.content).toBe("hello from Latchway");
  });

  it(frameworkCaseTitle("FW-SEC-001"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    await consumers.openaiResponses.responses.create({ model: "latchway", input: "hello" });

    expect(gateway.requests[0]?.headers.has("authorization")).toBe(false);
    expect(gateway.requests[0]?.headers.has("api-key")).toBe(false);
    expect(gateway.requests[0]?.encoded).not.toContain(MANAGED_PLACEHOLDER);
  });

  it(frameworkCaseTitle("FW-SEC-002"), async () => {
    const gateway = new NativeFrameworkGateway();
    const getIdentityToken = vi.fn(async () => IDENTITY_TOKEN);
    const client = install(gateway, getIdentityToken);

    await expect(client.fetchFor(FEATURE)("https://attacker.invalid/v1/responses", {
      method: "POST",
      body: "{}",
    })).rejects.toMatchObject({ code: "client_configuration_invalid" });
    await expect(client.fetchFor(FEATURE)(`${GATEWAY}/v1/files`, {
      method: "POST",
      body: "{}",
    })).rejects.toMatchObject({ code: "transport_destination_not_allowed" });

    expect(getIdentityToken).not.toHaveBeenCalled();
    expect(gateway.requests).toHaveLength(0);
  });

  it(frameworkCaseTitle("FW-SEC-003"), async () => {
    const gateway = new NativeFrameworkGateway(() => providerError());
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const error = await captureError(consumers.openaiResponses.responses.create({ model: "latchway", input: "hello" }));
    const serialized = safeSerialize(error);

    expect(serialized).not.toContain(MANAGED_PLACEHOLDER);
    expect(serialized).not.toContain(IDENTITY_TOKEN);
    expect(serialized).toContain(REQUEST_ID);
  });

  it(frameworkCaseTitle("FW-SEC-004"), async () => {
    const gateway = new NativeFrameworkGateway();
    const globalFetch = vi.fn(async () => new Response("global fetch must not run"));
    vi.stubGlobal("fetch", globalFetch);
    const client = install(gateway);
    const consumers = createFrameworkConsumers(client, FRAMEWORK_FEATURES);

    await consumers.openaiResponses.responses.create({ model: "latchway", input: "hello" });

    expect(globalFetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).toBe(globalFetch);
  });

  it(reactNativeFrameworkCaseTitle("RN-FW-ANTHROPIC-001"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const response = await generateText({
      maxOutputTokens: 64,
      maxRetries: 0,
      model: consumers.anthropic.messages("latchway"),
      prompt: "hello",
    });

    expect(response.text).toBe("hello from Latchway");
    expect(gateway.requests[0]?.url.pathname).toBe("/v1/messages");
    expect(gateway.requests[0]?.body).toMatchObject({
      max_tokens: 64,
      messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
      model: "latchway",
    });
    expect(gateway.requests[0]?.headers.has("x-api-key")).toBe(false);
    expect(gateway.requests[0]?.headers.get("anthropic-version")).toBeDefined();
  });

  it(reactNativeFrameworkCaseTitle("RN-FW-OPAQUE-001"), async () => {
    const gateway = new NativeFrameworkGateway(() => ({
      headers: [["content-type", "application/json"]],
      chunks: [JSON.stringify({ accepted: true })],
    }));
    const client = install(gateway);

    const response = await client.fetchFor(FEATURE)(`${GATEWAY}/proxy/${FEATURE}/vendor/messages`, {
      body: JSON.stringify({ prompt: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });

    await expect(response.json()).resolves.toEqual({ accepted: true });
    expect(gateway.requests[0]).toMatchObject({ feature: FEATURE, method: "POST" });
    expect(gateway.requests[0]?.url.pathname).toBe(`/proxy/${FEATURE}/vendor/messages`);
    expect(gateway.requests[0]?.body).toEqual({ prompt: "hello" });
  });

  it(reactNativeFrameworkCaseTitle("RN-FW-CONSUMER-001"), async () => {
    const gateway = new NativeFrameworkGateway();
    const consumers = createFrameworkConsumers(install(gateway), FRAMEWORK_FEATURES);

    const result = await runFrameworkConsumerSmoke(consumers, "hello");

    expect(result).toEqual({
      anthropic: "hello from Latchway",
      openaiResponses: "hello from Latchway",
      vercelAI: "hello from Latchway",
      langChain: "hello from Latchway",
      embeddingDimensions: 2,
    });
    expect(gateway.requests.map(({ url }) => url.pathname)).toEqual([
      "/v1/responses",
      "/v1/responses",
      "/v1/chat/completions",
      "/v1/embeddings",
      "/v1/messages",
    ]);
    expect(gateway.requests.map(({ feature }) => feature)).toEqual([
      FRAMEWORK_FEATURES.responses,
      FRAMEWORK_FEATURES.responses,
      FRAMEWORK_FEATURES.chat,
      FRAMEWORK_FEATURES.embeddings,
      FRAMEWORK_FEATURES.anthropic,
    ]);
  });
});

function install(
  gateway: NativeFrameworkGateway,
  getIdentityToken: () => Promise<string> = async () => IDENTITY_TOKEN,
): LatchwayClient {
  restoreNative = installNativeModuleForTesting(gateway);
  const client = createLatchwayClient({
    baseURL: GATEWAY,
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    getIdentityToken,
    apple: { rootKeychainAccessGroup: "ABCDE12345.dev.latchway.example" },
  });
  clients.push(client);
  return client;
}

async function captureError(operation: PromiseLike<unknown>): Promise<unknown> {
  try {
    await operation;
  } catch (error) {
    return error;
  }
  throw new Error("The framework request unexpectedly succeeded.");
}

async function readJSON<T>(url: URL): Promise<T> {
  return JSON.parse(await readFile(url, "utf8")) as T;
}

function safeSerialize(value: unknown): string {
  const seen = new WeakSet<object>();
  return `${String(value)} ${JSON.stringify(value, (_key, nested: unknown) => {
    if (typeof nested === "object" && nested !== null) {
      if (seen.has(nested)) return "[circular]";
      seen.add(nested);
    }
    return nested;
  })}`;
}

interface FrameworkRegistryFixture {
  registry: {
    id: string;
    integration: string;
    support: string;
    react_native: { minimum: string; latest: string };
  };
  consumer_versions: Record<"openai-js" | "vercel-ai-sdk" | "langchain-js", string>;
  rn_only: {
    consumer_versions: Record<"vercel-ai-anthropic", string>;
    case_ids: ReactNativeFrameworkCaseID[];
  };
  case_ids: FrameworkCaseID[];
}

interface PackageFixture {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
