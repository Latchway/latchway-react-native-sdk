# Native installation

For React Native 0.74–0.81 hosts, first follow the
[minimum-version toolchain and New Architecture setup](react-native-compatibility.md).
The expanded peer range starts in 1.1.3. React Native SDK 1.3.0 pins iOS 1.3.0
and Android 1.2.0; upgrading requires installing Pods and rebuilding native apps.

React Native autolinking installs both native bridges. New integrations call
`Latchway.configure` from either native or RN with matching public configuration;
no extra runtime native bootstrap, Firebase dependency or authority registration
is needed. Capabilities/provisioning and the platform security settings below
are still host build requirements. See [developer-supplied identity](supplied-identity.md).
If the host also uses a native SDK directly, resolve one matching implementation:
do not link a separate SwiftPM SDK copy alongside the CocoaPods SDK used by RN.

## iOS

Configure `apple.rootKeychainAccessGroup` with the fully resolved private app-ID
group that appears first in the signed root target. For an existing legacy
installation, list every explicit
extension-shared group in `apple.legacySharedKeychainAccessGroups`; the native
SDK scans only exact root-record coordinates in those groups. Missing,
wildcard, duplicate, or root-equal groups fail closed, and stale root records
require an explicit migration.

The podspec pins `Latchway/AppAttest` 1.3.0 and React Native codegen dependencies.
Run CocoaPods from the host application after installing the npm package.
Enable App Attest for the application identifier and use a real device for
conformance; simulators report attestation unsupported.

The native auth owner awaits `try await app.signOut()` on the shared
`LatchwayApp` at sign-out, even if no RN or AI screen was opened. This cleans
current/persisted Latchway account state; it does not call Firebase or another
identity provider's sign-out. Secure-storage failures still throw and require
retry through the same API before another login.

The Firebase Authentication example pins React Native Firebase 25.1.0 and
Firebase Apple SDK 12.15.0 and uses CocoaPods static frameworks. The Latchway
package itself does not depend on Firebase. Firebase has announced that the
existing CocoaPods releases remain installable but new Firebase Apple SDK
versions stop shipping through CocoaPods after October 2026; migrate the
example to the compatible React Native Firebase SPM path only after its pinned
RN 0.82 native host build is green.

For a source-development run on a physical iPhone or iPad, the example offers a
separate opt-in Debug bootstrap. `scripts/copy-development-firebase-ios-config.sh`
validates an external, bundle-matched Firebase plist and copies it only into a
Debug `iphoneos` build; `scripts/run-development-react-native-ios.sh` keeps the
custom token and digest out of an allowlisted Xcode build environment, validates
the complete non-secret deployment coordinates, rechecks grant freshness, and
force-bundles the exact JavaScript checkout before handing the grant to one
no-debugger launch. The physical-device run therefore does not require Metro or
Local Network access, although iOS can still show React Native's one-time Debug
permission sheet on the first install. Later runs update the existing app so
that OS consent persists. The app signs in with a new grant, revokes the old
descriptor-bound family, verifies the root Responses/quota/diagnostics path,
and prepares the App Intent descriptor. After the one-use grant has been
destroyed, the root publishes a nonsecret exact-run shared-Keychain challenge
immediately before the waiting marker. The separately launched Debug App Intent
captures that challenge before constructing its client, refreshes an
independently keyed delegated session, and fully consumes one successful bounded
Responses body. It rechecks the challenge immediately before echoing the run in
a bounded shared-Keychain receipt. The containing app accepts only its
native-captured exact run, deletes both artifacts, retires that exact
descriptor-bound family, and signs out. The runner passes only after retrieving
the exact random-run
marker written after terminal cleanup. Its bounded post-wait abort path also
relaunches the containing app to finish and verify family retirement/sign-out
after interruption or timeout, deleting both challenge and receipt. The Debug
native module and marker writer are
absent from Release. This path verifies local integration only and cannot
satisfy the protected physical-evidence gate. See the example README for the
exact runner workflow and possible Shortcuts tap.

Firebase Authentication and Firebase App Check are distinct. The checked-in
example pins Firebase App/Auth but does not install the native App Check module,
and a Firebase web App Check registration does not apply to an iOS application.
When App Check enforcement is enabled for the Firebase resource, pin a
compatible React Native Firebase App Check dependency and activate the Apple
App Attest provider before the Auth exchange. A debug App Check provider/token
is never acceptable in a protected Release candidate.

A production App Attest run requires all of the following, none of which can be
substituted by a simulator build:

- an App Attest-capable physical iPhone or iPad;
- a registered App ID with the App Attest capability, a matching Team ID and
  bundle ID, and a provisioning profile containing the entitlement;
- `development` or `production` selected consistently in the entitlement,
  React Native client configuration, gateway application record, and Apple
  verification policy; and
- a real application identity token plus the exact gateway/core release named
  by the synchronized contract lock.

The legacy root-application bridge constructs the App Attest provider with the exact
`rootKeychainAccessGroup`, `legacySharedKeychainAccessGroups`, and
`.reactNativeIOS` runtime, then passes the same groups to
`LatchwayConfiguration`. Keychain, Secure Enclave, session, and accepted App
Attest key state are runtime-isolated on that compatibility path. The recommended
shared-app API instead reuses the native app registry across native and RN
callers. An extension bridge constructs no App
Attest provider: iOS app extensions cannot call
`DCAppAttestService.generateKey`, so extension sessions remain independently
keyed and delegated from the already attested root application.

The checked-in App Intents target has two intentionally different build
boundaries. In Debug, its own CocoaPods target links `Latchway/AppExtensions`
and the native Swift intent performs the local delegated-request proof without
hosting a React Native JavaScript runtime. In Release, that dependency is not
linked, no executable Latchway client path is compiled, and the archive/signing
fixture's intent fails closed. The CocoaPods subspec is imported through module
`Latchway`, not the SwiftPM-only module name.

Candidate production requires a distinct child bundle ID and provisioning
profile. The signed root target lists its private app-ID Keychain group first
and the shared component group second; the first position keeps implicit root
Keychain writes private. The signed extension lists only the shared group and
therefore cannot read root-private key, credential, identity, or session state.
Each provisioning profile must authorize every group its target signs, either
exactly or with a well-formed terminal wildcard. The extension must not carry
App Attest. The Debug intent constructs its delegated client with
`.reactNativeIOS`; the gateway component definition must therefore use platform
`react_native_ios`, kind `app_intent_extension`, delegated-only trust, and the
same requested feature as the descriptor prepared by the root.

The root JavaScript API owns the descriptor lifecycle:

- `prepareComponents` provisions one or more exact descriptors;
- `replaceComponent` rotates/replaces one exact descriptor;
- root-side `componentDiagnostics` reads redacted local state without acquiring
  application identity;
- `revokeComponent` retires one descriptor; and
- no-argument `revokeCurrentInstallationFamily()` retires the root plus every
  component in the native iOS SDK's durable root-private descriptor registry;
  the optional descriptor list additionally covers pre-registry legacy state.

Descriptors are normalized and snapshotted before asynchronous identity work.
The native SDK registers only their public Keychain coordinates before it can
create component-local state. Successful cleanup removes a coordinate, while a
failed Keychain erasure keeps it durable for retry after a later app launch.
Preparation, replacement, and returned diagnostics are checked against that
same snapshot, and serialized multi-component input larger than 65,536 bytes is
rejected in JavaScript before crossing the native bridge. Component keys,
grants, delegated sessions, and the root identity never cross into JavaScript.

For local native SDK work, declare the sibling `Latchway.podspec` by path in the
appropriate host targets. The root path declaration lets the autolinked React
Native pod resolve its App Attest dependency from that source, while the
extension subspec is Debug-only:

```ruby
target "ContainingApp" do
  pod "Latchway", :path => "../../../latchway-ios-sdk"
  # use_native_modules! / use_react_native! follows here.
end

target "AppIntents" do
  pod "Latchway/AppExtensions", :path => "../../../latchway-ios-sdk",
      :configurations => ["Debug"]
end
```

Local paths belong only in the host Podfile. They are absent from the published React Native podspec.

## Android

The library pins the native 1.2.0 Maven coordinates. The library and native AAR
minimum compile SDK are API 34; minimum Android runtime API remains 24.
The AARs publish Kotlin 2.3 metadata. The RN 0.74 minimum fixture and RN 0.82
example use Kotlin 2.3.21, AGP 8.12.0 and Gradle 8.13; the example's newer
compile/target SDK is a host choice, not the Latchway library minimum.
The minimum fixture uses an explicit newer build-only React Native Gradle
plugin and settings-based autolinking; follow its complete compatibility recipe.
React Native and Codegen themselves resolve from the consuming app, not a
library-local 0.82 installation.
Play Integrity requires the decimal Google Cloud project number in
`android.playIntegrityCloudProjectNumber`; JavaScript never receives or
supplies the resulting integrity token.

The native auth owner calls the shared `LatchwayApp`'s suspend `app.signOut()`
from its serialized auth coroutine, even if React Native has not mounted.
Await completion before accepting another login. Sign-out clears Latchway
account state, not the app's external auth provider; real secure-storage
failures still throw and can be retried with the same method.

A production Play Integrity run requires a physical device and a build whose
package name and signing-certificate digest match the gateway application
record. Configure the Play Integrity API and its decimal Google Cloud project
number, upload the signed build to a Play internal/closed/production track, and
install it from Google Play. A locally sideloaded debug APK can prove compilation
and bridge behavior, but it is not production Play Integrity evidence. Exercise
both hardware-backed/StrongBox-available and fallback policy variants on the
device matrix required by the deployment.

For local native SDK work, publish the native artifacts to a disposable Maven repository and set one of:

```sh
./android/gradlew -p android -PlatchwayNativeRepository=/absolute/path/to/maven check
```

```sh
LATCHWAY_NATIVE_REPOSITORY=/absolute/path/to/maven ./android/gradlew -p android check
```

The repository is content-filtered to `dev.latchway`. Composite-build substitution is intentionally avoided because the Android SDK and React Native 0.82 currently use incompatible Gradle major versions.

## Release dependency check

Before npm publication, verify that a clean consumer resolves the exact public
CocoaPods/Maven coordinates without local path or repository overrides. Publish
the native SDKs first and wait for the coordinates to become downloadable; an
accepted Maven upload does not by itself mean Central publication is complete.
A local native build proves source compatibility, not public dependency
availability. The current main-only `single-maintainer-release.yml` workflow
builds and publishes the npm package; it does not run a separate consumer
verification gate or establish physical-device evidence.
