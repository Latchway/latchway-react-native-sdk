# AGENTS.md

These instructions apply to the entire Latchway React Native SDK repository.

## Mission and current phase

Build the React Native client that exposes Latchway through an ergonomic
TypeScript API while delegating sensitive platform behavior to the released iOS
and Android SDKs.

This repository currently contains governance and architecture foundations
only. Do not add npm, CocoaPods, Gradle, code-generation, or production source
manifests and do not add contract.lock until the core repository has published
the corresponding contract bundle and the active implementation phase
authorizes that work. Never invent a temporary wire contract or fake production
behavior.

## Authority and dependency boundaries

- The Latchway core repository is the sole owner of the client OpenAPI,
  protocol manifest, error codes, canonical attestation binding, DPoP vectors,
  and compatibility policy.
- @latchway/client owns shared TypeScript transport concepts.
- latchway-ios-sdk owns Secure Enclave, Keychain, App Attest, DPoP signing,
  refresh storage, and Apple installation state.
- latchway-android owns Android Keystore, StrongBox, Play Integrity, DPoP
  signing, refresh storage, and Android installation state.
- This repository owns the React Native API, fetch integration, TurboModule
  boundary, native dependency wiring, and diagnostics presentation.
- Generated TurboModule and internal wire types are not public API.

## Security invariants

- Never reimplement App Attest, Play Integrity, Secure Enclave, Android
  Keystore, platform DPoP signing, or secure refresh storage in TypeScript,
  C++, or bridge glue.
- Keep private keys, refresh tokens, and raw attestation evidence out of the
  JavaScript runtime.
- Expose only minimum redacted diagnostics across the native boundary.
- Preserve cancellation and streaming; never replay a request whose dispatch
  outcome is uncertain.
- Never log identity tokens, session tokens, DPoP proofs, attestation evidence,
  native secrets, or provider credentials.
- The SDK must never accept an upstream AI-provider secret.

## React Native implementation rules

- Use the New Architecture and TurboModules for the supported baseline.
- Mirror @latchway/client public ergonomics where practical without duplicating
  its transport implementation.
- Keep iOS and Android native dependency versions compatible with the exact
  protocol contract.
- Local native-development overrides belong in examples and development
  configuration, never published package metadata.
- Keep public APIs handwritten. Generate bridge plumbing reproducibly.
- No production TODO, FIXME, empty handler, hard-coded success, or placeholder
  response is acceptable.

## Testing and validation

When manifests exist, every change must keep TypeScript, code-generation, iOS,
Android, and example builds passing. Security/protocol work requires shared
vectors and core-container conformance. Test bridge type safety, version
mismatch, redaction, cancellation, streaming, native failure propagation, New
Architecture behavior, local development overrides, and published-package
resolution.

Real conformance requires both platform applications. Missing platform
credentials do not block fixture tests or unrelated work; record the exact
remaining device-validation commands.

## Repository hygiene

- Do not commit secrets, signing assets, service-account files, local
  environments, build output, or machine-specific absolute paths.
- Preserve unrelated user changes and keep generated output reproducible.
- Update documentation with public behavior.
- Use focused conventional commits when explicitly asked to commit.
- Optional .agents, .claude/skills, and skills-lock.json installations are
  local developer tooling, never build or release inputs.
