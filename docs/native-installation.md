# Native installation

## iOS

The podspec pins `Latchway/AppAttest` 1.0.0 and React Native codegen dependencies. Run CocoaPods from the host application after installing the npm package. Enable App Attest for the application identifier and use a real device for conformance; simulators report attestation unsupported.

The Firebase Authentication example pins React Native Firebase 25.1.0 and
Firebase Apple SDK 12.15.0 and uses CocoaPods static frameworks. The Latchway
package itself does not depend on Firebase. Firebase has announced that the
existing CocoaPods releases remain installable but new Firebase Apple SDK
versions stop shipping through CocoaPods after October 2026; migrate the
example to the compatible React Native Firebase SPM path only after its pinned
RN 0.82 native host build is green.

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

The bridge constructs `LatchwayAppAttestProvider(applicationID:environment:clientRuntime:.reactNativeIOS)`, selects `.reactNativeIOS`, and sets the independent React Native SDK version. Keychain, Secure Enclave, session, and accepted App Attest key state are runtime-isolated.

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

CI must run once against only the published CocoaPods/Maven coordinates, without local path or repository overrides, before npm publication. A local native build proving source compatibility does not replace that consumer check. The manual `Published dependency consumer` workflow performs that gate; the tag-triggered release workflow repeats it before npm publication.
