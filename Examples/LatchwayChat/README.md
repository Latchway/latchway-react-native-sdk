# LatchwayChat · React Native

## Published SDK 2.0.0

This app consumes **published npm packages**: `@latchway/react-native` 2.0.0,
`@latchway/client` 1.1.0 and `@latchway/langchain` 1.1.0. Their native pins are
CocoaPods Latchway 2.0.0 and Maven Central Android 1.2.1. Use gateway 1.1.3 or
newer for the App Attest acceptance and Play testing policies. Normal Metro,
TypeScript and autolinking resolve installed packages, not sibling SDK source.

Version 2.0.0 is a source-breaking fresh-account release: older constructor,
callback-authority and storage-adoption paths are removed. Rebuild the native
app after updating npm and Pods; this is not an over-the-air JavaScript-only
upgrade. The SDK does not automatically migrate older stored credentials.
Historical receipts below remain evidence only for their stated versions.

The example owns Firebase login and supplies its ID token through `signIn`,
`restore` and `updateIdToken`. Either RN or native may configure first; matching
public settings reuse the existing native account. There is no permanent JS
identity owner, Firebase SDK dependency inside Latchway or mandatory bootstrap.

There are three runnable surfaces in one application:

- Standalone React Native: Firebase login/sign-up, explicit Latchway sign-in,
  LangChain + weather or direct fetch, offline Latchway logout, then Firebase
  sign-out. `Resume chat` is explicit login intent; mounting a screen is not.
- Embedded iOS: launch with `--latchway-embedded` to open the Swift host first.
  Sign in natively, send a native chat request, and open the RN LangChain screen.
  The host supplies its application-owned Firebase token. RN reuses the shared
  native account. Back navigation disposes the RN surface, not the account.
- Embedded Android: launch `dev.latchway/com.latchwaychat.SharedNativeHostActivity`
  in the explicit development build. The Kotlin host supplies identity, with
  separate native and RN chat actions. Android's Back button closes RN only.

The SDK remains independent of Firebase and LangChain. These are **app-owned
example dependencies**, not additions to the base SDK. Root keys, refresh state,
attestation evidence and native-owned Firebase tokens never enter the RN screen.

The standalone Firebase adapter compares the logical account and an observed
auth-transition epoch before and after token retrieval. It accepts a new User
wrapper created by a same-account token refresh, but rejects sign-out, tenant
changes and observed A→B→A transitions. JavaScript object identity is not a
stable Firebase account identifier; the gateway still authenticates the token.

### Normal registry build

From this directory, keep `LATCHWAY_SHARED_NATIVE_SOURCE`,
`LATCHWAY_NATIVE_REPOSITORY` and `LATCHWAY_NATIVE_VERSION` unset. Preserve your
existing `src/config.local.json` and Firebase public client configuration:

```sh
npm ci
cp src/config.local.json ios/LatchwayChat/SharedNativeConfig.json
mkdir -p android/app/src/main/assets
cp src/config.local.json android/app/src/main/assets/SharedNativeConfig.json
npm run typecheck
npm run verify:registry -- --javascript-only
pod install --project-directory=ios --repo-update
npm run verify:registry
npm start
```

The copies above bundle the same public example configuration for the optional
native host screens; they do not bootstrap Latchway or copy credentials.
The JavaScript-only verification explicitly skips CocoaPods; run the complete
check after installing Pods. Never link a second SPM/native SDK alongside the
one supplied by the npm package. Standard signing/App Attest/Play setup remains.

When updating an existing checkout whose `Podfile.lock` still pins an older
native Latchway version, run `pod update Latchway --project-directory=ios`
once after updating npm. This unlocks only Latchway; a normal `pod install`
then uses the committed 2.0.0 lock. Rebuild the app rather than reloading Metro.

### Optional SDK source development

Keep the native repositories as siblings of this repository. Install this app's
locked npm dependencies and supply `src/config.local.json` plus the correct
Firebase public client files (never a service account). Then, from this directory:

```sh
export LATCHWAY_SHARED_NATIVE_SOURCE=1
npm run prepare:shared
pod install --project-directory=ios --no-repo-update
npm run verify:shared
npm start
```

The preparation step builds the SDK and creates an ignored, private
`.latchway-development` overlay. Metro and native autolinking resolve that one
implementation. CocoaPods uses the sibling Latchway source; **do not additionally
link an SPM copy into the host**. The generated public JSON is bundled into the
native hosts. Source paths never enter the published SDK metadata. Keep the
development environment flag set for every build and bundle command.

The iOS bridge is copied into an owned source snapshot because CocoaPods does
not discover sources through a directory symlink. Rerun preparation and Pod
installation after native SDK changes; verification rejects stale snapshots or
Pods that omit the real bridge sources. Do not edit the generated snapshot.

For Android, first build the sibling native SDK's local publication repository:

```sh
cd ../../../latchway-android
./gradlew publishPublicArtifactsToPublicationTestRepository -Platchway.version=1.2.1-dev
cd ../latchway-react-native-sdk/Examples/LatchwayChat
export LATCHWAY_NATIVE_REPOSITORY="$PWD/../../../latchway-android/build/publication-test-repository"
npm run android
```

The explicit development repository exclusively resolves `dev.latchway` to
`1.2.1-dev` for this app and must never be used as release evidence. It overrides
the bridge's exact 1.2.1 pins only in this private example build.
The release-line versions and source-build scope are recorded in
`../../release-candidate.shared-native.json`; this override does not change the
normal registry lockfiles.

Use an explicitly configured development environment with protocol 3 and
required native host attestation policy allowing both native and `react-native`
callers. Native iOS/Android root definitions must match that policy. No separate
React-Native-only root/session is adopted by the current source. Real App
Attest/Play Integrity still applies; simulator compilation is not attestation.

### Two-account acceptance exercise

1. Sign in as A, send from native and RN, and record only redacted request IDs.
   Confirm server request records share A's installation/user quota scope and
   distinguish native/RN callers. Do not print or compare credentials.
2. Close and reopen RN. Native chat must still work; no new sign-in occurs.
3. Start an RN weather turn, return to native and sign out. Late text/tools must
   not reappear, native and RN old clients must fail, and offline local cleanup
   must finish without an identity callback or installation revocation.
4. Sign in as B through `app.signIn` and use fresh chat/model handles. No A
   history remains. Verify B's principal and quota in the server database.
5. Sign out and back in as A. A's existing daily usage is unchanged. Repeat with
   Firebase changing accounts outside the chat and with JS paused/reloaded.

Standalone and embedded callers use the same supplied-identity registration;
there is no authority transfer. Native can continue using a fresh verified token
after JS stops. The application must report token updates and logout. Expiry
suspends work until a same-account token update; process restart needs identity
restoration, which cannot undo persisted logout. Restart when switching this
demo's launch surfaces so its application-level UI/auth listeners are rebuilt.

Automated lifecycle/transport tests and compile results are recorded in
[`SHARED_NATIVE_VERIFICATION.md`](./SHARED_NATIVE_VERIFICATION.md), separately
from physical App Attest, Play-distributed Android, cross-process extensions and
live principal/quota evidence. Existing `VERIFICATION.md` receipts describe the
historical released demo, not this new shared-account implementation.

## Features

A standalone consumer example: Firebase email/password authentication, temporary
chat about Latchway, LangChain streaming with a real weather tool, and a direct
fetch mode selectable in Settings. It uses **published npm packages**, not the
SDK checkout or the parent pnpm workspace.

## What runs where

- Firebase Auth owns sign-up, sign-in, and Firebase session persistence.
- `@latchway/react-native@2.0.0` owns authenticated transport, via
  CocoaPods `Latchway/AppAttest 2.0.0` and Maven Central Android SDKs 1.2.1.
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
(server 1.1.3 or later for the policies below). Configure:

1. A disposable application and Development environment.
2. Firebase identity provider `firebase` with your Firebase project ID; enable
   Email/Password in Firebase Authentication.
3. An `ios` root Component Definition for the Apple bundle ID, with
   direct App Attest, plus a required App Attest policy matching team, bundle,
   signing category and accepted Apple environment (`development`, `production`
   or `any`), plus explicit
   `sharedNativeCallers: ["ios", "react-native"]` on that policy.
4. Feature `latchway-foundation-models` with `openai_responses` routing and a
   compatible trusted input accounting profile. The name is shared with the
   Swift example, but this client uses LangChain, not Apple's Foundation Models.
5. Feature `latchway-chat` with `openai_chat` routing. Grant both features to
   the root component. The demonstration uses 100,000 total tokens per user,
   per feature, per UTC day.
6. Server-side upstream/model/pricing configuration and secret references.

Only the chosen platforms need configuration. The supplied local verification
deployment enables React Native iOS only. For Android, add a
`android` component, real Play Integrity policy with
`sharedNativeCallers: ["android", "react-native"]`, signing certificate
SHA-256, project number and server verifier credentials. It fails closed if the
project number is missing. Play testing responses are accepted only when the
server's Development policy explicitly enables them; production remains strict.
Neither platform has a client-side environment or verification-bypass flag.
Apple distribution/build metadata is checked when present, but older proofs
can omit it. `any` accepts both Apple environments; it does not prove a build's
distribution category. Configuration activation requires fresh mobile evidence
before refreshing the session.

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
locally retires the captured Latchway account before application-owned Firebase
sign-out. It is offline-capable, not installation revocation, and does not reset
the user's quota. Cleanup failures remain fenced for a deliberate retry.

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
application's quota. It locally retires the previous example account before
creating the new test identity. The random password is not logged or saved by
the harness; Firebase keeps its normal session, leaving the app signed in.
Use Sign out and create an account with your own chosen password for personal use.

Corroborate the receipt with the Admin API's environment-scoped requests, trust,
installation and usage metadata. A build or client receipt alone is not full
server-side or production-distribution evidence. Physical Android, extension,
quota-boundary, load and comprehensive security verification are separate.

### Dependency notes

For a non-resetting iOS Debug diagnosis, launch with `--diagnose-latchway-chat`.
It requires an existing Firebase sign-in, explicitly supplies identity with the
same sign-in intent as **Resume chat**, then sends one fixed Latchway question
through the normal LangChain path. Account reconciliation and sign-in finish
before the turn creates its cancellation/UI scope. Sign-in failures are recorded separately
and stop before dispatch; request failures keep the normal send diagnostic.
It never creates an account, signs out Firebase, revokes an installation or
replays a failed user prompt. Normal launches do not create a new login. It consumes normal
provider quota if dispatched. Do not combine it with the resetting
`--verify-latchway-chat` mode.

Debug chat attempts also write `Documents/latchway-chat-diagnostic.json`, separate
from the full proof receipt. Only status, fixed stage, bounded code locations,
validated HTTP status, error code, request IDs and counters are recorded—no
exception messages, source URLs, prompts, replies or credentials. The native
receipt module is absent from Release. The UI exposes nested error codes and
the failure stage instead of hiding every wrapped SDK exception behind `Error`.

This example pins React Native 0.82 and its native dependencies; the SDK also
supports the documented RN 0.74 / React 18.2 New Architecture minimum host.
This app's explicit compatibility bootstrap currently uses the deprecated, pinned
`text-encoding@0.7.0` for streaming UTF-8; this maintenance limitation is retained
explicitly, not described as a clean dependency audit.
npm audit on 2026-09-07 reported nine moderate findings in CLI/dev-server
transitive dependencies (`fast-xml-parser` and `qs` chains), no high/critical
findings. This example does not claim a clean vulnerability scan or expose Metro
publicly. Upgrade the tooling baseline deliberately; do not force-upgrade the
native SDK or alter registry package contents to conceal incompatibilities.

## Cleanup

Sign out of the disposable account; separately revoke the installation through
the operator API if desired. Then remove only this example's
Firebase test UID and Latchway application/environment if no longer needed.
Do not delete the shared Firebase project, Apple bundle identity, gateway,
database, Habitify app configurations or the shared upstream credential.

References: [LangChain ChatOpenAI](https://docs.langchain.com/oss/javascript/integrations/chat/openai),
[Open-Meteo](https://open-meteo.com/en/docs).
