# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases will follow Semantic
Versioning once package publication begins.

## [Unreleased]

### Changed

- Synchronized the SDK contract lock, compatibility constant, and canonical
  fixtures to the unreleased Latchway contract 0.4.0 checkpoint while keeping
  wire protocol 1.
- The Firebase example now selects the Firebase identity provider explicitly
  and uses the currently supported OpenAI Chat route and request shape.

### Added

- Handwritten React Native client API with exact-origin authenticated fetch,
  safe DPoP-nonce/session retries, cancellation, quota, and diagnostics.
- TurboModule bridges backed by the Latchway iOS and Android SDKs for native
  keys, attestation, DPoP, secure sessions, and installation revocation.
- Canonical contract-vector tests, native-boundary checks, deterministic
  package verification, CI, security documentation, and an example app.
