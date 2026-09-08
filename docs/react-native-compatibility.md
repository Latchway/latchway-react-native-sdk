# React Native compatibility

The expanded range below starts in `@latchway/react-native@1.1.3`.
Versions through 1.1.2 declare React Native 0.82 / React 19.1.

## Peer range and tested versions

| Host | React | Architecture |
| --- | --- | --- |
| Minimum: React Native 0.74.0 | 18.2.0 | New Architecture enabled explicitly |
| Main development/example: React Native 0.82.0 | 19.1.1 | New Architecture |

The package admits React Native `>=0.74.0 <1.0.0` and React
`^18.2.0 || ^19.0.0`. These are not independently interchangeable: use the React
version required by your React Native release. The broader RN peer range allows
newer 0.x releases without requiring a package metadata update. It is not a
guarantee that every minor release has been tested: current validation covers
0.74.0 and 0.82.0 as described below. RN 1.0 and later remain excluded.
RN 0.73 and earlier lack the Android `BaseReactPackage`
API used by this bridge and are not supported. Legacy Architecture is not
supported, including on React Native releases where it remains the default.

The minimum applies to the Latchway SDK, not every optional Firebase, LangChain,
navigation or UI package in an application. LatchwayChat keeps its separate
React Native 0.82, React 19.1 and Firebase dependency locks.

## Android host settings

### Version 1.2.0 setup

The Android 1.1.0 SDK and RN 1.2.0 bridge compile against API
34, with `minCompileSdk = 34` in their AAR metadata. Android native runtime
minimum remains 23; the RN bridge runtime minimum remains 24. No Firebase,
Play Integrity or Kotlin dependency downgrade is part of this change.

The RN package pins native Android `1.1.0`. Historical native `1.0.0` and npm
`1.1.3` artifacts still have their original API 37 constraint; upgrading the RN
package and rebuilding the host is required to receive the new baseline.

An app may still need a newer compile SDK for its React Native/Firebase/UI
dependencies. LatchwayChat retains its own newer compile/target settings;
this change does not lower app target SDK or
alter Google Play publishing requirements.

Enable New Architecture and Hermes in `android/gradle.properties`:

```properties
newArchEnabled=true
hermesEnabled=true
react.internal.disableJavaVersionAlignment=true
```

The native Latchway 1.1.0 artifacts require compile SDK 34 and publish Kotlin
2.3 metadata. The minimum-version fixture uses checksum-pinned Gradle 8.13,
Android Gradle Plugin 8.12.0, Kotlin 2.3.21, JDK 17, build tools 36.0.0 and
NDK 27.1.12297006. It uses compile SDK 34.
Use Android API 24 or newer as the minimum device version. The default
React Native 0.74 template's Kotlin 1.9 settings are not enough.

The alignment property above bypasses only the older build plugin's Kotlin-1.9-specific
automatic target configuration. Pair it with the explicit Java 17
`compileOptions` and Kotlin `compilerOptions.jvmTarget` configuration in the
fixture's root build file. Do not disable Kotlin target validation or metadata
checks. This setting is for older RN plugins, not a requirement for the 0.82
baseline.

The RN 0.74 fixture uses the official `@react-native/gradle-plugin@0.76.9` as
a **build-only** development dependency. The original 0.74 Gradle plugin cannot
compile with Gradle 8.13. The newer build plugin does
not upgrade the app's React Native runtime or its Codegen: those remain exactly
0.74.0 and 0.74.81. No React Native source is patched.

Use the fixture's [settings file](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.2.0/integration/minimum-host/android/settings.gradle)
and [app build setup](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.2.0/integration/minimum-host/android/app/build.gradle) to
enable the plugin's settings-based autolinking. Remove the old
`native_modules.gradle` apply lines; do not run both autolinking mechanisms.
The library resolves its React Native Maven version and Codegen location from
the host, so it does not bring a second RN runtime.

```sh
npm install --save-dev --save-exact @react-native/gradle-plugin@0.76.9
```

In `android/app/build.gradle`, after applying `com.facebook.react`, apply the
SDK's version-guarded adapter:

```groovy
apply from: file("../../node_modules/@latchway/react-native/android/react-native-074.gradle")

react {
    autolinkLibrariesWithApp()
}
```

RN 0.74's CMake consumes the old `rncli` generated filenames and provider names.
The adapter maps the modern plugin's generated output to those names and keeps
the unmerged RN 0.74 native-library layout. It does not edit installed RN source,
replace the TurboModule implementation, or perform a second module discovery.
It refuses other runtime/plugin pairs and Legacy Architecture. Use this adapter
only for the documented 0.74 setup, not for the 0.82 example.

Finalize the Java 17 compile options in `androidComponents.finalizeDsl`, as the
root fixture does. Configuring them only when Kotlin tasks are realized can
leave AGP's global-synthetics DEX output unregistered for Debug APK packaging.

See the copyable [minimum host build settings](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.2.0/integration/minimum-host/android/build.gradle).
Retain normal application signing and Play Integrity configuration; the minimum
host is a compile/registration check, not a Play-distributed test application.

## iOS host settings

Use an Xcode toolchain with Swift 6, an iOS deployment target at least 15.0
(or the higher minimum required by the host RN release), and CocoaPods.
The minimum fixture uses iOS 15.1 and static frameworks. Enable New Architecture
before installing pods:

```sh
cd ios
RCT_NEW_ARCH_ENABLED=1 pod install
```

For reproducible installation, set `ENV['RCT_NEW_ARCH_ENABLED'] = '1'` in the
Podfile as well. See the [minimum host Podfile](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.2.0/integration/minimum-host/ios/Podfile).
App Attest entitlements, root-private Keychain access groups and real-device
verification remain necessary for authenticated production requests.

If the older host is entirely Objective-C, add a Swift file to the application
target (an `import Foundation` file is sufficient), set Swift language version
6 and enable `ALWAYS_EMBED_SWIFT_STANDARD_LIBRARIES`. This lets Xcode link the
Swift compatibility libraries needed by the native pods. The fixture's Podfile
adds its [Swift compilation unit](https://github.com/Latchway/latchway-react-native-sdk/blob/v1.2.0/integration/minimum-host/ios/HelloWorld/SwiftRuntime.swift)
to the target. Hosts that already contain Swift do not need another dummy file.

## Verify the minimum locally

Build and pack this checkout, then run the isolated host:

```sh
pnpm build
pnpm pack --pack-destination /absolute/path/to/archives
pnpm compatibility:minimum --tarball /absolute/path/to/archives/latchway-react-native-1.2.0.tgz --keep
```

The check installs the actual archive with strict npm peer validation, asserts
that the SDK resolves React 18.2.0 and RN 0.74.0 from the host, type-checks its
public API, generates all 20 native methods, and bundles both platforms with
the 0.74 Metro configuration. The RN template and native Latchway dependencies
come from published packages, not sibling source overrides.

Add `--android` and/or `--ios` to build the real application. `--ios --ios-device`
selects an unsigned device-target build when no simulator platform is installed;
it does not install or run the app on a device. `JAVA_HOME`,
`ANDROID_HOME` and optionally `DEVELOPER_DIR` must select installed compatible
toolchains. `--keep` preserves the disposable app for inspection; failures also
preserve it. The app imports the public SDK and requires the real native module.
It does not use the injectable test bridge, contact a gateway, or claim physical
App Attest / Play Integrity verification.

The fixture uses npm overrides that point React, RN and React types back to
their exact root dependencies. This prevents newer npm resolvers from selecting
a second RN through the old VirtualizedLists wildcard peer cycle. It does not
disable peer checks; no `--force` or `--legacy-peer-deps` is used.

Codegen 0.74's CLI also needs `yargs@17.7.2` as a host development dependency
when the dependency tree does not already provide it (`parseSync is not a
function` otherwise). It is not added to Latchway's runtime dependencies.
The package's existing Node 24.19+ engine requirement is unchanged.

## Verification scope

Run the checks above for the selected release and keep their output as evidence.
Package/type/Codegen/Metro checks do not imply a native build; native builds do
not imply physical App Attest or Play Integrity acceptance. Historical 1.1.3
minimum-host builds used native 1.0.0; do not reuse those receipts as proof of
the new supplied-identity API.
