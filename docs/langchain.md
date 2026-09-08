# LangChain on React Native

Use `@latchway/react-native@1.2.0` for native authenticated transport and
`@latchway/langchain@1.1.0` for the optional LangChain adapter. No provider key
belongs in the application. Secure Enclave/Keystore, App Attest/Play Integrity,
DPoP and refresh credentials stay native.

## Install

The complete LangChain example is tested on React Native 0.82 / React 19.1,
New Architecture. Starting in 1.1.3, the base SDK's expanded minimum is RN 0.74 /
React 18.2; see [compatibility](react-native-compatibility.md). This does not
require downgrading the example or guarantee every third-party dependency on
the minimum host.

```sh
npm install --save-exact @latchway/react-native@1.2.0 @latchway/langchain@1.1.0 \
  @latchway/client@1.1.0 @langchain/core@1.2.9 @langchain/openai@1.5.10 openai@7.8.0
```

Keep the lockfile. LangChain is not a dependency of the base React Native SDK.
The base has only two required runtime dependencies: `@latchway/client` for
shared transport/errors and `web-streams-polyfill` for a private native-response
stream fallback. That fallback does not replace global streams.
The native dependencies are iOS 1.2.0 and Android 1.1.0. Normal native
signing, Firebase/other identity and gateway platform policy setup still applies.

## Application-owned runtime and Babel setup

These are LangChain/Hermes compatibility requirements, not Latchway's native
authentication requirements. If your app already supplies complete URL,
incremental TextDecoder, streams or secure random values, reuse them and adapt
the bootstrap. Do not install a second native randomness module unnecessarily.
The following is the tested bare-RN example configuration, not a requirement
to adopt these exact polyfill packages in every host:

```sh
npm install --save-exact react-native-get-random-values@1.11.0 \
  react-native-url-polyfill@2.0.0 text-encoding@0.7.0 web-streams-polyfill@4.3.0
npm install --save-dev --save-exact @babel/plugin-transform-export-namespace-from@7.29.7 \
  @types/text-encoding@0.0.40
cd ios && pod install && cd ..
```

Copy both app-owned files into `src/runtime/`:

- [symbols.ts](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.1.2/Examples/LatchwayChat/src/runtime/symbols.ts)
- [polyfills.ts](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.1.2/Examples/LatchwayChat/src/runtime/polyfills.ts)

Keep the symbols module import first inside the bootstrap. Remove imports for
implementations you already supply; an unused static import still requires its
package to be installed. Use a secure native/Expo random-value implementation,
never `Math.random`, and run on Hermes rather than legacy remote Chrome debugging.

Put the bootstrap **first** in the application entrypoint, before importing
React Native, Latchway, LangChain or any stream-dependent application module:

```js
import './src/runtime/polyfills';
import {AppRegistry} from 'react-native';
import App from './App';
```

Merge the following into your existing `babel.config.js`; retain your current
presets, plugins and other assumptions. Add the plugin only once:

```js
module.exports = {
  presets: ['module:@react-native/babel-preset'],
  assumptions: {noClassCalls: true},
  plugins: ['@babel/plugin-transform-export-namespace-from'],
};
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

The Babel configuration enables `noClassCalls` and the export-namespace transform.
This avoids a premature `instanceof` check before LangChain initializes its fields.
Classes must still be constructed with
`new`; LangChain's own type checks are not removed.

## Upgrading from 1.1.0

For an existing 1.1.1 application, upgrade to 1.2.0 and recopy both runtime files
linked above. The corrected probe checks exact Responses and Chat Completions
paths; the older app-owned copy is not replaced by an npm package update.
Do not fix a trailing-slash rejection by widening the SDK destination allowlist.

1.1.1 removes four convenience packages from required dependencies. This
changes installation behavior even though the core APIs are unchanged: helper
users must act before updating. Prefer the application-owned setup above; the
example shows the full migration and does not import either deprecated helper.

For the smallest migration, retain the 1.1.0 imports and declare their packages
in your **host application's** manifest first:

```sh
# Required only if you import @latchway/react-native/polyfills:
npm install --save-exact react-native-get-random-values@1.11.0 \
  react-native-url-polyfill@2.0.0 text-encoding@0.7.0
# Required only if you use @latchway/react-native/babel:
npm install --save-dev --save-exact @babel/plugin-transform-export-namespace-from@7.29.7
npm install --save-exact @latchway/react-native@1.2.0
cd ios && pod install && cd ..
```

The old `/polyfills` and `/babel` exports remain available but deprecated. Their
dependencies are marked as **optional peers** so npm does not automatically
install them for core-only users. They are not `optionalDependencies` (which
would still normally install). When present, peer versions must satisfy the
declared ranges; exact example versions are the tested baseline, not a claim
that all combinations are verified. See [npm's optional-peer behavior](https://docs.npmjs.com/cli/v11/configuring-npm/package-json/#peerdependenciesmeta).

The legacy bootstrap still statically imports all three runtime peers, even if
the app already has compatible globals. Missing peers cause module-resolution
errors; the Babel helper reports the plugin install command. Existing lockfiles
may mask missing direct dependencies: verify a clean install and native rebuild.
Do not rely on another package incidentally installing them. No companion
package, setup CLI or global fetch patch is needed.

## Create a model

For the recommended shared session API, use gateway 1.1.1 or later and follow
[supplied identity setup](supplied-identity.md). Configure can run first from
RN or native; neither side must bootstrap the other. Pass an ID token owned by
your application's auth integration, then obtain `account.makeClient()`:

```ts
import {Latchway, firebaseProject} from '@latchway/react-native';

const app = await Latchway.configure({
  baseURL: 'https://gateway.example.com', applicationID: 'your-application-id',
  environment: 'development', identity: firebaseProject({projectID: 'your-project-id'}),
  apple: {rootKeychainAccessGroup: 'YOURTEAM.com.example.app'},
  android: {playIntegrityCloudProjectNumber: '123456789012'},
});
const account = await app.signIn({idToken: applicationOwnedIdToken});
const latchway = await account.makeClient();
```

Report refreshed tokens with `account.updateIdToken`, and call
`account.logout()` on sign-out. Disposing a client only closes that surface.
The metadata helper does not import Firebase or obtain a token for you.

For legacy constructors on gateway 1.0.3+, one directly App Attest-verified `ios` / `react_native_ios`
main-app root pair can share a bundle, and one directly Play Integrity-verified
`android` / `react_native_android` app-root pair can share a package. Configure
each platform explicitly with its own root and required attestation policy.
This does not enable all platforms automatically, merge installations, or grant
another quota allowance. Firebase authentication remains separate from native
attestation. Use a Play-distributed physical Android build for real Integrity
verification; do not replace it with a debug bypass or Firebase App Check.

Pass the client directly—no transport wrapper:

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
