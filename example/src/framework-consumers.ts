import { createAnthropic, type AnthropicProvider } from "@ai-sdk/anthropic";
import { createOpenAI, type OpenAIProvider } from "@ai-sdk/openai";
import { ChatOpenAI, OpenAIEmbeddings } from "@langchain/openai";
import type { LatchwayClient } from "@latchway/react-native";
import { generateText } from "ai";
import OpenAI from "openai";

const managedPlaceholder = "latchway-managed-not-a-provider-secret";

export interface ReactNativeFrameworkConsumers {
  readonly anthropic: AnthropicProvider;
  readonly openai: OpenAI;
  readonly vercelAI: OpenAIProvider;
  readonly langChainChat: ChatOpenAI;
  readonly langChainEmbeddings: OpenAIEmbeddings;
}

export interface FrameworkSmokeResult {
  readonly anthropic: string;
  readonly openaiResponses: string;
  readonly vercelAI: string;
  readonly langChain: string;
  readonly embeddingDimensions: number;
}

/**
 * Real framework consumers over one native-backed, feature-bound fetch.
 * The value supplied as an API key only satisfies provider constructors; the
 * Latchway bridge removes it before native session acquisition or dispatch.
 */
export function createFrameworkConsumers(
  client: LatchwayClient,
  feature: string,
): ReactNativeFrameworkConsumers {
  const featureFetch = client.fetchFor(feature);
  const baseURL = `${client.gatewayURL}/v1`;
  return {
    anthropic: createAnthropic({
      apiKey: managedPlaceholder,
      baseURL,
      fetch: featureFetch,
      name: "latchway-anthropic",
    }),
    openai: new OpenAI({
      apiKey: managedPlaceholder,
      baseURL,
      dangerouslyAllowBrowser: true,
      fetch: featureFetch,
      maxRetries: 0,
    }),
    vercelAI: createOpenAI({
      apiKey: managedPlaceholder,
      baseURL,
      fetch: featureFetch,
      name: "latchway",
    }),
    langChainChat: new ChatOpenAI({
      apiKey: managedPlaceholder,
      configuration: { baseURL, fetch: featureFetch },
      maxRetries: 0,
      model: "latchway",
    }),
    langChainEmbeddings: new OpenAIEmbeddings({
      apiKey: managedPlaceholder,
      configuration: { baseURL, fetch: featureFetch },
      encodingFormat: "float",
      maxRetries: 0,
      model: "latchway",
    }),
  };
}

/** Runs one bounded request through every React Native-compatible pathway. */
export async function runFrameworkConsumerSmoke(
  consumers: ReactNativeFrameworkConsumers,
  prompt: string,
  signal?: AbortSignal,
): Promise<FrameworkSmokeResult> {
  const requestOptions = signal === undefined ? {} : { signal };
  const openai = await consumers.openai.responses.create({
    model: "latchway",
    input: prompt,
  }, requestOptions);
  const vercel = await generateText({
    model: consumers.vercelAI.responses("latchway"),
    prompt,
    ...(signal === undefined ? {} : { abortSignal: signal }),
  });
  const langChain = await consumers.langChainChat.invoke(prompt, requestOptions);
  const embedding = await consumers.langChainEmbeddings.embedQuery(prompt);
  const anthropic = await generateText({
    maxOutputTokens: 64,
    model: consumers.anthropic.messages("latchway"),
    prompt,
    ...(signal === undefined ? {} : { abortSignal: signal }),
  });
  return {
    anthropic: anthropic.text,
    openaiResponses: openai.output_text,
    vercelAI: vercel.text,
    langChain: typeof langChain.content === "string"
      ? langChain.content
      : JSON.stringify(langChain.content),
    embeddingDimensions: embedding.length,
  };
}

/** Pulls an actual OpenAI SDK SSE stream; abort propagates into native. */
export async function streamOpenAIChat(
  consumers: ReactNativeFrameworkConsumers,
  prompt: string,
  update: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const stream = await consumers.openai.chat.completions.create({
    model: "latchway",
    messages: [{ role: "user", content: prompt }],
    stream: true,
    stream_options: { include_usage: true },
  }, signal === undefined ? {} : { signal });
  let output = "";
  for await (const chunk of stream) {
    output += chunk.choices[0]?.delta.content ?? "";
    update(output);
  }
}
