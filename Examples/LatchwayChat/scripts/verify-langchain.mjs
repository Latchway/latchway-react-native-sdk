// Offline serialization regression only. This is not live/device evidence.
import assert from 'node:assert/strict';
import {bindLatchwayTools, createLatchwayResponsesModel, toLatchwayReplayMessage} from '@latchway/langchain';
import {SystemMessage, HumanMessage, AIMessage, ToolMessage} from '@langchain/core/messages';
import {tool} from '@langchain/core/tools';
import {modelOptions} from '../src/model-options.ts';
import {weatherInput} from '../src/weather.ts';

const captured = [];
const model = bindLatchwayTools(createLatchwayResponsesModel({
  latchway: {
    gatewayURL: 'https://gateway.example.com',
    fetchFor: () => async (_url, init) => {
      captured.push(JSON.parse(init.body));
      throw new Error('offline capture: no network or provider call');
    },
  },
  feature: 'latchway-foundation-models',
  ...modelOptions,
}), [tool(async () => 'unused', {name: 'weather_check',
  description: 'Current weather', schema: weatherInput})]);
const base = [new SystemMessage('Reference'), new HumanMessage('Singapore weather?')];
const history = [...base,
  toLatchwayReplayMessage(new AIMessage({id: 'msg_provider_stored', content: '', tool_calls: [{type: 'tool_call', id: 'call_offline', name: 'weather_check', args: {city: 'Singapore', countryCode: 'SG'}}]})),
  new ToolMessage({tool_call_id: 'call_offline', content: 'Offline serialization fixture'}),
];
for (const messages of [base, history]) {
  await model.invoke(messages).catch(() => {});
}
assert.equal(captured.length, 2, 'No automatic retries');
for (const request of captured) {
  assert.equal(request.store, false);
  assert.equal(request.reasoning.effort, 'none');
  assert.equal(request.tools[0].strict, true, 'Never strict:null');
  assert.equal(request.max_output_tokens, 1024);
  for (const field of ['include', 'previous_response_id', 'conversation']) assert(!(field in request));
  for (const item of request.input) assert(!('id' in item), 'Never replay stored output item IDs');
}
assert(captured[1].input.some(item => item.type === 'function_call' && item.call_id === 'call_offline'));
assert(captured[1].input.some(item => item.type === 'function_call_output' && item.call_id === 'call_offline'));
console.log('Published LangChain adapter: stateless payload, boolean strict, explicit reasoning, correlated tool results, no retries — passed (offline).');
