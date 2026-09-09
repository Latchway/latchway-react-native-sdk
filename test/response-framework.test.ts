import { createRequire } from "node:module";
import { ChatOpenAI } from "@langchain/openai";
import OpenAI from "openai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  NativeFrameworkGateway,
  streamingChatReply,
  type NativeFrameworkReply,
} from "../Conformance/framework/native-gateway.js";
import { createLatchwayClient, type LatchwayClient } from "../src/index.js";
import { installNativeModuleForTesting } from "../src/testing.js";

const require = createRequire(import.meta.url);
const { Response: ReactNativeResponse } = require("whatwg-fetch") as { Response: typeof Response };
const REQUEST_ID = "req_framework_case_123";
const REPLY = "Xin chào 🌤️ — 東京";
const clients: LatchwayClient[] = [];
let restoreNative: (() => void) | undefined;

beforeEach(() => {
  vi.stubGlobal("Response", ReactNativeResponse);
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected JavaScript network request"); }));
});

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map(async (client) => { await client.dispose(); }));
  restoreNative?.();
  restoreNative = undefined;
  vi.unstubAllGlobals();
});

describe("OpenAI and LangChain with the real React Native Response implementation", () => {
  it("returns a successful nonstream OpenAI answer and request ID", async () => {
    const { gateway, openai } = install(jsonReply(chatCompletion()));
    const result = await openai.chat.completions.create({
      model: "latchway", messages: [{ role: "user", content: "hello" }],
    }).withResponse();

    expect(result.data.choices[0]?.message.content).toBe(REPLY);
    expect(result.request_id).toBe(REQUEST_ID);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it("returns a successful LangChain invoke answer using its default nonstream mode", async () => {
    const { gateway, langchain } = install(jsonReply(chatCompletion()));
    const result = await langchain.invoke("hello");

    expect(result.content).toBe(REPLY);
    expect(gateway.requests[0]?.body.stream).not.toBe(true);
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it.each([
    { status: 503, code: "upstream_unavailable", message: "The upstream is temporarily unavailable." },
    { status: 429, code: "quota_exceeded", message: "The configured daily quota has been reached." },
  ])("preserves OpenAI HTTP $status code, message, and gateway request ID", async ({ status, code, message }) => {
    const { gateway, openai } = install(jsonReply({ error: { code, message, type: "gateway_error" } }, status));
    const error = await captureError(openai.chat.completions.create({
      model: "latchway", messages: [{ role: "user", content: "hello" }],
    }));

    expect(error).toBeInstanceOf(OpenAI.APIError);
    expect(error).toMatchObject({ status, code, requestID: REQUEST_ID, error: { code, message } });
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain("[object ReadableStream]");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it.each([
    { status: 503, code: "upstream_unavailable", message: "The upstream is temporarily unavailable." },
    { status: 429, code: "quota_exceeded", message: "The configured daily quota has been reached." },
  ])("preserves LangChain HTTP $status code, message, and gateway request ID", async ({ status, code, message }) => {
    const { gateway, langchain } = install(jsonReply({ error: { code, message, type: "gateway_error" } }, status));
    const error = await captureError(langchain.invoke("hello"));

    expect(error).toMatchObject({ status, code, requestID: REQUEST_ID });
    expect(String(error)).toContain(message);
    expect(String(error)).not.toContain("[object ReadableStream]");
    expect(gateway.requests).toHaveLength(1);
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it("continues to support OpenAI SSE byte-stream consumption", async () => {
    const { gateway, openai } = install(streamingChatReply());
    const result = await openai.chat.completions.create({
      model: "latchway", messages: [{ role: "user", content: "hello" }], stream: true,
    });
    let output = "";
    for await (const chunk of result) output += chunk.choices[0]?.delta.content ?? "";

    expect(output).toBe("hello from Latchway");
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it("continues to support LangChain SSE byte-stream consumption", async () => {
    const { gateway, langchain } = install(streamingChatReply());
    let output = "";
    for await (const chunk of await langchain.stream("hello")) output += chunk.text;

    expect(output).toBe("hello from Latchway");
    expect(gateway.requests[0]?.body.stream).toBe(true);
    expect(gateway.closeCalls).toHaveLength(1);
  });

  it("preserves structured errors received after SSE headers", async () => {
    const { openai } = install({
      headers: [["content-type", "text/event-stream"], ["x-latchway-request-id", REQUEST_ID]],
      chunks: [`data: ${JSON.stringify({ error: {
        code: "upstream_unavailable", message: "The upstream stream was interrupted.",
      } })}\n\n`],
    });
    const stream = await openai.chat.completions.create({
      model: "latchway", messages: [{ role: "user", content: "hello" }], stream: true,
    });
    const error = await captureError((async () => {
      for await (const chunk of stream) void chunk;
    })());

    expect(error).toMatchObject({ code: "upstream_unavailable" });
    expect(String(error)).toContain("The upstream stream was interrupted.");
  });
});

function install(reply: NativeFrameworkReply): {
  gateway: NativeFrameworkGateway;
  openai: OpenAI;
  langchain: ChatOpenAI;
} {
  const gateway = new NativeFrameworkGateway(() => reply);
  restoreNative = installNativeModuleForTesting(gateway);
  const client = createLatchwayClient({
    baseURL: "https://gateway.example.test",
    applicationID: "app_01J00000000000000000000000",
    environment: "production",
    getIdentityToken: async () => "fixture-identity-token-never-returned",
    apple: { rootKeychainAccessGroup: "ABCDE12345.dev.latchway.example" },
  });
  clients.push(client);
  const configuration = {
    baseURL: `${client.gatewayURL}/v1`,
    fetch: client.fetchFor("habit_assistant"),
  };
  return {
    gateway,
    openai: new OpenAI({
      ...configuration, apiKey: "managed-fixture", maxRetries: 0, dangerouslyAllowBrowser: true,
    }),
    langchain: new ChatOpenAI({
      configuration, apiKey: "managed-fixture", maxRetries: 0, model: "latchway",
    }),
  };
}

function jsonReply(payload: unknown, status = 200): NativeFrameworkReply {
  return {
    status,
    headers: [["content-type", "application/json"], ["x-latchway-request-id", REQUEST_ID]],
    chunks: [JSON.stringify(payload)],
  };
}

function chatCompletion(): unknown {
  return {
    id: "chatcmpl_response_fixture", object: "chat.completion", created: 1, model: "latchway",
    choices: [{ index: 0, message: { role: "assistant", content: REPLY }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 7, total_tokens: 8 },
  };
}

async function captureError(operation: PromiseLike<unknown>): Promise<unknown> {
  try { await operation; } catch (error) { return error; }
  throw new Error("The framework request unexpectedly succeeded.");
}
