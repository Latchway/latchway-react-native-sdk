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

## Attestation

App Attest and Play Integrity run entirely in their native SDK providers. Server `client_data_hash`/request-hash bindings are consumed internally. JavaScript cannot provide evidence or claim a trust result. Disabling App Attest or omitting the Android cloud project fails closed when the server requires that provider.

The direct iOS component step-up uses a distinct client created only inside the
signed extension process; a containing-app process fails configuration and a
root native lease is never reused. It accepts only a public component
descriptor and selects `react_native_ios`, which the iOS SDK checks against the
stored and rotated component grants before network or state replacement. The
component-scoped provider, version-2 challenge, evidence, exchange, and session
rotation remain in the iOS SDK; only redacted diagnostics, including the
server-validated `delegated_direct_attested` source, can return. Do not add an
evidence/token escape hatch for Android while its native SDK lacks the same
operation: the React Native bridge deliberately returns
`attestation_unsupported`.

## Dispatch, replay, and redirects

JavaScript validates the exact gateway origin and allowed data-plane path, rejects fragments and decoded credential-query names, strips credential and native-owned headers, and buffers at most 8 MiB of request body before native dispatch. Native repeats the origin/path check, attaches session credentials, refuses redirects, and retains the response task. JavaScript receives a strict safe-header allowlist and pulls at most one bounded response chunk at a time. Abort and stream cancellation cancel the active native operation and close the opaque response handle. JavaScript never clones or replays an authenticated request; only the locked native transport may perform its validated, one-time pre-dispatch retry. On iOS, the feature transport owns a private URL session and caps classification of the first canonical rejection at 64 KiB before it may retry.

## Reporting

Follow [SECURITY.md](../SECURITY.md). Reproduce with synthetic tokens and evidence. Never attach live identity/session credentials, DPoP proofs, attestation objects, private keys, provider credentials, or signing files.
