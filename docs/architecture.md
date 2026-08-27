# React Native SDK Architecture

## Status

This document fixes the ownership and dependency boundaries for the planned
React Native SDK. It does not describe an existing implementation. npm, native,
and code-generation manifests, production modules, generated models, and
contract.lock will be introduced only after the core repository publishes an
authoritative contract bundle.

## System boundary

The React Native application supplies an identity token from its existing
identity provider and a request intended for its configured Latchway gateway.
The JavaScript API selects a feature and coordinates transport while native SDKs
prove installation-key possession, obtain device-bound sessions, and protect
sensitive state. The gateway authenticates, authorizes, meters, and injects the
upstream provider credential.

The SDK never receives the upstream credential and never decides server-owned
facts such as user ID, plan, attestation level, organization, route, upstream,
price, or usage.

## Contract ownership

The Latchway core repository exclusively owns:

- Client session OpenAPI
- Error-code registry and retry guidance
- Protocol-version and compatibility manifest
- Canonical attestation-binding encoding
- DPoP and attestation test vectors
- Canonical request examples
- The checksummed contract release bundle

This repository consumes those artifacts through compatible JavaScript and
native releases. A contract update must verify checksums, update contract.lock,
regenerate only internal types, run shared vectors, and pass conformance against
the exact core image. Generated TurboModule or wire types must not become the
public TypeScript API.

## Dependency direction

~~~text
@latchway/react-native
    |
    +-- @latchway/client
    |     Shared TypeScript transport concepts and error mapping
    |
    +-- Latchway Swift package
    |     Secure Enclave, Keychain, App Attest, DPoP signing, native state
    |
    +-- dev.latchway Android artifacts
          Android Keystore, StrongBox, Play Integrity, DPoP signing,
          native state
~~~

Dependencies flow in this direction only. The native SDKs do not depend on
React Native. This repository must not fork or copy their cryptographic or
attestation implementations.

## Runtime ownership

JavaScript owns:

- The ergonomic public API and fetch wrapper
- Feature selection
- Stable error mapping
- Diagnostics presentation
- Request and response objects visible to the application

Native code owns:

- Installation keys and public-key operations
- App Attest or Play Integrity evidence
- DPoP signing
- Refresh-token storage
- Installation and session state
- Hardware-capability diagnostics

The TurboModule boundary exposes the minimum typed operations needed by the
public API. Private keys, refresh tokens, and raw attestation evidence never
cross into JavaScript. C++ code is bridge infrastructure, not a new security
implementation.

## Transport and version boundary

The JavaScript layer preserves request cancellation and streamed responses.
Native failures cross the bridge as stable, redacted errors. Automatic retry is
prohibited when dispatch outcome is uncertain.

Published package metadata selects compatible released native dependencies.
Local Swift overrides and Gradle composite builds exist only in development
examples. Every release declares an exact contract compatibility range and
must fail clearly when native, JavaScript, or server protocol versions are
incompatible.

## Verification boundary

Unit tests own public API, error mapping, and bridge serialization. Generated
TurboModule checks prove schema drift is absent. Native integration tests prove
delegation without exposing secrets. Example applications test local overrides
and released-package resolution. Cross-repository conformance validates shared
DPoP vectors, refresh, revocation, streaming, quota, and protocol rejection on
both platforms against the exact core image.

## Non-goals

This repository does not own server policy, provider routing, quota
enforcement, user-authentication UI, upstream secrets, native cryptography,
native attestation verification, AI request modeling, or independent platform
session storage.
