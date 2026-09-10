# Shared native and React Native apps

React Native 2.0.0 uses one supplied-identity account model. This is a
source-breaking upgrade, not a change to previously published artifacts. Follow
[developer-supplied identity](supplied-identity.md) for complete setup.

## Either team can configure first

```ts
import {Latchway, firebaseProject} from '@latchway/react-native';

const app = await Latchway.configure({
  baseURL, applicationID, environment,
  identity: firebaseProject({projectID}),
  ...platformSecurity,
}, 'production');
```

Matching native and RN configuration joins one process-wide native app. The
first caller supplies the required public identity and security settings;
omitted optional settings on later calls inherit the registered values. Explicit
conflicts fail with `configuration_conflict` rather than creating a second
session. Native startup is not a prerequisite for RN startup, and neither side
needs to install an authentication provider inside Latchway.

Configure is not login. After the application's accepted login:

```ts
const account = await app.signIn({getIdToken: () => yourAuth.getIdToken()});
const client = await account.makeClient();
```

Another surface calls `app.makeClient()` or captures `app.currentAccount()`
without signing in again. At process startup, application-auth restoration
uses `app.restore({getIdToken})`; restoration cannot undo recorded Latchway logout.
Use the same app name, gateway/application/environment and identity/security
settings in both teams' integration.

## Shared account, separate surfaces

Native and RN share the account, installation key and refresh coordinator.
Every request has its own DPoP proof. A returned account/client handle is fixed
to one generation; it never follows a later login, even for the same user.

```ts
await account.updateIdToken({getIdToken: () => yourAuth.getIdToken()});
// On screen unmount: stop this surface's streams/tools, then release its client.
await client.dispose();
// On accepted account logout, independently of screen disposal:
await app.signOut();
```

App-level sign-out is offline-capable and retires the current account, pending
sign-in, and unfinished persisted cleanup. It fences native
and RN work, persists retirement and leaves failed local cleanup retryable.
It does not call the application's auth-provider sign-out, reset per-user quota,
log out other devices or retroactively cancel work already dispatched upstream.
Serialize external login/logout changes and clear old chat/tool state before
accepting a new account. A's delayed callback must not look up B and log B out.
Use `account.logout()` only when an operation deliberately targets its captured
generation rather than the current authentication transition.

Observe `app.states(signal)` for an initial snapshot and ordered redacted state
changes. Reconcile the current generation when attaching a surface and before
committing asynchronous UI/tool results. Native checks are the security fence;
UI observations supplement them, not replace them.

The supplied token stays only in native memory. Native work can continue when
JS stops while the gateway-verified identity remains fresh. Expiry suspends
protected work with `identity_refresh_required`; a verified same-account update
resumes it without changing generation. No permanent JS callback is required.

## Native dependencies and platform policy

Resolve one native SDK implementation. On iOS, use the native SDK supplied by
the RN CocoaPods graph rather than also linking a second SPM copy. Align native
Android versions through the host's normal dependency graph. A missing or
incompatible shared-app bridge fails explicitly; there is no second root-client
fallback. See [native installation](native-installation.md).

The server must advertise `supplied_identity_v1` (server 1.1.1 or later) and
enable `sharedNativeCallers` on the required native-host attestation policy.
Native/RN sharing does not enable other platforms or loosen App Attest/Play
Integrity. Authentication remains application-owned; Firebase is optional.

## Current Apple components

The first configuration may declare `apple.sharedKeychainAccessGroups` for
approved delegated components. These are current provisioning permissions,
not storage discovery instructions. Each group must differ from the private
root group and be authorized by actual signed entitlements. Matching configure
inherits the allowlist; it cannot silently expand it.

Host-side component operations use the account-bound client. The native SDK
records each component before creating its key or credential. An extension must
receive an explicit non-secret account descriptor for that generation and open
its independently keyed delegated session. Never pass root keys, sessions or
identity through JavaScript or a shared container. An old descriptor cannot
open a new login. See [native installation](native-installation.md).

Logout and account replacement preserve persistent root/component retirement,
cross-process revision checks and cancellation of buffered response bytes.
These guarantees remain part of the fresh storage model. iOS application
extensions remain delegated-only; the host must not attest on their behalf.

## Storage and acceptance

The current implementation starts from its account-scoped storage namespace.
It does not import previous SDK sessions, scan old storage coordinates, run
application cleanup callbacks or accept inventory options. Existing published
tags remain unchanged; this source change is not an automatic upgrade path.
Do not treat uninstalling an app as proof that its Keychain state was erased.

Fresh installs, restart/restore, same-user refresh, A → B → A, offline logout,
late identity acquisition, cleanup failure and two-surface disposal must be
tested. Compilation and deterministic fixtures are not physical Play, signed
Keychain or multi-process extension evidence. See the example's
[verification scope](../Examples/LatchwayChat/SHARED_NATIVE_VERIFICATION.md).
