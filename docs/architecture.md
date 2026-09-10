# React Native SDK architecture

The current source has one root lifecycle: configure a native app, supply
identity, then obtain account-bound clients. This source-breaking model is
versioned as 2.0.0; historical package receipts and tags are unchanged.

## Ownership

The core repository owns OpenAPI, error codes, canonical attestation/DPoP
bindings and the checksummed contract. Current clients use contract 1.1.0,
wire 3 and `supplied_identity_v1`; client code cannot invent a different wire
contract. `@latchway/client` provides shared transport/error concepts.

The RN SDK owns handwritten TypeScript, fetch integration, the TurboModule,
cancellation, safe error projection and response pull/backpressure. Native iOS
and Android SDKs own the app registry, account lifecycle, installation keys,
secure storage, platform attestation, DPoP and refresh coordination.
The application owns its auth provider, UI state, tools and external logout.
The gateway authenticates identity and owns trust, routing, quota and billing.

## Identity and account flow

1. Matching `Latchway.configure` calls join one native app without signing in.
   The first caller supplies public identity/security metadata; later explicit
   conflicts fail. Either native or RN may initialize first.
2. `signIn`, `restore` or account `updateIdToken` captures a native ticket
   before invoking the application's optional one-shot token producer.
3. Native verifies the supplied token through the gateway. Only a valid
   server-verified snapshot becomes fresh identity in native memory.
4. A client captures its account generation atomically. It cannot attach A's
   request to B after an intervening sign-in.
5. Identity expiry suspends protected work until a same-account update. Logout
   persists retirement, cancels work and removes freshness; no network or
   external auth callback is needed for local cleanup.

App snapshots expose safe `appInstanceID`, generation and monotonic revision
state. They do not expose identity subjects or tokens. Acquisition tickets and
optional auth-binding leases are native-owned and exclusive. JS invalidation
closes registration atomically, cancels pending tickets, releases only that
runtime's binding and closes its clients. A late native completion cannot
publish a client or binding after runtime destruction. It does not log out the
shared account or terminate another native/RN surface.

The current storage model is account-scoped from first use. It imports no older
root sessions and exposes no inventory/cleanup callback configuration. Current
persistent logout, interrupted-cleanup retry, inactive-key retention and
component revision fences remain security mechanisms, not compatibility modes.

## Authenticated transport

JavaScript validates exact origin, feature/path, headers and bounded request
body before native dispatch. Native repeats the checks, verifies the account
and identity fence, establishes/refreshes the device-bound session, attaches
Authorization and a distinct DPoP proof, then uses private URLSession/OkHttp.

Native retains the credential-bearing request and response task. JS receives
only an opaque response handle, status, allowlisted safe headers and pulled
response bytes. Authorization, DPoP, access/refresh tokens, private keys and
attestation evidence never appear in native outputs. The supplied external ID
token is accepted only by the explicit identity operation, never as an arbitrary
request credential.

Requests have an 8 MiB bridge ceiling; the gateway may impose a lower limit.
Pulling a WHATWG stream supplies bounded backpressure. Abort, disposal, logout,
expiry and stream cancellation fence delivery and release native work.
JavaScript never clones/replays an authenticated request. Native may retry once
only for a canonical rejection proving no upstream dispatch; iOS caps that
rejection classification at 64 KiB before exposing bytes.

The fetch subset excludes browser cookies/cache, service workers, redirects,
streaming uploads, trailers and native response URL metadata.
`fetchFor(feature)` fixes the protocol/feature and aliases the canonical
`X-Latchway-Request-ID` as `X-Request-ID` for framework correlation. The runtime
owns framework/caller attribution; callers cannot spoof protocol headers.

## Current Apple components

The configured app's immutable allowlist approves delegated component groups.
Each differs from the signed root-private group. Host provisioning is
account-bound and records the public coordinate before creating a key/grant.
The extension receives a native-produced opaque account handoff, not an ID
token, key or root session. The native handoff binds the same gateway, app,
environment and generation; the extension checks its live persistent fence.

Root/component retirement and revision-checked Keychain writes prevent stale
cross-process refresh completion or buffered bytes from reviving a retired
account. An old descriptor cannot open a new account. Closing one extension
handle does not log out its containing app.

Only the containing iOS app produces App Attest for itself. Extensions use
independent delegated sessions and never receive its private Keychain group.
The current extension initializer requires an account descriptor; it cannot
adopt unbound storage. The bridge has no direct-extension-attestation producer.
A Swift App Intent can use the native extension SDK without hosting RN.

## Dependency and verification boundary

Resolve one native SDK in each host. Source overrides are development-only;
published dependency checks must use real npm, CocoaPods and Maven artifacts.
A separate SPM copy plus the RN pod is not a shared registry. Codegen output is
disposable plumbing, not a public API.

Deterministic tests cover identity acquisition, expiry, account races, disposal,
bridge validation, response cancellation and redaction. Native builds prove
compilation; registry consumers prove package resolution. Neither proves real
App Attest, Play distribution or extension-process entitlement/race behavior.
Previously recorded release/device evidence does not automatically cover this
new source-breaking cleanup.

Errors expose bounded, redacted metadata. Canonical documentation URLs must
match their codes. Preserve `operation_indeterminate`'s validated operation ID
for reconciliation; never treat an uncertain dispatch as safe to replay.
