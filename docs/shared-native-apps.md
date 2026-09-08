# Shared native apps — unreleased SDK source

This is not an instruction for the current npm package or native release pins.
The development bridge requires both updated native SDKs and server protocol 3 /
contract 1.1.0, with explicit required host-policy `sharedNativeCallers` opt-in.
Account-scoped component cleanup and migration are implemented in the native
source. Release packaging and physical/cross-process device acceptance remain
separate; the historical published native dependencies do not contain these APIs.

## Embedded in a native app

The host registers and activates a named native app before starting RN. Retrieve
it without setting up another Firebase Auth instance or identity callback:

```ts
import { Latchway } from '@latchway/react-native';

const app = await Latchway.getApp('production');
const state = await app.snapshot();
if (state.state !== 'active') throw new Error('Sign in through the native host.');
const client = await app.makeClient();
// Supply client to the existing feature-bound LangChain adapter.
// On screen teardown: abort this screen's tools/streams, then client.dispose().
```

Matching `Latchway.configure(options, name)` returns the same backend. Omitted
identity/security settings inherit the native registration. Redundant callbacks
do not replace its owner. New wrappers, RN remounts and configuration do not sign
in. Different accounts, environments, gateway prefixes or genuine security
boundaries remain isolated. Native/RN share one session/refresh chain and signer,
not one reusable request proof.

## Standalone app

The app's auth integration may configure an explicit JS-owned authority:

```ts
const app = await Latchway.configure({
  baseURL, applicationID, environment,
  identity: { name: 'firebase-production', issuer },
  getIdentitySnapshot: async () => {
    const user = selectedAuth.currentUser;
    if (!user) return null;
    const subject = user.uid;
    const token = await getTokenFor(user);
    if (selectedAuth.currentUser !== user || user.uid !== subject) {
      throw new Error('Identity changed while obtaining the token.');
    }
    return { issuer, subject, token };
  },
  // Supply your actual Apple or Android security options on first setup.
  ...platformSecurity,
}, 'production');
// Only an accepted login/restoration action activates the account.
const active = await app.activate();
const client = await app.makeClient();
```

If using Firebase tenants, include and recheck the selected tenant in both the
authority reference and snapshot. Keep auth ownership outside screen effects.
Native requests fail closed when a JS-owned authority cannot answer; logout
still works while JS authentication is unavailable. Native background consumers
should choose native-owned auth up front.

## Sign out versus unmount

Stop application-owned work and fence old UI/model callbacks. Capture the
generation from the accepted active snapshot, then:

```ts
if (active.generationID !== undefined) await app.logout(active.generationID);
await client.dispose();
await signOutSelectedFirebaseAuth(); // application-owned, not done by Latchway
```

`client.logout()` targets its captured generation too. Do not call first-time
logout after disposal. Successful logout is idempotent; failed cleanup is
retryable and blocks another activation. Old client/model handles never follow
a new login, including the same UID. Neither configure nor makeClient activates
an account. Logout does not require network or fetch an identity token, reset
quota, or revoke the installation. Previously dispatched requests may be billed.

Observe `app.states(signal)` to clear/disable each surface on generation changes;
its initial snapshot and monotonic revisions avoid a subscribe race. UI events
are supplementary to native fencing. On external auth changes, retire the old
captured generation before accepting the next one. On RN unmount call disposal
only; the native host's sign-out action owns full account logout.

Fast Refresh does not transfer authentication ownership. For deliberate JS
owner replacement use `app.transferIdentityAuthority` with the captured
`expectedAuthorityInstanceID`, the same immutable identity reference and a new
snapshot callback. This retires the old account first and does not activate the
replacement. A stale or competing transfer fails; never silently retry it as a
different owner.

## Dependencies and remaining evidence

Firebase, LangChain and convenience polyfills remain optional. RN 0.74+/React
18.2+ peer ranges are unchanged. Current RN0.82/React19.1 native chat consumers
and minimum RN0.74/React18.2 consumers build on iOS and Android using the explicit
local candidates. Minimum-host package/type/codegen and both Metro bundles also
pass; compilation is not physical-device or published-dependency evidence.
iOS must resolve one native SDK implementation: a separate
SPM copy plus the RN CocoaPods copy is not proven shared-registry support. Align
Android host/RN native versions too. A missing shared-app bridge returns
`native_version_incompatible`, not a fallback to duplicate legacy roots.

Apple component provisioning inherits the native registry's immutable allowlist.
On first JS-owned setup, `apple.sharedKeychainAccessGroups` declares authorized
delegated-component groups distinct from the private root. Omission on matching
configure inherits existing native configuration; it is not permission to add a
group. The native SDK validates the signed storage boundary and account generation.
Private root credentials are never exported to a component or JavaScript.

The shared account-scoped extension descriptor handoff is currently a native
Swift integration. The legacy JS extension-client constructor is not a shared
account opener; do not pass a host account or root session through JavaScript
to make it one. Host-side JS component management can use its inherited native
allowlist, while the extension opens its own native delegated credential.

Migration inventory is separate: `apple.legacySharedKeychainAccessGroups`,
`legacyComponents` and `legacyAttestationNamespaces` identify exact old SDK-owned
coordinates. An explicit `legacyComponents: []` asserts there were no historical
delegated grants; do not copy that assertion into an unaudited existing app.
Unknown/custom stores need a native host migration callback registered before
RN startup. Incomplete inventory or cleanup blocks activation instead of adopting
an unbound old session for whichever account signs in next.

`Examples/LatchwayChat` now provides standalone and native-first Swift/Kotlin
hosts, temporary native/RN chat surfaces, source-only resolution and a two-account
exercise. Its historical device receipts still describe the old released path.
Do not treat compile/bridge tests or a draft lock as package publication, physical
device proof, Play distribution evidence or immediate remote logout.
