# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases will follow Semantic
Versioning once package publication begins.

## [Unreleased]

## [1.0.0] - 2026-08-29

### Changed

- Native consumers now pin the reviewed JavaScript, iOS, Android, Kotlin,
  React Native, and core source commits through a machine-verified release
  compatibility lock.
- The example now includes complete React Native 0.82 New Architecture iOS and
  Android hosts, including source-development overrides that are excluded from
  published metadata.
- The example provider stack now pins the native-build-verified React Native
  Firebase 25.1.0, Firebase Apple 12.15.0, and Firebase Android BoM 34.15.0 set,
  and repository installs use pnpm's hoisted linker for CocoaPods framework
  compatibility.
- Synchronized the SDK contract lock, compatibility constant, and canonical
  fixtures to the unreleased Latchway contract 0.4.0 checkpoint while keeping
  wire protocol 1.
- The Firebase example now selects the Firebase identity provider explicitly
  and uses the currently supported OpenAI Chat route and request shape.
- Automatic bodyless retries now require exact canonical, correlated
  pre-dispatch Problem documents and unambiguous nonce semantics; ambiguous or
  duplicate response metadata fails closed.
- Provider credential headers are comprehensively stripped and decoded
  credential-like query names fail before identity acquisition or dispatch.
- Native `operation_indeterminate` failures preserve only a canonical
  reconciliation identifier and reject missing, conflicting, or forbidden
  operation metadata.

### Added

- Tag-triggered npm trusted publication with provenance, immutable release
  package verification, draft GitHub releases, and published native consumer
  gates.
- Full contract-bundle verification and clean packed-package consumer gates.
- Handwritten React Native client API with exact-origin authenticated fetch,
  safe DPoP-nonce/session retries, cancellation, quota, and diagnostics.
- TurboModule bridges backed by the Latchway iOS and Android SDKs for native
  keys, attestation, DPoP, secure sessions, and installation revocation.
- Canonical contract-vector tests, native-boundary checks, deterministic
  package verification, CI, security documentation, and an example app.
