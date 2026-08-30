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

Configure these values in the host's uncommitted environment:

- `LATCHWAY_BASE_URL`
- `LATCHWAY_APPLICATION_ID`
- `LATCHWAY_ENVIRONMENT`
- `LATCHWAY_FEATURE`
- `LATCHWAY_ERROR_MAPPING_FEATURE` (a protected, guaranteed-absent feature)
- `LATCHWAY_MODEL`
- `LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER`

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

Install and type-check from the repository root:

```sh
pnpm install --frozen-lockfile
pnpm example:check
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
quota, and redacted trust diagnostics. It never asks JavaScript to replay or
mutate DPoP credentials or hash refresh tokens. The protected finalizer verifies
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
