# Latchway React Native SDK

Latchway lets React Native applications call AI infrastructure through a
self-hosted gateway without embedding an upstream provider key. This repository
will provide an ergonomic TypeScript API backed by the platform-native Latchway
SDKs.

> **Project status:** Governance foundation only. No npm or native package
> manifests and no supported release exist yet. Do not add this repository as a
> dependency.

## Planned scope

The package **@latchway/react-native** will use the React Native New
Architecture and TurboModules for the supported baseline.

JavaScript owns the ergonomic client API, fetch wrapper, feature selection,
error mapping, and diagnostics presentation. Native dependencies own the
installation key, attestation, refresh-token storage, DPoP signing, and
installation state:

- The iOS bridge delegates to the Latchway Swift SDK
- The Android bridge delegates to the Latchway Kotlin SDK
- Shared TypeScript transport concepts depend on **@latchway/client**

This repository will not reimplement App Attest, Play Integrity, Secure Enclave,
or Android Keystore behavior in TypeScript, C++, or bridge glue.

## Protocol ownership

The Latchway core repository owns the client OpenAPI description, error
registry, protocol manifest, canonical attestation binding, DPoP vectors, and
compatibility rules. This SDK consumes a signed and checksummed contract bundle
through its JavaScript and native dependencies; it does not define an
independent wire protocol.

A contract lock is intentionally absent until the core repository publishes the
first bundle. See [Architecture](docs/architecture.md) for the dependency and
trust boundaries.

## Security model

Sensitive installation state remains native. The JavaScript bridge exposes only
the minimum values required by the public API and diagnostics, with credentials
and attestation evidence redacted. The SDK never receives an upstream
AI-provider credential and does not replace the application's identity
provider.

Review [Security Policy](SECURITY.md) before reporting a vulnerability.

## Development

Build and test commands will be added with the npm and native package manifests.
Until then, changes in this repository are limited to reviewed governance,
architecture, and dependency-boundary foundations.

See [Contributing](CONTRIBUTING.md) and [Agent Instructions](AGENTS.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
