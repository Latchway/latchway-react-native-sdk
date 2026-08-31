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

For a source-development run on a physical iPhone, the example offers a
separate opt-in Debug bootstrap. `scripts/copy-development-firebase-ios-config.sh`
validates an external, bundle-matched Firebase plist and copies it only into a
Debug `iphoneos` build; `scripts/run-development-react-native-ios.sh` keeps the
custom token and digest out of an allowlisted Xcode build environment, validates
the complete non-secret deployment coordinates, rechecks grant freshness, and
force-bundles the exact JavaScript checkout before handing the grant to one
no-debugger launch. The physical-device run therefore does not require Metro or
Local Network access, although iOS can still show React Native's one-time Debug
permission sheet on the first install. Later runs update the existing app so
that OS consent persists; they do not retain Firebase or Latchway trust state.
The app eagerly signs in with a new grant, signs out any old Firebase user, revokes prior
installation state, exercises Responses, quota, and exact
`react_native_ios`/`app_attest`/`app_verified` diagnostics, then revokes and
signs out. The runner passes only after retrieving the exact random-run marker
written after that terminal cleanup. The Debug native module and marker writer
are absent from Release. This path verifies local integration only and cannot
satisfy the protected physical-evidence gate. See the example README for the
exact runner workflow.

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

The checked-in App Intents target is an archive/signing fixture, not a
delegated-request implementation. Candidate production requires a distinct
child bundle ID and provisioning profile for it. The signed root target lists
its private app-ID Keychain group first and the shared component group second;
the first position keeps implicit root Keychain writes private. The signed
extension lists only the shared group and therefore cannot read root-private
key, credential, or session state. Each provisioning profile must authorize
every group its target signs, either exactly or with a well-formed terminal
wildcard. The extension must not carry App Attest. Its intent fails closed
because React Native v1 exposes diagnostics but no delegated component request
operation.

For local native SDK work, declare the sibling `Latchway.podspec` by path in the example/host Podfile before `use_react_native!`:

```ruby
pod "Latchway", path: "../../../latchway-ios-sdk"
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
