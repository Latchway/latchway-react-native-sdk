# Example application

This directory contains complete React Native 0.82 New Architecture iOS and
Android hosts named `LatchwayExample`. It uses Firebase Authentication for the
app-owned identity JWT and `react-native-config` for non-secret deployment
values. The primary action requests an SSE response and consumes `Response.body`
incrementally, with a bounded display buffer, so the example exercises the
native-owned dispatch and pull-streaming bridge instead of replacing it with a
buffered mock. JavaScript never receives Authorization or DPoP headers.

The compatibility lock pins React Native Firebase 25.1.0, Firebase Apple SDK
12.15.0, and Firebase Android BoM 34.15.0. Do not upgrade those independently:
the React Native Firebase 26.3 line has an upstream iOS codegen return-type
regression with the locked React Native 0.82 generator. Move the set together
only after the replacement passes both native host gates.

The **Run framework consumers** action executes real OpenAI Responses, Vercel
AI Responses, LangChain Chat, LangChain embeddings, and Anthropic Messages
calls through protocol-specific feature-bound native fetch functions. The
active gateway configuration binds each feature to one protocol, so the action
requires four distinct feature identifiers. `src/framework-consumers.ts`
pins the tested OpenAI 7.8.0, AI SDK 7.0.85/`@ai-sdk/openai` 4.0.52,
`@langchain/openai` 1.5.10, and `@ai-sdk/anthropic` 4.0.46 packages. Their
constructor-only placeholder key is removed before the TurboModule boundary.
This action makes five gateway requests and is intended for a configured
development/conformance feature; the protected platform-specific physical
record remains deliberately framework-independent.

The official `@anthropic-ai/sdk` 0.120.0 client is intentionally not imported:
its credential-chain Node filesystem imports fail Metro resolution. The Vercel
Anthropic provider exercises the same `/v1/messages` protocol through the
supported custom-fetch seam without a Node shim.

Configure these values in the host's uncommitted environment:

- `LATCHWAY_BASE_URL`
- `LATCHWAY_APPLICATION_ID`
- `LATCHWAY_ENVIRONMENT`
- `LATCHWAY_FEATURE`
- `LATCHWAY_OPENAI_CHAT_FEATURE` (required only by the framework action)
- `LATCHWAY_OPENAI_EMBEDDINGS_FEATURE` (required only by the framework action)
- `LATCHWAY_ANTHROPIC_MESSAGES_FEATURE` (required only by the framework action)
- `LATCHWAY_ERROR_MAPPING_FEATURE` (a protected feature intentionally absent
  from the root component's grant; it may also be absent from configuration)
- `LATCHWAY_MODEL`
- `LATCHWAY_APPINTENT_COMPONENT_DEFINITION_ID` (iOS Debug device lane only;
  the generated definition ID for the delegated App Intent component)
- `LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER`
- `LATCHWAY_IOS_ROOT_KEYCHAIN_ACCESS_GROUP` (iOS only; the exact private root
  group signed into the application)
- `LATCHWAY_IOS_LEGACY_SHARED_KEYCHAIN_ACCESS_GROUPS` (iOS only; the exact
  shared App Intents group)

`LATCHWAY_APPLICATION_ID` is the generated `app_` resource ID returned by the
Latchway Admin API, not the package/bundle identifier or a name/slug.

Add the normal Firebase iOS/Android configuration files through the provider's
protected application setup. The physical producer accepts them only as
external paths, validates their exact application/project coordinates, and
embeds their SHA-256 in the signed candidate. Do not commit those files,
service-account credentials, identity tokens, App Attest evidence, Play
Integrity tokens, session credentials, or provider keys.
Copy `.env.example` to the ignored `.env` file and replace only its non-secret
deployment identifiers; provider credentials never belong there.

### Debug-only physical iPhone or iPad bootstrap

The iOS host has an opt-in development lane for exercising the current source
on a physical iPhone before producing protected Release evidence. It is
deliberately separate from `LatchwayEvidence`: its native module and one-read
grant slot are compiler-elided outside `DEBUG`, its Firebase copier refuses
Release and physical-candidate builds, and its environment names are not used
by the protected runner. This lane is useful development verification, never
release or conformance evidence.

Put `LATCHWAY_DEVELOPMENT_DEVICE_BOOTSTRAP=true` in the ignored `example/.env`.
Keep a bundle-matched `GoogleService-Info.plist` outside the repository, and
provide its path and SHA-256 only to the development runner. Do not put the
Firebase custom token, plist path, plist bytes, or either digest in `.env`, an
Xcode scheme, an argument, or a log. The copied plist is non-secret Firebase
client configuration; the custom token remains credential material.

In the development gateway, create the App Intent component definition with
platform `react_native_ios`, kind `app_intent_extension`, delegated-only trust,
and a requested feature equal to `LATCHWAY_FEATURE`. Copy its generated
definition ID into `LATCHWAY_APPINTENT_COMPONENT_DEFINITION_ID`. The delegated
credential is runtime-bound, so a definition registered as platform `ios`
cannot be used by this React Native host.

The development runner force-bundles the exact JavaScript checkout into its
signed Debug application. It does not use Metro or depend on the Mac's LAN
address. React Native's Debug tooling can still make iOS show the one-time Local
Network sheet; dismiss it promptly, and choosing **Don't Allow** is acceptable
because the verification uses the configured HTTPS gateway. The ignored env
file is an exact allowlist: it must contain every normal iOS deployment value,
`environment=development`, the private and shared Keychain groups shown above,
protected autorun disabled, and Debug bootstrap enabled. It must not contain
provider API keys or any other extra name.

```sh
LATCHWAY_IOS_DEVICE_ID=<coredevice-identifier-from-devicectl> \
LATCHWAY_IOS_XCODE_DESTINATION_ID=<device-udid-from-xcodebuild> \
LATCHWAY_BUNDLE_ID=dev.latchway \
LATCHWAY_IOS_TEAM_ID=<team-id> \
LATCHWAY_IOS_APP_ID_PREFIX=<app-id-prefix> \
LATCHWAY_IOS_APPINTENTS_BUNDLE_ID=dev.latchway.AppIntents \
LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP=<app-id-prefix>.dev.latchway.keychain \
LATCHWAY_DEVELOPMENT_FIREBASE_IOS_CONFIG_PATH=<external-plist> \
LATCHWAY_DEVELOPMENT_FIREBASE_CONFIGURATION_SHA256=<plist-sha256> \
LATCHWAY_DEVELOPMENT_ENVFILE=<absolute-path-to-ignored-example-env> \
scripts/run-development-react-native-ios.sh
```

`xcrun devicectl list devices` supplies the CoreDevice identifier used for
install, launch, and marker retrieval. `xcodebuild -showdestinations -workspace
example/ios/LatchwayExample.xcworkspace -scheme LatchwayExample` supplies the
separate device UDID used for the signed build; the runner rejects substituting
one identifier format for the other.

Export a newly issued one-use grant as
`LATCHWAY_DEVELOPMENT_ONE_TIME_DEVICE_GRANT` and its SHA-256 as
`LATCHWAY_DEVELOPMENT_DEVICE_GRANT_SHA256` immediately before invoking the
second command. The runner removes both from the build environment, runs
`xcodebuild` under an exact credential-free environment allowlist, revalidates
the grant immediately before launch, verifies the embedded bundle, and supplies
the grant only to one non-debugger `devicectl` launch.

The runner installs over an existing Debug copy instead of uninstalling it, so
iOS retains the Local Network decision already made for this bundle identifier.
This does not retain a trusted Latchway or Firebase session: the app consumes a
new grant, signs out any old Firebase user, and explicitly revokes the prior
Latchway installation before it creates the measured replacement.

The run is deliberately staged across the containing app and the extension:

1. The root app consumes the validated one-use grant, signs out any old
   Firebase user, revokes the prior descriptor-bound installation family, and
   establishes a fresh App Attest-backed root. It verifies Responses, quota,
   and `react_native_ios`/`app_attest`/`app_verified` diagnostics, then calls
   `prepareComponents` with the exact App Intent descriptor.
2. Immediately after current-family preparation, the root replaces any prior
   receipt/challenge with a nonsecret exact-run `dev_<32hex>` shared-Keychain
   challenge, writes the matching `waiting_for_app_intent` marker, and stops.
   The one-use custom token and digest have already been destroyed, while the
   prepared component family remains available for the separately launched
   extension.
3. The runner starts a bounded Darwin-notification wait and tries the public
   Shortcuts URL for **Run Latchway Proof**. iOS may still require a user to
   open Shortcuts and tap that App Shortcut; the runner prints this waiting
   instruction and never treats URL launch or notification delivery as proof.
4. In Debug, the native App Intent captures the exact-run challenge before it
   constructs `LatchwayExtensionClient` with runtime `react_native_ios`,
   refreshes only its independently keyed delegated session, sends one Responses
   request, and fully consumes the successful body. Immediately before replacing
   the receipt it re-reads the challenge, requires it to match the captured run,
   and echoes that run in the authoritative shared-Keychain receipt.
5. The runner relaunches the containing app with only the random run ID and a
   resume bit. The root accepts only a receipt and challenge matching its
   native-captured exact run, deletes both, retires the same descriptor-bound
   family, signs out Firebase, and only then writes the final success marker.

The receipt is at most 512 bytes and contains only a schema version, the
nonsecret `dev_<32hex>` run nonce, passed status, delegated-session/request
booleans, and completion timestamp. It never contains component, installation,
or user IDs, tokens, proofs, request bodies, or response bodies. Initial work
clears both artifacts; resume consumes and deletes both; abort also deletes both.
Every abnormal exit after the waiting marker—including an
interrupt, notification wait failure, resume launch failure, or terminal-marker
timeout—uses one centralized bounded exact-run abort launch. That launch retries
family retirement and sign-out as required, verifies an `aborted` cleanup
marker, and preserves the runner's original nonzero status. A failure writing
the final success marker is already after verified family retirement and
sign-out, so it remains terminal nonzero without attempting to recreate an
identity.

The App Intents CocoaPods target links `Latchway/AppExtensions` only in Debug;
the CocoaPods product's Swift module is `Latchway`. The Release extension has no
Latchway dependency or executable client path and its intent fails closed. This
Debug path is local integration proof only, not protected release or conformance
evidence.

This example pins Firebase App and Auth only. A Firebase web App Check
registration does not protect native iOS Auth traffic. If the target Firebase
resource enforces App Check, add and pin the native React Native Firebase App
Check package and activate Apple's App Attest provider before exchanging the
custom token; never substitute a debug App Check token in Release evidence.

Install and type-check from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm example:check
pnpm --filter latchway-react-native-example exec react-native bundle \
  --platform ios --dev false --entry-file index.js \
  --bundle-output /tmp/latchway-example.jsbundle
```

Build the iOS source consumer with the exact sibling SDK:

```sh
cd example/ios
LATCHWAY_IOS_SDK_PATH=/absolute/path/to/latchway-ios-sdk \
  RCT_NEW_ARCH_ENABLED=1 pod install --repo-update
xcodebuild -workspace LatchwayExample.xcworkspace \
  -scheme LatchwayExample -configuration Debug \
  -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/latchway-rn-ios CODE_SIGNING_ALLOWED=NO build
```

For Android, first run the Android SDK's local-publication verifier, then point
`LATCHWAY_NATIVE_REPOSITORY` at its disposable Maven output:

```sh
LATCHWAY_NATIVE_REPOSITORY=/absolute/path/to/publication-test-repository \
  ./android/gradlew -p example/android \
  :app:compileDebugKotlin :app:lintDebug --no-daemon
```

Release-consumer CI deliberately removes both overrides and resolves only the
public CocoaPods and Maven coordinates. Simulator/emulator success establishes
consumer compilation; physical App Attest and Play-distributed Play Integrity
prerequisites are documented in [native installation](../docs/native-installation.md).

The example also contains an example-only, allowlisted evidence sink used by
the protected physical-device workflows. It rejects debug builds,
simulators/emulators, test processes, debuggers, malformed release pins, and
records resembling secrets. `LATCHWAY_CONFORMANCE_AUTORUN=true` is reserved for
a pinned Release candidate built for those workflows; ordinary development
should leave it `false`. See [physical-device evidence](../docs/physical-device-evidence.md)
for the complete build, collection, and cross-repository finalization contract.

The v2 raw-device record includes only behavior the opaque JavaScript bridge can
prove: bridge reachability, native-owned authorization, typed errors, streaming,
quota, and redacted trust diagnostics. On iOS the example additionally disposes
the first native client, calls a one-use example-native method that clears only
the persisted session, and re-establishes through the production SDK. The run
passes `app_attest_assertion` only when native diagnostics report an assertion
and the installation ID is unchanged; the identifier is compared in memory and
is never added to evidence. The installation key and accepted App Attest state
remain native and untouched. The run never asks JavaScript to replay or mutate
DPoP credentials or hash refresh tokens. The protected finalizer verifies
the exact hash-pinned, release-eligible native iOS/Android report and imports its
replay, tamper, refresh-rotation, protocol-rejection, and revocation tests. Raw
JavaScript attempts to claim those native-only proofs are rejected.

For a protected Release build, run
`scripts/stage-physical-react-native-candidate.py ios|android`. The producer
requires clean, exact React Native, JavaScript SDK, native SDK, and core source
worktrees; the locked contract; a hash-pinned native report; external Firebase
configuration; and external platform signing. It materializes the pinned React
Native and JavaScript commits into fresh sibling worktrees, regenerates both
dependency trees from their protected locks, and builds the JavaScript SDK
before installing the React Native workspace. iOS additionally requires a protected
`Podfile.lock`, App ID Prefix, Team ID, distinct root/App Intents bundle and
profile pins, an exact private-first/shared-second signed Keychain entitlement
on the root, a shared-only entitlement on App Intents, and an installable ad hoc
profile that authorizes each target's signed groups. Android's separate signer requires the upload
keystore and upload certificate pin while the unsigned candidate embeds the
expected Play App Signing certificate. The repository/Gradle phase is unsigned-only; the keystore is
handed only to a closed no-checkout signer, destroyed from that boundary, and
then the exact AAB/APK bytes are checked in a fresh secret-free boundary with
the full-entry Java AAB verifier and a retained-unsigned-APK payload comparison.
The iOS handoff binds both the
canonical `ios-app-files.sha256` list and the native-compatible whole-`.app`
tree digest. It stages `candidate-manifest.json`, `source-inputs.json`,
platform binaries, JavaScript/dependency manifests, and `SHA256SUMS` into a new
output directory. It rejects identity grants and never writes signing
passwords, provider credentials, or provider secrets into that output. The
platform application necessarily retains only its non-secret Firebase client
configuration.
