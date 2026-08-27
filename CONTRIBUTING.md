# Contributing to Latchway React Native SDK

Thank you for helping build Latchway. This repository implements the React
Native client against the contract recorded in `contract.lock`. Protocol or
native-security changes must begin in their owning repository and update this
package only after a compatible native release exists.

## Before making a change

1. Read AGENTS.md and docs/architecture.md.
2. Confirm which repository owns the behavior. Wire protocol changes begin in
   the Latchway core repository; platform-security changes begin in the
   corresponding native SDK.
3. Keep the change to one reviewable concern and explain its security impact.
4. Never commit credentials, signing material, identity tokens, attestation
   evidence, device data, or local environment files.

## Design and implementation rules

- Public TypeScript APIs are handwritten and mirror the JavaScript SDK where
  practical. Generated TurboModule and wire types are not public API.
- Use the React Native New Architecture and TurboModules for the supported
  baseline.
- Depend on the iOS and Android SDKs for hardware keys, DPoP signing,
  attestation, secure refresh storage, and installation state.
- Do not reimplement App Attest, Play Integrity, Secure Enclave, or Android
  Keystore behavior in TypeScript, C++, or bridge glue.
- Do not create a local wire format or change `contract.lock` without a
  reviewed core contract bundle.
- Do not leave production-path placeholders or hard-coded success behavior.

## Tests

Every functional change must include proportionate unit tests. Bridge or
protocol work also requires TurboModule code-generation, shared-vector, native
integration, example-app, and released-package conformance coverage.
Cancellation, streaming, redaction, version mismatch, and bridge data exposure
must be tested explicitly.

Use Node 24.19.0 and pnpm 10.15.0. Run `pnpm check`, `pnpm pack:check`, and
`pnpm verify:reproducible` before review. Native bridge changes also require
`pnpm ios:spec`, an iOS consumer compile, and an Android consumer compile
against released native artifacts. Record honest device, credential, artifact,
or toolchain blockers; never replace them with a stubbed security result.

## Pull requests

Use focused commits with conventional subjects such as feat(react-native),
fix(bridge), test(conformance), or docs(security). Describe compatibility impact
across JavaScript, iOS, Android, and React Native, plus tests run. Generated
changes must be reproducible and reviewed with their source definitions.

By contributing, you agree that your contribution is licensed under the
Apache License, Version 2.0.
