# React Native SDK architecture

## Dependency and trust boundary

```text
React Native application
  └─ @latchway/react-native
       ├─ @latchway/client 1.0.0 (errors and shared transport concepts)
       ├─ Latchway/AppAttest 1.0.0 (iOS)
       └─ dev.latchway:latchway-okhttp + latchway-play-integrity 1.0.0 (Android)
```

The core repository owns OpenAPI, error codes, attestation binding, DPoP behavior, and compatibility. This package owns the handwritten React Native API, fetch integration, TurboModule schema, cross-instance lease, abort propagation, stable error projection, and redacted diagnostics. Native SDKs exclusively own installation keys, secure session persistence, platform attestation, DPoP signing, and native single-flight.

The gateway, not the SDK, derives user, organization, plan, trust, routing,
pricing, and quota facts. The SDK never receives an upstream provider
credential or treats application-supplied values as trusted server facts.

## Contract ownership

The Latchway core repository exclusively owns the client OpenAPI, error-code
registry, protocol compatibility manifest, canonical attestation binding, DPoP
vectors, canonical request examples, and checksummed contract bundle. A
contract update must verify checksums, update `contract.lock`, regenerate only
internal types, rerun shared vectors, and pass conformance against the exact
core revision. Generated bridge and wire types do not become public API.

## Operation flow

1. JavaScript validates the origin, feature, configuration, request state, and decoded query names; provider-credential names fail before identity acquisition or dispatch.
2. The application identity callback returns an external identity JWT.
3. The TurboModule passes that JWT transiently to the native SDK while native session work runs.
4. Native code establishes or refreshes a device-bound session, signs a DPoP proof, and returns only the authorization headers and request ID required for dispatch.
5. JavaScript installs owned protocol headers and dispatches once through the configured fetch implementation.
6. A bodyless request may be authorized and dispatched one more time only after a bounded, duplicate-free, exact-field RFC 9457 document matches the canonical 401 `session_expired` or `dpop_nonce_required` definition and has a correlated request ID. Nonce challenges require one unambiguous nonce and session-expired responses must omit that header. The client request ID is preserved. A request with a body is neither cloned nor replayed and its response is returned to the application.

Native authorization results are intentionally short-lived JavaScript values because React Native fetch owns the response stream. They are never exposed through diagnostics or errors and are not stored by the package.

## Coordination

A module-global lease map is keyed by native-module identity plus gateway/application/environment scope. Equivalent clients reuse one native client and configuration promise; conflicting security configuration for an active scope is rejected. Reference-counted disposal drops the native object only after the last JavaScript client leaves. The native iOS actor and Android coordinator/mutex prevent session establishment and refresh stampedes.

Native persistence namespaces include `react_native_ios` or `react_native_android`. The bridge configures the paired runtime identity, so challenge/grant platform and `X-Latchway-SDK: react-native` cannot disagree. Native compatibility JSON is checked against contract 0.4.0 and wire protocol 1 before any operation.

## TurboModule boundary

The handwritten spec carries configuration, URL/method/feature/optional server nonce, transient application identity token, quota/diagnostic results, cancellation, and disposal. It does not accept provider attestation evidence, Play request hashes, App Attest client-data hashes, session tokens, DPoP proofs, or key material. Generated Objective-C++ and Java specs are disposable codegen output, not public API.

## Native dependencies

Published package metadata pins release coordinates. CocoaPods consumes `Latchway/AppAttest` 1.0.0. Gradle consumes `dev.latchway:latchway-okhttp:1.0.0` and `dev.latchway:latchway-play-integrity:1.0.0`. Development may point `LATCHWAY_NATIVE_REPOSITORY` or `-PlatchwayNativeRepository` at a locally published Maven repository; local file links never enter npm metadata.

## Diagnostics and errors

Diagnostics contain version compatibility, platform, secure key-storage category, attestation support/provider, session state/expiration, installation ID/status, server version, and last request/error identifiers. Native key IDs, JWK thumbprints, tokens, proofs, and evidence are excluded. Native errors are bounded, control-character stripped, secret-pattern redacted, and mapped to the shared `LatchwayError` taxonomy. `operation_indeterminate` alone carries a required canonical reconciliation ID through both native bridges; malformed, missing, contradictory, or otherwise attached operation metadata fails closed.

## Verification boundary

Unit and Node conformance tests own public request shaping, error projection,
bridge serialization, cancellation, coordination, strict-CSP behavior, and
canonical vectors. Reproducible code generation proves the handwritten schema
remains valid. Native consumer builds prove released dependency resolution and
bridge compilation. Physical-device conformance proves real App Attest and Play
Integrity behavior, session rotation, quota, streaming, diagnostics, and
revocation against the exact core image.

## Non-goals

This package does not own server policy, provider routing, quota enforcement,
user-authentication UI, AI request modeling, upstream secrets, native
cryptography, native attestation verification, or an independent session store.
