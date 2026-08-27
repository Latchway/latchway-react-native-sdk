# Native installation

## iOS

The podspec pins `Latchway/AppAttest` 0.1.0 and React Native codegen dependencies. Run CocoaPods from the host application after installing the npm package. Enable App Attest for the application identifier and use a real device for conformance; simulators report attestation unsupported.

The bridge constructs `LatchwayAppAttestProvider(applicationID:environment:clientRuntime:.reactNativeIOS)`, selects `.reactNativeIOS`, and sets the independent React Native SDK version. Keychain, Secure Enclave, session, and accepted App Attest key state are runtime-isolated.

For local native SDK work, declare the sibling `Latchway.podspec` by path in the example/host Podfile before `use_react_native!`:

```ruby
pod "Latchway", path: "../../../latchway-ios-sdk"
```

Local paths belong only in the host Podfile. They are absent from the published React Native podspec.

## Android

The library pins the native 0.1.0 Maven coordinates. Play Integrity requires the decimal Google Cloud project number in `android.playIntegrityCloudProjectNumber`; JavaScript never receives or supplies the resulting integrity token.

For local native SDK work, publish the native artifacts to a disposable Maven repository and set one of:

```sh
./android/gradlew -p android -PlatchwayNativeRepository=/absolute/path/to/maven check
```

```sh
LATCHWAY_NATIVE_REPOSITORY=/absolute/path/to/maven ./android/gradlew -p android check
```

The repository is content-filtered to `dev.latchway`. Composite-build substitution is intentionally avoided because the Android SDK and React Native 0.82 currently use incompatible Gradle major versions.

## Release dependency check

CI must run once against only the published CocoaPods/Maven coordinates, without local path or repository overrides, before npm publication. A local native build proving source compatibility does not replace that consumer check.
