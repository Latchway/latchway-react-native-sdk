# Security guidance

## Application responsibilities

- Supply an identity JWT only from the signed-in application's identity provider. Do not persist it for Latchway.
- Configure a gateway origin, never an upstream provider endpoint.
- Never add provider keys, service-account credentials, App Attest evidence, or Play Integrity tokens to options or request headers.
- Use `client.fetch` or `client.fetchFor(feature)`. No credential-bearing `Request` or authorization envelope is available to JavaScript.
- Display only `LatchwayError.code`, `documentationURL`, status, request ID, canonical operation ID, retryability, and the already-sanitized message. Documentation links use `https://docs.latchway.dev/errors/<hyphenated-code>`; native server metadata fails closed unless its URL matches the code exactly. Preserve an `operation_indeterminate` operation ID for reconciliation rather than automatic replay.
- Use `app.signOut()` for normal sign-out: current-account retirement is offline-capable, fences native/RN work and current components, cancels pending identity acquisition, and preserves failed cleanup for retry. Use `account.logout()` only to target a captured account generation. Neither calls external auth sign-out or resets quotas. Installation/family revocation is a separate explicit security action. `dispose()` releases only the current surface.

## Key policy

iOS defaults to Secure Enclave with software fallback disallowed. Android defaults to StrongBox preferred with software-backed keys disallowed. Relaxation is explicit (`apple.softwareKeyFallbackPolicy: "allow"` or `android.keyPolicy: "software_allowed"`) and changes the trust properties reported by the server. Do not silently enable fallback after a native failure.

The iOS app configures an explicit root-private Keychain group and current
approved component groups. Root keys, sessions and App Attest state never use
an implicit shared group. Storage is account-scoped; no earlier session is
imported. An extension receives an explicit opaque account descriptor and uses
only its exact shared component group, without a root App Attest provider.

On iOS, sign the root target with its private app-ID Keychain group first and
the shared component group second. Keychain calls without an explicit access
group therefore default to root-private storage. Sign an extension with only
the shared group: it may use explicitly component-scoped handoff/session state,
but it cannot read the root's private keys, credentials, or sessions. Candidate
verification rejects any other signed ordering or membership and requires each
signed group to be authorized by the target's provisioning profile.

## Attestation

App Attest and Play Integrity run entirely in their native SDK providers. Server `client_data_hash`/request-hash bindings are consumed internally. JavaScript cannot provide evidence or claim a trust result. Disabling App Attest or omitting the Android cloud project fails closed when the server requires that provider.

An iOS application extension cannot call `DCAppAttestService.generateKey`.
Only the containing root application establishes App Attest for itself, and it
must never attest on an extension's behalf. The separate extension-process
client therefore constructs no App Attest provider and cannot acquire the root
lease; it retains independently keyed, account-scoped delegated sessions and
returns only redacted diagnostics. There is no public direct-extension-
attestation operation. A server protocol vocabulary entry is not evidence that
the iOS runtime can produce that trust result.

The example App Intents target does not host React Native. Its native integration
and the RN-hosted extension surface have distinct build/evidence scopes. Do not
treat a component diagnostic, build or installation as delegated-request proof.

## Dispatch, replay, and redirects

JavaScript validates the exact gateway origin and allowed data-plane path, rejects fragments and decoded credential-query names, strips credential and native-owned headers, and buffers at most 8 MiB of request body before native dispatch. Native repeats the origin/path check, attaches session credentials, refuses redirects, and retains the response task. JavaScript receives a strict safe-header allowlist and pulls at most one bounded response chunk at a time. Abort and stream cancellation cancel the active native operation and close the opaque response handle. JavaScript never clones or replays an authenticated request; only the locked native transport may perform its validated, one-time pre-dispatch retry. On iOS, the feature transport owns a private URL session and caps classification of the first canonical rejection at 64 KiB before it may retry.

## Reporting

Follow [SECURITY.md](../SECURITY.md). Reproduce with synthetic tokens and evidence. Never attach live identity/session credentials, DPoP proofs, attestation objects, private keys, provider credentials, or signing files.
