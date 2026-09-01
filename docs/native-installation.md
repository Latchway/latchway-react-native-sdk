# Native installation

## iOS

Configure `apple.rootKeychainAccessGroup` with the fully resolved private app-ID
group that appears first in the signed root target. List every explicit
extension-shared group in `apple.legacySharedKeychainAccessGroups`; the native
SDK scans only exact root-record coordinates in those groups. Missing,
wildcard, duplicate, or root-equal groups fail closed, and stale root records
require an explicit migration.

The podspec pins `Latchway/AppAttest` 1.0.0 and React Native codegen dependencies. Run CocoaPods from the host application after installing the npm package. Enable App Attest for the application identifier and use a real device for conformance; simulators report attestation unsupported.

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

The root-application bridge constructs the App Attest provider with the exact
`rootKeychainAccessGroup`, `legacySharedKeychainAccessGroups`, and
`.reactNativeIOS` runtime, then passes the same groups to
`LatchwayConfiguration`. Keychain, Secure Enclave, session, and accepted App
Attest key state are runtime-isolated. An extension bridge constructs no App
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

The library pins the native 1.0.0 Maven coordinates. Those AARs publish Kotlin
2.3 metadata and require compile SDK 37; the React Native 0.82 host therefore
pins Kotlin 2.3.21 while retaining RN's supported consumer AGP 8.12 baseline.
Play Integrity requires the decimal Google Cloud project number in
`android.playIntegrityCloudProjectNumber`; JavaScript never receives or
supplies the resulting integrity token.

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

CI must run once against only the published CocoaPods/Maven coordinates, without local path or repository overrides, before npm publication. A local native build proving source compatibility does not replace that consumer check. The manual `Published dependency consumer` workflow performs that gate; the promotion-dispatched release workflow repeats it before npm publication.
