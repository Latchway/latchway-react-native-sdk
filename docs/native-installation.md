# Native installation

React Native 2.0.0 uses the fresh shared-account model and pins iOS 2.0.0 plus
Android 1.2.1. Install Pods and rebuild both native apps; bridge ABI 3 is not
compatible with an older JS/native bundle. Historical artifacts are unchanged.

For React Native 0.74 hosts, follow the complete
[minimum-version toolchain and New Architecture setup](react-native-compatibility.md).

## iOS application

Configure `apple.rootKeychainAccessGroup` with the fully resolved private app-ID
group that appears first in the signed root target. The native SDK proves that
boundary before root key/session operations. Root credentials never use an
extension group or an implicit shared-first group.

If using delegated extensions, declare their current approved groups in
`apple.sharedKeychainAccessGroups`. Each group must be explicit, fully resolved,
distinct from the root group and authorized by the target's signed entitlement.
Omission at first registration means no delegated groups. Equivalent later
configure calls inherit the immutable allowlist.

```ts
const app = await Latchway.configure({
  baseURL, applicationID, environment, identity,
  apple: {
    rootKeychainAccessGroup: 'YOURPREFIX.com.example.app',
    sharedKeychainAccessGroups: ['YOURPREFIX.com.example.app.widget'],
  },
});
```

Use the actual App ID prefix from signing; it can differ from the Team ID.
Literal `$(AppIdentifierPrefix)`, missing entitlements and invalid groups fail.
Fresh account storage does not require inventory of prior SDK stores or invoke
a migration callback.

Install the native pods selected by the matching RN package/source configuration,
then rebuild the app. Keep a single native implementation: do not also link
another SPM copy into the host. Local source paths belong only in development
host configuration, never the published RN podspec.

Enable App Attest on the application identifier. Real attestation requires a
supported physical iPhone/iPad, a matching bundle/team/profile, consistent
development/production App Attest policy, and a valid application identity token.
A simulator cannot substitute for that proof. The SDK constructs the default
native App Attest provider; application code supplies identity separately.

To use local device builds and TestFlight against the same development gateway,
see [development attestation](development-attestation.md). Apple environment
acceptance is server-owned; there is no new JavaScript App Attest environment flag.

Firebase is not part of Latchway's dependency graph. An app may own Firebase
Auth or any supported issuer's SDK and forward tokens through supplied-identity
APIs. Firebase Auth, Firebase App Check and gateway App Attest are distinct;
one does not substitute for another.

## iOS delegated extensions

The containing app signs with its private group first, followed by separate
component groups. Each extension signs with only its own group and never the
root-private or a sibling's group. Every signed group must be permitted by its
provisioning profile. The extension must not carry an App Attest entitlement.

Host operations use the captured account's client:

- `prepareComponents` provisions approved descriptors;
- `replaceComponent` replaces one component;
- `componentDiagnostics` returns safe local state;
- `revokeComponent` retires one component; and
- explicit family revocation retires the current registered family.

Normal logout uses `app.signOut()`, not installation revocation. It persists
account/component retirement and fences existing work even offline, including
pending identity acquisition and interrupted cleanup. Use `account.logout()`
only when deliberately targeting that captured account generation.

A descriptor contains a definition ID, kind, fully resolved component Keychain
group and requested features. Native code validates it against the registered
allowlist and gateway policy, and records its coordinate before component state
can be created. Keys, grants and sessions stay native and account-scoped.
Failed cleanup remains journaled for retry; an old handle cannot open a new
account's component.

An extension client requires the explicit current `LatchwayComponentAccount`
handoff created by the root client's native `componentAccount()`. This is a
non-secret generation descriptor, not a root credential. The Swift extension
initializer takes gateway/application/environment, the component and account;
it takes no root-private group or identity token. A genuinely RN-hosted extension
uses the account-bound component bridge. The root's
`await client.componentAccount()` returns an opaque string produced natively;
pass it unchanged, not a JavaScript user ID or invented scope:

```ts
const handoff = await client.componentAccount();
// Transfer only this non-secret descriptor through an authorized container.
// In the separate signed RN-hosted extension process:
const componentClient = createLatchwayComponentClient({
  baseURL, applicationID, environment, component, account: handoff,
});
const diagnostics = await componentClient.diagnostics();
```

The root-private group and application identity are not component-client
options. There is no unbound extension storage path. This diagnostic call does
not by itself prove delegated request execution. The handoff is iOS-specific;
Android rejects that operation explicitly.

Application extensions remain delegated-only. They cannot call
`DCAppAttestService.generateKey`; the host cannot attest on their behalf.
Use `Latchway/AppExtensions` in the extension target. An App Intent implemented
in Swift does not need a React Native runtime. Source examples and signed
physical extension checks are separate; compiling an intent is not proof of
entitlement isolation, delegated networking or a cross-process logout race.

## Android application

The native authentication owner calls `app.signOut()` on the shared app even
when RN has not mounted; Swift uses `try await app.signOut()`, and Kotlin uses
the suspend function. Await cleanup before accepting another account. External
Firebase or other auth-provider logout is still application-owned.

Supply the decimal Google Cloud project number in
`android.playIntegrityCloudProjectNumber`. JavaScript does not receive or
supply the resulting Play Integrity token. Normal configure installs the native
default provider and does not require a Firebase integration artifact.

The native SDK and bridge compile against API 34. Native artifacts publish
Kotlin 2.3 metadata; use the compatible host toolchain described in
[React Native compatibility](react-native-compatibility.md). The host's target
SDK and other dependencies may require a newer compile SDK. React Native and
Codegen resolve from the host; the library does not install another RN runtime.

A production Play Integrity check requires a physical device and an app whose
package and signing-certificate digest match gateway policy. Enable Play
Integrity for the project, publish the build to a Play track and install it
from Google Play. A sideloaded Debug APK is only compilation/bridge evidence.
Do not relax recognized/licensed or hardware policies merely to pass a test.

Google Play Console test responses can exercise a deliberately scoped
development policy. They retain `debug` trust, require no client bypass flag,
and are not production evidence. See [development attestation](development-attestation.md).

## Source and release checks

The LatchwayChat example documents its explicit source-development toggle.
Keep local CocoaPods/Maven paths confined to that development setup. Published
consumers must resolve only released coordinates without source overrides;
inspect both native dependency graphs and rebuild the application.

A successful source build is not publication evidence, and an old published
lockfile does not prove this cleanup. Run matching SDK, bridge and account
lifecycle tests before any new release. Real App Attest, Play distribution,
extensions and physical account-transition tests retain their separate scope.
