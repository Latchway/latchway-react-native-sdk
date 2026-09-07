# LatchwayChat · React Native

A standalone consumer example: Firebase email/password authentication, temporary
chat about Latchway, LangChain streaming with a real weather tool, and a direct
fetch mode selectable in Settings. It uses **published npm packages**, not the
SDK checkout or the parent pnpm workspace.

## What runs where

- Firebase Auth owns sign-up, sign-in, and Firebase session persistence.
- `@latchway/react-native@1.1.1` owns authenticated transport, via
  CocoaPods `Latchway/AppAttest 1.0.0` and Maven Central Android SDKs 1.0.0.
  App Attest, Secure Enclave/Keystore, DPoP and refresh credentials stay native.
- `@latchway/langchain@1.1.0` creates ChatOpenAI from
  `@langchain/openai@1.5.10`, with a feature-bound Latchway fetch. Its stateless
  Responses, tool-binding and replay helpers replace the example's compatibility glue.
- LangChain `bindTools`, messages, streaming chunks and correlated ToolMessages
  implement the explicit tool loop. The app permits only `weather_check`.
- Weather uses Open-Meteo/GeoNames fixed HTTPS endpoints, no GPS or weather key.
  The public API is appropriate for this non-commercial demo; review its terms
  before commercial use.
- The gateway owns provider secrets, physical model selection, attestation
  policy, trusted accounting and per-user feature quotas.

No upstream/Admin/setup key belongs in this app. Firebase client configuration
is not a service-account file. No LangSmith tracing is configured.

## Prerequisites

Node 24.19+, npm, React Native 0.82-compatible native tools.
iOS: CocoaPods, Xcode, an Apple development team and a real App Attest-capable
device. The host adopts UIScene for iOS 27.
Android: JDK 17+, SDK 37, NDK 27.1.12297006; Kotlin 2.3.21 matches the published
native SDK metadata.

The gateway must support rich Responses tool inputs and trusted input accounting
(server 1.0.2 or later). Configure:

1. A disposable application and Development environment.
2. Firebase identity provider `firebase` with your Firebase project ID; enable
   Email/Password in Firebase Authentication.
3. A `react_native_ios` root Component Definition for the Apple bundle ID, with
   direct App Attest, plus a required App Attest policy matching team, bundle,
   signing category and development environment.
4. Feature `latchway-foundation-models` with `openai_responses` routing and a
   compatible trusted input accounting profile. The name is shared with the
   Swift example, but this client uses LangChain, not Apple's Foundation Models.
5. Feature `latchway-chat` with `openai_chat` routing. Grant both features to
   the root component. The demonstration uses 100,000 total tokens per user,
   per feature, per UTC day.
6. Server-side upstream/model/pricing configuration and secret references.

Only the chosen platforms need configuration. The supplied local verification
deployment enables React Native iOS only. For Android, add a
`react_native_android` component, real Play Integrity policy, signing certificate
SHA-256, project number and server verifier credentials. It fails closed if the
project number is missing; it does not use debug attestation.

## Install and configure

Run commands from this directory, not the repository root:

```sh
npm ci
cp src/config.example.json src/config.local.json
# Edit the public gateway/application/feature/team settings in config.local.json.
npm run verify:registry
```

`config.local.json`, Firebase client files, build output, device receipts and
signing assets are ignored. The exact npm tarball origins and SHA-512 integrities
are locked in `package-lock.json`. There are no file/workspace/link dependencies.
Metro uses its standard configuration: the SDK publishes a built JavaScript
entry, so no custom resolver or source alias is necessary. The app owns its
Babel plugin and `noClassCalls` assumption. This avoids a premature
`instanceof` check before LangChain fields exist and supports export namespaces;
LangChain's own runtime checks stay intact. Construct classes with `new`.

The first entrypoint import is `./src/runtime/polyfills`, which installs
Hermes async symbols **before** stream dependencies and provides incremental
UTF-8, streams, URL, random-value and AbortSignal compatibility. The app declares
these dependencies directly and owns the two files in `src/runtime/`. It does
not use the SDK's deprecated `/polyfills` or `/babel` helpers. Copy/adapt this
setup to your host's existing runtime; see the [SDK quickstart](../../docs/langchain.md).
The URL capability check must include an absolute API path without a query and
stable serialization after reading `searchParams`. RN's partial URL passes a
query-only check but adds a trailing slash to `/v1/responses`; the native client
correctly refuses that different destination. Do not relax the SDK route guard.
The OpenAI transitive dependency is pinned to npm 7.8.0, matching the existing
React Native integration baseline. Registry package contents are unmodified.

### iOS

Copy your matching Firebase Apple client plist to
`ios/LatchwayChat/GoogleService-Info.plist`. The bundled example uses
`dev.latchway`; change the bundle ID in `scripts/configure-ios.rb` and public
configuration together if using another identity.

```sh
LATCHWAY_APPLE_TEAM_ID=YOUR_TEAM_ID ruby scripts/configure-ios.rb
cd ios
pod install --repo-update
cd ..
npm run ios -- --device
```

Open `ios/LatchwayChat.xcworkspace` in Xcode if selecting signing/device manually.
The first Keychain group must be `TEAM_ID.BUNDLE_ID` and match the public config.
Debug uses development App Attest; Release uses production, which requires a
matching server policy and distribution signing. No software key fallback.

To force-bundle JavaScript for a physical Debug build without a Metro connection:

```sh
FORCE_BUNDLING=1 RCT_NO_LAUNCH_PACKAGER=1 xcodebuild \
  -workspace ios/LatchwayChat.xcworkspace -scheme LatchwayChat \
  -configuration Debug -destination 'id=YOUR_DEVICE_UDID' \
  -derivedDataPath /tmp/latchway-chat-build -allowProvisioningUpdates build
```

A debug packager connection warning is harmless with the embedded bundle.
Installing another app with `dev.latchway` replaces the existing demo on that
device. It does not delete either example's source.

### Android

Copy the matching Firebase Android client file to
`android/app/google-services.json`; its package must match `dev.latchway`
(or your changed `applicationId`). Set
`androidPlayIntegrityProjectNumber` in the local config and complete server policy.
The Google Services plugin activates when that file exists.

```sh
npm run android
```

A successful APK build without that file is only a compile check; Firebase login
requires the file and Play Integrity requires the real configured environment.
This example's release Gradle variant is **not store distribution configuration**;
replace debug signing and follow real Play distribution/provisioning requirements.

## Use

Create an account or sign in. Ask “How does Latchway protect provider keys?”,
then “Check the weather in Singapore.” Follow with “What about Ho Chi Minh City?”
to exercise conversation history, a second actual lookup and comparison.
Weather results show tool activity and source attribution.

Settings switches LangChain / direct fetch and starts a fresh conversation.
Direct fetch supports streamed text chat, not tools. Settings also exposes only
redacted SDK/native version, trust, request ID and server quota data. Sign out
revokes the active Latchway installation before signing out of Firebase.
If revocation fails, identity stays available for a deliberate retry.

History is in memory only. New conversation, mode switch, sign-out and restart
clear it. Completed turns, including tool messages, are retained as bounded units
(maximum four prior turns). Failed/partial turns never become model context.
Firebase and Latchway retain necessary session state securely.

Each turn has a 120-second deadline, at most four model calls and six weather
lookups, and requests at most 1,024 output tokens per model call. Stop cancels
the native stream and tool HTTP request. There are no automatic model retries.
Provider messages are sent with `store:false`, complete inline history and
reasoning effort `none`; opaque encrypted reasoning is not accepted by this
strict text-accounting route. These settings do not guarantee retention behavior
across all providers.

The bot uses a bundled reference snapshot in `src/knowledge.ts`, not live RAG,
an administrative tool or a guarantee it can answer every future question.

## Verification

See [the verification record](VERIFICATION.md) for the completed physical iPhone
run, server corroboration, native builds and the remaining evidence boundaries.

```sh
npm run typecheck
npm test -- --runInBand
npm run test:adapter
npm run verify:registry
```

Unit-test mock data is explicitly separate from device proof. On-device proof
uses the same Firebase, chat engines, native SDK and UI update paths. Launch the
Debug iOS app with `--verify-latchway-chat` to opt in. It creates a disposable
Firebase account, signs out/in, runs two weather turns and a direct-fetch turn,
checks observed App Attest/Secure Enclave trust, and writes a metadata-only
`Documents/latchway-chat-proof.json`. The native receipt bridge is omitted from
Release builds. It never records prompts, replies, passwords or tokens.

This launch mode makes real provider requests and consumes the disposable
application's quota. It revokes a previous installation for this example before
creating the new test identity. The random password is not logged or saved by
the harness; Firebase keeps its normal session, leaving the app signed in.
Use Sign out and create an account with your own chosen password for personal use.

Corroborate the receipt with the Admin API's environment-scoped requests, trust,
installation and usage metadata. A build or client receipt alone is not full
server-side or production-distribution evidence. Physical Android, extension,
quota-boundary, load and comprehensive security verification are separate.

### Dependency notes

For a non-resetting iOS Debug diagnosis, launch with `--diagnose-latchway-chat`.
It requires an existing Firebase sign-in and sends one fixed Latchway question
through the normal LangChain chat path. It never creates an account, signs out,
revokes an installation or replays a failed user prompt. It consumes normal
provider quota if dispatched. Do not combine it with the resetting
`--verify-latchway-chat` mode.

Debug chat attempts also write `Documents/latchway-chat-diagnostic.json`, separate
from the full proof receipt. Only status, fixed stage, bounded code locations,
validated HTTP status, error code, request IDs and counters are recorded—no
exception messages, source URLs, prompts, replies or credentials. The native
receipt module is absent from Release. The UI exposes nested error codes and
the failure stage instead of hiding every wrapped SDK exception behind `Error`.

The SDK compatibility baseline pins React Native 0.82 and its native dependencies.
This app's explicit compatibility bootstrap currently uses the deprecated, pinned
`text-encoding@0.7.0` for streaming UTF-8; this maintenance limitation is retained
explicitly, not described as a clean dependency audit.
npm audit on 2026-09-07 reported nine moderate findings in CLI/dev-server
transitive dependencies (`fast-xml-parser` and `qs` chains), no high/critical
findings. This example does not claim a clean vulnerability scan or expose Metro
publicly. Upgrade the tooling baseline deliberately; do not force-upgrade the
native SDK or alter registry package contents to conceal incompatibilities.

## Cleanup

Sign out/revoke this disposable installation, then remove only this example's
Firebase test UID and Latchway application/environment if no longer needed.
Do not delete the shared Firebase project, Apple bundle identity, gateway,
database, Habitify app configurations or the shared upstream credential.

References: [LangChain ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai),
[Open-Meteo](https://open-meteo.com/en/docs).
