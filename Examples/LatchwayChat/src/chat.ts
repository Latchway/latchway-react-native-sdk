import { bindLatchwayTools, createLatchwayResponsesModel, toLatchwayReplayMessage } from '@latchway/langchain';
import type { LatchwayClient } from '@latchway/react-native';
import {
  AIMessageChunk,
  BaseMessage,
  HumanMessage,
  SystemMessage,
} from '@langchain/core/messages';
import { tool } from '@langchain/core/tools';
import { config } from './config';
import { knowledge } from './knowledge';
import { checkWeather, weatherInput } from './weather';
import {modelOptions} from './model-options';

export type Mode = 'langchain' | 'direct';
export type ToolEvent = {
  city: string;
  state: 'running' | 'complete';
  summary?: string;
};
export type TurnResult = {
  text: string;
  messages: BaseMessage[];
  toolCalls: number;
  modelCalls: number;
  requestIDs: string[];
};
export const featureFor = (mode: Mode) =>
  mode === 'langchain' ? config.langchainFeature : config.directFeature;
export const textContent = (content: BaseMessage['content']): string =>
  typeof content === 'string'
    ? content
    : content
        .map(part =>
          part.type === 'text' && typeof part.text === 'string'
            ? part.text
            : '',
        )
        .join('');

export async function langchainTurn(
  client: LatchwayClient,
  history: BaseMessage[],
  prompt: string,
  signal: AbortSignal,
  onText: (text: string) => void,
  onTool: (event: ToolEvent) => void,
  onStage: (stage: string) => void = () => {},
): Promise<TurnResult> {
  let toolCalls = 0;
  const requestIDs: string[] = [];
  // Observe only redacted request IDs, without inspecting transport credentials or bodies.
  const transport = {
    gatewayURL: client.gatewayURL,
    fetchFor: (feature: string) => {
      const authenticatedFetch = client.fetchFor(feature);
      return async (input: RequestInfo | URL, init?: RequestInit) => {
        onStage('gateway-dispatch');
        const response = await authenticatedFetch(input, init);
        const id = response.headers.get('X-Latchway-Request-ID');
        if (id) requestIDs.push(id);
        return response;
      };
    },
  };
  onStage('tool-construction');
  const weather = tool(
    async args => {
      if (++toolCalls > 6) throw new Error('Weather lookup limit reached.');
      onTool({ city: args.city, state: 'running' });
      const result = await checkWeather(args, signal);
      onTool({
        city: args.city,
        state: 'complete',
        summary:
          result.location +
          ': ' +
          result.current.temperature_2m +
          '°C · Open-Meteo',
      });
      return JSON.stringify(result);
    },
    {
      name: 'weather_check',
      description:
        'Get real current weather and a three-day forecast for a city.',
      schema: weatherInput,
    },
  );

  onStage('model-construction');
  const rawModel = createLatchwayResponsesModel({
    latchway: transport,
    feature: config.langchainFeature,
    ...modelOptions,
  });
  onStage('tool-binding');
  const model = bindLatchwayTools(rawModel, [weather]);
  onStage('message-construction');
  const messages: BaseMessage[] = [
    new SystemMessage(knowledge),
    ...history,
    new HumanMessage(prompt),
  ];
  const additions = messages.slice(messages.length - 1);
  for (let modelCalls = 1; modelCalls <= 4; modelCalls++) {
    signal.throwIfAborted();
    let complete: AIMessageChunk | undefined;
    onStage('stream-open');
    const stream = await model.stream(messages, { signal });
    onStage('stream-read');
    for await (const chunk of stream) {
      signal.throwIfAborted();
      complete = complete ? complete.concat(chunk) : chunk;
      const text = textContent(complete.content);
      if (text.length > 64_000) throw new Error('Answer exceeds demo limit.');
      onText(text);
    }
    if (!complete || complete.invalid_tool_calls?.length)
      throw new Error('Invalid model response.');
    onStage('message-replay');
    const replay = toLatchwayReplayMessage(complete);
    messages.push(replay);
    additions.push(replay);
    const calls = complete.tool_calls ?? [];
    if (!calls.length) {
      const text = textContent(complete.content);
      if (!text.trim()) throw new Error('Model returned no answer.');
      return { text, messages: additions, toolCalls, modelCalls, requestIDs };
    }
    if (toolCalls + calls.length > 6 || modelCalls === 4)
      throw new Error('Tool loop limit reached.');
    for (const call of calls) {
      if (call.name !== weather.name || !call.id || call.id.length > 256)
        throw new Error('Unsupported tool call.');
      weatherInput.parse(call.args);
      // LangChain produces a ToolMessage correlated with the actual model-issued call ID.
      const result = await weather.invoke(
        { ...call, type: 'tool_call' },
        { signal },
      );
      messages.push(result);
      additions.push(result);
    }
  }
  throw new Error('Tool loop limit reached.');
}

export async function directTurn(
  client: LatchwayClient,
  history: { role: 'user' | 'assistant'; content: string }[],
  prompt: string,
  signal: AbortSignal,
  onText: (text: string) => void,
): Promise<TurnResult> {
  const response = await client.fetchFor(config.directFeature)(
    client.gatewayURL + '/v1/chat/completions',
    {
      method: 'POST',
      signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'latchway-managed',
        stream: true,
        max_tokens: 1024,
        messages: [
          {
            role: 'system',
            content:
              knowledge +
              '\nDirect fetch mode has no tools. Say live weather needs LangChain mode in Settings.',
          },
          ...history,
          { role: 'user', content: prompt },
        ],
      }),
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(
      'Gateway rejected chat (HTTP ' +
        response.status +
        '). Check connection diagnostics.',
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Streaming body is unavailable.');
  const decoder = new TextDecoder();
  let buffer = '',
    answer = '',
    bytes = 0,
    doneEvent = false;
  const consume = (event: string) => {
    const data = event
      .split('\n')
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trimStart())
      .join('\n');
    if (!data) return;
    if (data === '[DONE]') {
      doneEvent = true;
      return;
    }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error('Provider stream failed.');
    const text = chunk.choices?.[0]?.delta?.content;
    if (typeof text === 'string') {
      answer += text;
      onText(answer);
    }
    if (answer.length > 64_000) throw new Error('Answer exceeds demo limit.');
  };
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 2_000_000) throw new Error('Stream exceeds demo limit.');
      buffer += decoder.decode(part.value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 2);
      }
      if (buffer.length > 256_000) throw new Error('Event exceeds demo limit.');
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
    if (!doneEvent || !answer.trim())
      throw new Error('Stream ended before completion.');
    return {
      text: answer,
      messages: [],
      modelCalls: 1,
      toolCalls: 0,
      requestIDs: [response.headers.get('X-Latchway-Request-ID')].filter(
        (id): id is string => !!id,
      ),
    };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
