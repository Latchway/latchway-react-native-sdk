# Security guidance

## Application responsibilities

- Supply an identity JWT only from the signed-in application's identity provider. Do not persist it for Latchway.
- Configure a gateway origin, never an upstream provider endpoint.
- Never add provider keys, service-account credentials, App Attest evidence, or Play Integrity tokens to options or request headers.
- Treat an authorized `Request` as credential-bearing and short-lived. Prefer `client.fetch` and never log or cache the returned request or its headers.
- Display only `LatchwayError.code`, status, request ID, retryability, and the already-sanitized message.
- Call `revokeCurrentInstallation()` for explicit device removal. `dispose()` alone deliberately preserves secure installation state.

## Key policy

iOS defaults to Secure Enclave with software fallback disallowed. Android defaults to StrongBox preferred with software-backed keys disallowed. Relaxation is explicit (`apple.softwareKeyFallbackPolicy: "allow"` or `android.keyPolicy: "software_allowed"`) and changes the trust properties reported by the server. Do not silently enable fallback after a native failure.

## Attestation

App Attest and Play Integrity run entirely in their native SDK providers. Server `client_data_hash`/request-hash bindings are consumed internally. JavaScript cannot provide evidence or claim a trust result. Disabling App Attest or omitting the Android cloud project fails closed when the server requires that provider.

## Replay and redirects

The wrapper rejects cross-origin authorization, strips caller credentials, requests `credentials: "omit"`, `redirect: "error"`, and a no-referrer policy, and never clones or replays a body-bearing request. A maximum of one bodyless replay is permitted only for a 401 Latchway problem marked `retryable: true` whose problem status and request ID agree with the HTTP response metadata. A missing or contradictory field fails closed and the original response is returned without refresh or replay.

## Reporting

Follow [SECURITY.md](../SECURITY.md). Reproduce with synthetic tokens and evidence. Never attach live identity/session credentials, DPoP proofs, attestation objects, private keys, provider credentials, or signing files.
