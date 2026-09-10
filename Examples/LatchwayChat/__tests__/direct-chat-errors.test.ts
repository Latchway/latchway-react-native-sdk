import {ReadableStream} from 'node:stream/web';
import {TextDecoder, TextEncoder} from 'node:util';
import type {LatchwayClient} from '@latchway/react-native';
import {directTurn} from '../src/chat';

jest.mock('@latchway/langchain', () => ({}), {virtual: true});
jest.mock('@langchain/core/messages', () => ({}), {virtual: true});
jest.mock('@langchain/core/tools', () => ({}), {virtual: true});
jest.mock('../src/config', () => ({config: {directFeature: 'chat'}}));

Object.assign(globalThis, {TextDecoder, TextEncoder});

function fixture(text: string, status = 200, readFailure = false) {
  let sent = false;
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: {get: (name: string) => name.toLowerCase() === 'x-latchway-request-id'
      ? 'req_12345678' : name.toLowerCase() === 'content-type'
        ? (status >= 400 ? 'application/problem+json' : 'text/event-stream') : null},
    body: new ReadableStream<Uint8Array>({pull(controller) {
      if (sent) {
        if (readFailure) controller.error(new Error('private native transport detail'));
        else controller.close();
      } else {
        sent = true;
        controller.enqueue(new TextEncoder().encode(text));
      }
    }}),
  } as unknown as Response;
  const fetch = jest.fn().mockResolvedValue(response);
  const client = {gatewayURL: 'https://gateway.example.test', fetchFor: () => fetch} as unknown as LatchwayClient;
  return {fetch, turn: () => directTurn(client, [], 'hello', new AbortController().signal, () => {})};
}

test('reads canonical non-success detail and validation fields instead of discarding the body', async () => {
  const problem = {
    type: 'https://docs.latchway.dev/errors/request-invalid',
    documentation_url: 'https://docs.latchway.dev/errors/request-invalid',
    title: 'Invalid request', status: 400, code: 'request_invalid', retryable: false,
    detail: 'Function tool parameters must be an object.', request_id: 'req_12345678',
    errors: [{path: 'tools[0].function.parameters', message: 'Must be an object.'}],
  };
  const f = fixture(JSON.stringify(problem), 400);
  await expect(f.turn()).rejects.toMatchObject({
    code: 'request_invalid', message: problem.detail, requestID: 'req_12345678',
    validationErrors: problem.errors,
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test.each([
  'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n',
  'data: {"error":{"message":"private provider failure"}}\n\ndata: [DONE]\n\n',
  'data: invalid JSON\n\n',
])('rejects partial, failed and malformed streams with request correlation', async text => {
  const f = fixture(text);
  await expect(f.turn()).rejects.toMatchObject({
    code: 'upstream_protocol_error', requestID: 'req_12345678', status: 200, retryable: false,
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('preserves correlation if the response reader fails after partial output', async () => {
  const f = fixture('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n', 200, true);
  await expect(f.turn()).rejects.toMatchObject({
    code: 'network_error', requestID: 'req_12345678', status: 200, retryable: false,
    message: 'The response stream was interrupted before completion.',
  });
  expect(f.fetch).toHaveBeenCalledTimes(1);
});

test('accepts complete direct chat and retains its request ID', async () => {
  const f = fixture('data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n');
  await expect(f.turn()).resolves.toMatchObject({text: 'hello', requestIDs: ['req_12345678']});
});
