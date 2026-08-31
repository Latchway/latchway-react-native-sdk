# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases will follow Semantic
Versioning once package publication begins.

## [Unreleased]

### Changed

- Physical React Native evidence now requires the authorization-first HTTP 403
  `component_feature_not_granted` mapping for an ungranted feature instead of
  the feature-enumerating HTTP 404 expectation.
- Added Metro-runnable OpenAI, Vercel AI OpenAI/Anthropic, and LangChain
  example consumers plus
  a 16-case shared-ID React Native framework conformance matrix covering
  Responses, Chat, embeddings, streaming, tools, structured output, errors,
  retry dispatches, cancellation, and credential isolation, plus a separate
  RN-only explicit-refresh, Anthropic Messages, and opaque-route cases.
- Exposed the canonical non-secret `gatewayURL` and made `fetchFor` preserve
  Latchway request correlation through the conventional `X-Request-ID` alias
  without buffering response streams.
- Removed the obsolete React Native CLI `podspecPath` override; React Native
  0.82 now discovers the root podspec without an invalid-config warning.
- Added iOS and Android production Metro bundles to the normal `pnpm check`
  gate so Node-only framework imports fail before release.

- Replaced JavaScript-owned authorization envelopes and network dispatch with
  native URLSession/OkHttp dispatch, opaque response handles, pull-streamed
  response chunks, cancellation, exact origin/path enforcement, and strict
  safe response metadata. The removed `authorize` API is an intentional
  security-boundary break; `fetchFor(feature)` supplies framework adapters
  without exposing reusable credentials.
- Advanced the exact JavaScript source pin to the reviewed final source commit
  whose protected release evidence requires both Firebase App Check and
  Cloudflare Turnstile.
- Synchronized the candidate to draft contract 1.0.0, current wire protocol 2,
  and the canonical installation-family and component-attestation binding v2
  fixtures while preserving wire 1 in the core compatibility window.
- Added an extension-process component client for iOS Action and SSO
  extensions. It performs native App Attest step-up without a containing-app
  identity callback and reports composite `delegated_direct_attested` trust;
  Android reports direct component attestation as unsupported.

## [1.0.0]

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
- The version 1 release candidate uses the exact reviewed JavaScript, iOS,
  Android, and core source commits recorded by the synchronized compatibility
  lock.
- The Firebase example now selects the Firebase identity provider explicitly
  and uses the currently supported OpenAI Responses route and request shape.
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
- Protocol-specific framework feature bindings; the primary example and
  physical-device path use the setup wizard's OpenAI Responses feature.
