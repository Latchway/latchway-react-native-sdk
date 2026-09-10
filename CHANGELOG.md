# Changelog

All notable changes to this project will be documented in this file.

The format follows Keep a Changelog, and releases will follow Semantic
Versioning once package publication begins.

## [2.0.1] - 2026-09-10

- Preserve safe gateway detail and existing Problem diagnostics across iOS,
  Android and JavaScript: retry timing, feature, field errors, supported protocol
  versions, title and instance reference. Validate known optional fields and
  keep native credential/error redaction boundaries intact.
- Retain HTTP status and request ID for interrupted native response streams,
  without automatic replay. The chat example now reads non-success Problems and
  presents actionable error detail instead of discarding the response body.
- Pin JavaScript client 1.1.1, iOS 2.0.1 and Android 1.2.2. React/RN minimums,
  wire protocol, supplied identities and shared app lifecycle remain unchanged.

## [2.0.0] - 2026-09-10

### Attestation development

- Document local iOS/TestFlight and Google Play testing workflows against
  explicit server 1.1.3 policies, including App Attest `any`, with no new JS evidence or Firebase dependency.
  Add configuration-boundary tests rejecting caller-asserted Apple environment,
  Google testing status and trust level. Native SDKs still own attestation and
  bounded key recovery; production release evidence requirements are unchanged.

### Breaking changes

- Use only the supplied-identity shared app/account API. Remove the old root
  client constructor, identity-authority transfer/activation API, migration
  options and per-request identity-token callbacks.
- Require native bridge ABI 3 and wire protocol 3; rebuild JavaScript and native
  code together. Historical published artifacts and dependency locks are unchanged.
- Open delegated iOS components with an opaque current-account handoff, without
  access to root credentials. Remove legacy component inventories and the
  unsupported direct-attestation API.
- Preserve idempotent native/RN configuration, account isolation, local logout,
  App Attest, streaming and current component retirement fences. No existing
  device storage is adopted, scanned or migrated.

### Compatibility

- Pin iOS 2.0.0 and Android 1.2.1; keep JavaScript client/contract 1.1.0,
  React Native >=0.74 <1 and React 18.2 / 19 peers unchanged.
- Preserve the published native Fetch response fix and app-level `signOut`,
  including pending identity cancellation and cleanup retry.
- Physical Apple/TestFlight, Google testing response and production distribution
  evidence are separate from local package/native bridge checks.

## [1.3.0] - 2026-09-09

### Added

- Add `LatchwayApp.signOut(): Promise<void>` for application-level sign-out
  without an account handle or generation ID. The native shared app fences
  pending identity work and retires its current or persisted account; repeated
  calls retry unfinished cleanup through the same API.
- Document native-owned authentication flows: the native auth owner awaits
  the shared app's sign-out even when no RN or AI screen is mounted. Native/RN
  configuration remains order-independent with no Firebase dependency or
  runtime Latchway bootstrap.

### Changed

- Pin iOS 1.3.0 and Android 1.2.0. JavaScript client 1.1.0, contract 1.1.0,
  wire protocols and supported React/React Native peers remain unchanged.
- Preserve the 1.2.1 Fetch response fix and existing account/generation-targeted
  logout APIs. No legacy API or storage migration support is removed.

### Upgrade

- Install `@latchway/react-native@1.3.0`, update Pods and rebuild both native
  apps. Embedded hosts must resolve the same pinned native SDK implementation.
- Prefer `await app.signOut()` in the serialized application auth flow; stop
  UI/tool work first and sign out the external auth provider separately.
  Cleanup errors still reject and must be retried before another login.
  Sign-out does not reset per-user quotas or log out other devices.
- No fresh physical-device attestation, cloud or production distribution proof
  is claimed by this release note.

## [1.2.1] - 2026-09-09

### Fixed

- Consume native response bytes correctly through Fetch body methods on React
  Native runtimes whose `Response` implementation does not support stream-backed
  bodies. Non-streaming OpenAI/LangChain calls such as `model.invoke()` can parse
  a successful HTTP 200 JSON response, and framework error handling can read
  actual HTTP error responses instead of an empty or misinterpreted body.
- Keep streaming, cancellation and the native credential boundary intact.
  No public API, gateway protocol or runtime dependency changes are required.

### Upgrade

- Upgrade `@latchway/react-native` to 1.2.1 and regenerate the application's
  JavaScript bundle through its usual build workflow. Existing 1.2.0 account
  setup and app-owned runtime files remain valid.
- JavaScript client 1.1.0, iOS 1.2.0 and Android 1.1.0 pins are unchanged.
  No fresh physical-device attestation or production distribution proof is
  claimed by this JavaScript response-handling patch.

## [1.2.0] - 2026-09-08

- Add developer-supplied `signIn`, `restore`, `currentAccount`, account-scoped
  token updates and logout. Native and RN can configure first and join the same
  native account without a Firebase SDK dependency or a permanent JS callback.
- Add pure identity metadata helpers and an optional injected auth-event binding.
  Token freshness is gateway-verified; expired identity suspends protected work.
- Pin JavaScript client 1.1.0, iOS 1.2.0 and Android 1.1.0 to released contract
  1.1.0. Shared apps use wire 3; legacy constructors retain wire 2 behavior.
- Lower the Android library compile SDK and AAR minimum compile SDK to 34.
  Host application target/compile SDK requirements remain independent.

- Add native-owned named app registries, idempotent configuration, explicit
  account activation, generation-bound clients and offline local logout.
  Matching native/RN setup shares the actual account session and never replaces
  its identity owner. Deliberate provider transfer uses a captured owner ID.
- Fence retired handles, late identity/stream responses and stale observation
  snapshots. Closing a screen or disposing one lease does not log out siblings.
- Migrate LatchwayChat to account-aware Firebase login/logout and add native-first
  Swift/Kotlin hosts with native chat and an embedded RN LangChain/weather surface.
  Include serialized auth transitions, explicit resume and two-account exercises.
- Keep source overrides confined to explicit example/test development mode.
  Shared mode requires server contract 1.1/protocol 3 and explicit host policy.
  Firebase/LangChain remain application-owned; RN 0.74 / React 18.2 minimum peers
  are retained.

## [1.1.3] - 2026-09-07

### Changed

- Expanded the React Native peer range to `>=0.74.0 <1.0.0` and React to 18.2 / 19.x.
  New Architecture remains required; React must match the selected RN release.
  The peer range admits newer 0.x releases without claiming they have all been
  tested; current validation covers RN 0.74.0 and 0.82.0.
- Android now resolves React Native, Codegen and the React Android artifact
  from the consuming app instead of assuming library-local dependencies or
  pinning every consumer to 0.82. Native Latchway dependencies remain 1.0.0.
- Added an opt-in, version-guarded Android 0.74 build adapter for the newer
  Gradle plugin required by the native dependencies. It translates generated
  autolinking names without modifying installed React Native source or adding
  runtime dependencies; older hosts must follow the compatibility recipe.
- Added a strict, packed-package React Native 0.74.0 / React 18.2.0 host with
  public API type checks, Codegen, Metro bundles and optional native builds.
  Documented the newer Kotlin/Android and Swift toolchains required by the
  native SDKs. No physical attestation evidence is inferred from these builds.

## [1.1.2] - 2026-09-07

### Fixed

- The deprecated opt-in bootstrap now rejects React Native's partial URL
  implementation when it appends a slash to Responses or Chat Completions
  paths. Both it and the app-owned LatchwayChat bootstrap preserve complete
  host globals and exact gateway destinations without weakening the allowlist.
- Added regression coverage using the actual pinned RN URL implementation.
- Updated LangChain setup links to the corrected versioned example and
  documented native/RN shared-identity configuration on server 1.0.3.

### Upgrade

- Recopy the app-owned runtime files if the host previously copied the 1.1.1
  example; npm cannot update application-owned copies. Deprecated helper users
  still explicitly install their optional peers as described for 1.1.1.
- Required dependencies remain only the shared client and private streams
  fallback. iOS/Android pins remain 1.0.0, with no native or wire changes.
- No fresh physical-device, Play Integrity or production distribution proof
  is claimed by this patch.

## [1.1.1] - 2026-09-07

### Changed

- Required runtime dependencies reduced from six to two: `@latchway/client`
  and the SDK's private `web-streams-polyfill` fallback. The core entry does not
  install global polyfills, Babel tooling, native randomness or LangChain.
- LangChain setup is application-owned and documented, with copyable bootstrap
  files and Babel configuration in LatchwayChat. No companion package is required.
- The old `/polyfills` and `/babel` entrypoints are deprecated but retained;
  their four convenience dependencies are optional peers, not auto-installed.
  Repository devDependencies still pin these for regression tests.

### Upgrade action for 1.1.0 helper users

- Install the documented runtime polyfills and Babel devDependency explicitly
  before upgrading, or migrate to the app-owned setup in `docs/langchain.md`.
  A fresh install that still imports `/polyfills` without its peers will fail
  module resolution; `/babel` reports an actionable missing-plugin error.
  Existing host globals do not remove static import dependency requirements.
- This requested patch release changes dependency installation behavior; it is
  not a zero-action upgrade for helper consumers. Core APIs, native security,
  shared/native dependency versions and the wire contract are unchanged.

## [1.1.0] - 2026-09-07

### Added

- Explicit `@latchway/react-native/polyfills` bootstrap for Hermes async symbols,
  streaming UTF-8 decoding, web streams, URL and abort compatibility. Complete
  existing globals are retained; the ordinary SDK import does not install it.
- Optional `withLatchwayBabel` configuration helper for LangChain class and
  export-namespace compatibility without depending on LangChain at runtime.
- Standalone npm-only LatchwayChat with Firebase authentication, temporary
  multi-turn LangChain weather tools, direct fetch, cancellation and diagnostics.
- Isolated runtime regressions and a LangChain quickstart.

### Fixed

- Metro now resolves the published built JavaScript entry without a custom
  `.js`-to-TypeScript resolver. Native Codegen retains its original TS schema.

### Compatibility

- Shared client, iOS App Attest and Android SDK dependencies remain 1.0.0;
  the native authentication/credential boundary and wire protocol are unchanged.
- Supported baseline remains React Native 0.82 / New Architecture. Android
  physical Play Integrity evidence is deferred, not inferred from a build.

## [1.0.0] - 2026-09-01

### Changed

- Added the root React Native installation-family component lifecycle:
  descriptor-snapshotted prepare, replace, identity-free diagnostics, revoke,
  and descriptor-bound family retirement, with Android reporting the iOS-only
  operations explicitly unsupported.
- Added a Debug-only App Intent integration proof that uses an independently
  keyed delegated `react_native_ios` session, fully consumes a Responses request,
  and binds its bounded shared-Keychain receipt to the root's exact-run challenge;
  the Release fixture remains fail-closed with no AppExtensions linkage.
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
- Synchronized the release to contract 1.0.0, current wire protocol 2,
  and the canonical installation-family and component-attestation binding v2
  fixtures while preserving wire 1 in the core compatibility window.
- Added an extension-process component client for iOS Action and SSO
  extensions. It performs native App Attest step-up without a containing-app
  identity callback and reports composite `delegated_direct_attested` trust;
  Android reports direct component attestation as unsupported.

### Candidate baseline

#### Changed

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
