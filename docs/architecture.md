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
4. Native repeats the exact origin and allowed-path checks, establishes or refreshes a device-bound session, signs a DPoP proof, attaches native-owned protocol headers, and dispatches through its private URLSession or OkHttp client.
5. Native refuses redirects, retains the credential-bearing request and response task, and returns only an opaque response identifier, status, and allowlisted safe headers.
6. A WHATWG `ReadableStream` pulls bounded base64 response chunks through the TurboModule. Pull demand supplies bridge backpressure; abort, reader cancellation, EOF, client disposal, and invalid metadata all finish or cancel the native handle. JavaScript never clones or replays an authenticated request. Android's locked authenticator and iOS's locked feature transport exclusively own the contract-safe, one-time pre-dispatch retry; iOS bounds rejection classification to 64 KiB before any response bytes become visible.

Authorization, DPoP, access tokens, refresh tokens, private keys, and attestation evidence never appear in a native return value. Response bodies are application data, not credential envelopes, and remain incrementally delivered rather than eagerly buffered.

Direct iOS component attestation uses a separate extension-process client, not
the containing app's root client or lease. JavaScript running inside the signed
`.appex` supplies one validated public component descriptor; native
configuration rejects a containing-app process, selects `.reactNativeIOS`,
retains a `LatchwayExtensionClient`, and constructs a component-namespaced
`LatchwayAppAttestProvider`. The pinned iOS SDK alone creates the version-2
challenge/evidence exchange and rotates the component session. A second bridge
operation returns only `LatchwayComponentDiagnostics`, including the composite
`delegated_direct_attested` trust source. The identity callback is not invoked,
and challenge bytes, evidence, component credentials, and DPoP material never
cross the TurboModule. Android reports `attestation_unsupported` until its
native SDK owns an equivalent operation.

The bridge intentionally implements a bounded fetch subset: method, headers,
an at-most-8-MiB buffered request body, cancellation, response metadata, and a
pull-driven response stream. Browser cookie/cache modes, service workers,
redirect following, streaming uploads, response trailers, and native response
URL metadata are outside this transport. Framework compatibility therefore
depends on a real custom-fetch seam and the framework's React Native support;
the presence of `fetchFor` alone is not a version-support claim.

## Coordination

A module-global root lease map is keyed by native-module identity plus gateway/application/environment scope. A separate component lease map adds the component definition and never aliases the root map. Equivalent clients reuse one native client and configuration promise; conflicting security configuration for an active scope is rejected. Reference-counted disposal drops the native object only after the last JavaScript client leaves. The native iOS actor and Android coordinator/mutex prevent session establishment and refresh stampedes.

Native persistence namespaces include `react_native_ios` or `react_native_android`. The bridge configures the paired runtime identity, so challenge/grant platform and `X-Latchway-SDK: react-native` cannot disagree. Native compatibility JSON is checked against draft contract 1.0.0 and current wire protocol 2 before any operation.

## TurboModule boundary

The handwritten spec carries root and component configuration as distinct operations, a bounded request description, the root client's transient application identity token, opaque response-handle start/read/close operations, quota/diagnostic results, a public component descriptor for direct iOS attestation, cancellation, and disposal. The component operations have no identity-token argument. The spec has no authorization-envelope operation and does not return or accept provider attestation evidence, Play request hashes, App Attest client-data hashes, session tokens, DPoP proofs, or key material. Generated Objective-C++ and Java specs are disposable codegen output, not public API.

## Native dependencies

Published package metadata pins release coordinates. CocoaPods consumes `Latchway/AppAttest` 1.0.0. Gradle consumes `dev.latchway:latchway-okhttp:1.0.0` and `dev.latchway:latchway-play-integrity:1.0.0`. Development may point `LATCHWAY_NATIVE_REPOSITORY` or `-PlatchwayNativeRepository` at a locally published Maven repository; local file links never enter npm metadata.

## Diagnostics and errors

Diagnostics contain version compatibility, platform, secure key-storage category, attestation support/provider, session state/expiration, installation ID/status, server version, and last request/error identifiers. Component diagnostics add only family/component IDs, public definition/access-group identifiers, key/session/grant availability, trust provenance/expiry, and a containing-app action flag. Native key IDs, JWK thumbprints, tokens, proofs, and evidence are excluded. Native errors are bounded, control-character stripped, secret-pattern redacted, and mapped to the shared `LatchwayError` taxonomy. `operation_indeterminate` alone carries a required canonical reconciliation ID through both native bridges; malformed, missing, contradictory, or otherwise attached operation metadata fails closed.

## Verification boundary

Unit and Node conformance tests own public request shaping, fail-closed
credential-output checks, response pull/backpressure, error projection,
cancellation, coordination, strict-CSP behavior, and
canonical vectors. Reproducible code generation proves the handwritten schema
remains valid. Native consumer builds prove released dependency resolution and
bridge compilation. Physical-device conformance proves real App Attest and Play
Integrity behavior, session rotation, quota, streaming, diagnostics, and
revocation against the exact core image.

## Non-goals

This package does not own server policy, provider routing, quota enforcement,
user-authentication UI, AI request modeling, upstream secrets, native
cryptography, native attestation verification, or an independent session store.
