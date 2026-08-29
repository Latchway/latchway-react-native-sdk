# Example application

This directory contains complete React Native 0.82 New Architecture iOS and
Android hosts named `LatchwayExample`. It uses Firebase Authentication for the
app-owned identity JWT and `react-native-config` for non-secret deployment
values. The primary action requests an SSE response and consumes `Response.body`
incrementally, with a bounded display buffer, so the example exercises the
JavaScript-owned streaming path instead of replacing it with a buffered mock.

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
- `LATCHWAY_MODEL`
- `LATCHWAY_GOOGLE_CLOUD_PROJECT_NUMBER`

`LATCHWAY_APPLICATION_ID` is the generated `app_` resource ID returned by the
Latchway Admin API, not the package/bundle identifier or a name/slug.

Add the normal Firebase iOS/Android configuration files through the provider's protected application setup. Do not commit service-account credentials, identity tokens, App Attest evidence, Play Integrity tokens, session credentials, or provider keys.
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
