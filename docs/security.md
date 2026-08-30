# Security guidance

## Application responsibilities

- Supply an identity JWT only from the signed-in application's identity provider. Do not persist it for Latchway.
- Configure a gateway origin, never an upstream provider endpoint.
- Never add provider keys, service-account credentials, App Attest evidence, or Play Integrity tokens to options or request headers.
- Use `client.fetch` or `client.fetchFor(feature)`. No credential-bearing `Request` or authorization envelope is available to JavaScript.
- Display only `LatchwayError.code`, status, request ID, canonical operation ID, retryability, and the already-sanitized message. Preserve an `operation_indeterminate` operation ID for reconciliation rather than automatic replay.
- Call `revokeCurrentInstallation()` for explicit removal of the current installation. Call `revokeCurrentInstallationFamily()` when sign-out must revoke every component in the wire-v2 family and retire the root native key. `dispose()` alone deliberately preserves secure installation state.

## Key policy

iOS defaults to Secure Enclave with software fallback disallowed. Android defaults to StrongBox preferred with software-backed keys disallowed. Relaxation is explicit (`apple.softwareKeyFallbackPolicy: "allow"` or `android.keyPolicy: "software_allowed"`) and changes the trust properties reported by the server. Do not silently enable fallback after a native failure.

The iOS root client and App Attest provider receive the same explicit private
Keychain group and the same bounded list of extension-shared groups. Root
keys, sessions, and App Attest state never use an implicit shared group. The
App Intents/component path continues to use only its exact shared component
group and constructs no root App Attest provider.

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
lease; it retains independently keyed, component-scoped delegated sessions and
returns only redacted diagnostics. Direct-attestation entry points and trust
source decoders remain for API/wire compatibility, but invocation fails closed
with `attestation_unsupported` on both platforms and must not be treated as a
reachable trust result.

React Native v1 has no delegated component request API. The example App
Intents target does not host React Native or call the component bridge and its
intent fails closed; do not treat its build, installation, or invocation as
delegated-request evidence.

## Dispatch, replay, and redirects

JavaScript validates the exact gateway origin and allowed data-plane path, rejects fragments and decoded credential-query names, strips credential and native-owned headers, and buffers at most 8 MiB of request body before native dispatch. Native repeats the origin/path check, attaches session credentials, refuses redirects, and retains the response task. JavaScript receives a strict safe-header allowlist and pulls at most one bounded response chunk at a time. Abort and stream cancellation cancel the active native operation and close the opaque response handle. JavaScript never clones or replays an authenticated request; only the locked native transport may perform its validated, one-time pre-dispatch retry. On iOS, the feature transport owns a private URL session and caps classification of the first canonical rejection at 64 KiB before it may retry.

## Reporting

Follow [SECURITY.md](../SECURITY.md). Reproduce with synthetic tokens and evidence. Never attach live identity/session credentials, DPoP proofs, attestation objects, private keys, provider credentials, or signing files.
