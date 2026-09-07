# LangChain on React Native

Use `@latchway/react-native@1.1.0` for native authenticated transport and
`@latchway/langchain@1.1.0` for the optional LangChain adapter. No provider key
belongs in the application. Secure Enclave/Keystore, App Attest/Play Integrity,
DPoP and refresh credentials stay native.

## Install

The tested baseline is React Native 0.82 / React 19.1, New Architecture:

```sh
npm install --save-exact @latchway/react-native@1.1.0 @latchway/langchain@1.1.0 \
  @latchway/client@1.0.0 @langchain/core@1.2.9 @langchain/openai@1.5.10 openai@7.8.0
cd ios && pod install && cd ..
```

Keep the lockfile. LangChain is not a dependency of the base React Native SDK.
The native dependencies remain the public iOS/Android SDKs 1.0.0. Normal native
signing, Firebase/other identity and gateway platform policy setup still applies.

## Two explicit setup lines

Put the bootstrap **first** in the application entrypoint, before importing
React Native, Latchway, LangChain or any stream-dependent application module:

```js
import '@latchway/react-native/polyfills';
import {AppRegistry} from 'react-native';
import App from './App';
```

Use the optional compiler helper in `babel.config.js`:

```js
const {withLatchwayBabel} = require('@latchway/react-native/babel');
module.exports = withLatchwayBabel({
  presets: ['module:@react-native/babel-preset'],
});
```

Use standard Metro; no resolver override, source alias or local SDK link is
needed. Rebuild the native app after installation. Clear Metro's cache if it
still resolves the old 1.0.0 source entry.

The bootstrap installs missing async symbols before stream dependencies,
incremental UTF-8 decoding, web streams, random values and abort compatibility.
It only replaces URL when a capability probe fails, preserves working globals,
and never replaces fetch or native security. The standard SDK import does not
initialize globals. The decoder currently uses the pinned, deprecated
`text-encoding@0.7.0` implementation for incremental decoding; this is a known
maintenance dependency, not a claim of comprehensive runtime compatibility.

The Babel helper enables `noClassCalls` and the export-namespace transform while
preserving the rest of your config. Classes must still be constructed with
`new`; LangChain's own type checks are not removed.

## Create a model

Create `latchway` using the ordinary SDK configuration and your current user's
identity-token callback. Then pass that client directly—no transport wrapper:

```ts
import {createLatchwayResponsesModel} from '@latchway/langchain';

const model = createLatchwayResponsesModel({
  latchway,
  feature: 'assistant',
  reasoning: {effort: 'none'}, // only if your configured model supports this
  chatOptions: {maxTokens: 1024},
});
const controller = new AbortController();
for await (const chunk of await model.stream('Explain Latchway', {
  signal: controller.signal,
})) {
  // Render text chunks; retain original messages for usage/callback metadata.
}
// controller.abort() cancels native networking too.
```

The feature must route `openai_responses`, with the matching trusted accounting
profile, on gateway 1.0.2+. The server selects the physical model. The helper
does not guess reasoning capabilities from the placeholder model alias: omit
`reasoning` for routes that do not accept it. Stateless storage settings do not
guarantee retention behavior across all upstream providers.

For an `openai_chat` feature use the existing `createLatchwayChatOpenAI` instead.
Both factories default to no automatic framework retries. Native pre-dispatch
session recovery is separate; uncertain provider dispatches must not be replayed
casually. Explicit `chatOptions.maxRetries` is an application policy choice.

## Tools and local history

```ts
import {bindLatchwayTools, toLatchwayReplayMessage} from '@latchway/langchain';
import {HumanMessage, type BaseMessage} from '@langchain/core/messages';

// weather is your ordinary LangChain tool; the SDK never executes tools for you.
const modelWithTools = bindLatchwayTools(model, [weather]);
const history: BaseMessage[] = [new HumanMessage('Weather in Singapore?')];
const answer = await modelWithTools.invoke(history);
const replay = toLatchwayReplayMessage(answer);
history.push(replay);
// Dispatch only an allowlisted tool with validated arguments. Append the
// returned ToolMessage, preserving the model's tool_call_id, then invoke again.
```

The binding helper
defaults to `strict:true` and `parallel_tool_calls:false`; ordinary LangChain
options can override these deliberately. Supply strict-compatible schemas
(all required fields, `additionalProperties:false`; nullable instead of optional
properties when necessary).

Use `toLatchwayReplayMessage` only after a successful complete response (or
aggregating all stream chunks). It preserves text and function-call IDs while
removing provider item IDs and observational metadata. It rejects non-text,
opaque reasoning/refusal, malformed calls and duplicate IDs. Keep the original
message separately for usage information. Do not save failed/partial turns as
history. The helper does not store history, execute tools or enforce loop limits.

Set explicit tool-call limits, timeouts, cancellation and history bounds in your
app. Standard LangChain `withStructuredOutput(..., {method:'jsonSchema', strict:true})`
is available when the gateway route/model supports the schema.

## Example and evidence

The repository's `Examples/LatchwayChat` demonstrates Firebase login, a bounded
streaming weather-tool loop, ephemeral chat, direct fetch, Stop and diagnostics.
It consumes npm packages. Its verification report distinguishes physical iOS
evidence from Android build-only evidence. Request framework attribution remains
native-owned `react-native-fetch`, including when called through LangChain.

References: [Metro exports](https://metrobundler.dev/docs/package-exports/),
[Babel assumptions](https://babeljs.io/docs/assumptions#noclasscalls),
[LangChain ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai).
