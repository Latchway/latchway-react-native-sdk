# Shared-native verification scope

## Fresh-account release — 2026-09-10

React Native 2.0.0 and iOS 2.0.0 remove previous constructor, callback-authority
and storage-adoption paths. This is a source-breaking fresh-account release,
with Android 1.2.1. Earlier artifacts and receipts remain unchanged; they do not
automatically verify this release.

The release is pinned to:

- React Native `155d26203e3db33099974387c2b9369f30b40c0d` / `v2.0.0`.
- iOS `4cb90278597f4cf6881b08c8521cf37dc398c7cf` / `v2.0.0`.
- Android `d9832626ee08b1a873aaae4f00714cf573219d49` / `v1.2.1`.

The public npm 2.0.0 archive and GitHub release asset have identical bytes
(SHA-256 `2a210f0e480a7391d9f3fde1b88505a80ac5e8088f76f4f1f52aadb4cfe32316`).
Their uncompressed package matches the locally tested archive. The native
dependency pins and Sigstore provenance were verified against the exact release
commit, main-branch workflow and publishing run `34440824754`.

Release-source verification passed 259 unit/lifecycle/contract tests, 13 runtime
tests, 15 consumer/archive script tests, 10 docs/development-environment tests,
10 Swift bridge tests and 15 Android bridge tests. Types, lint, code generation,
package reproducibility and both Metro bundles passed. The RN 0.74 / React 18.2
consumer compiled for an unsigned iOS simulator using normal CocoaPods 2.0.0;
its SDK package was the tested release candidate, not a local native override.

The standalone example now installs actual npm 2.0.0 with registry integrity
locked, without a source overlay. Its typecheck, 14 tests, offline LangChain
adapter checks, registry/autolinking checks and Android ARM64 Debug APK build
passed with public Maven 1.2.1. Both production Metro bundles passed. Normal
CocoaPods resolution installed Latchway/AppAttest 2.0.0 and the npm 2.0.0
bridge, with no local native SDK override. The RN 0.82 / React 19.1 standalone
example also completed an unsigned ARM64 iOS simulator build using those actual
registry packages. These are build and fixture results, not a new physical-device
or live-account attestation receipt.

The existing example dependency tree reports nine moderate advisory nodes in
React Native CLI/XML parsing and development-server request parsing, with no
high or critical entries in the npm audit snapshot. This release does not claim
a clean dependency audit or silently change those unrelated tooling pins.

Separate device/account acceptance must still cover:

- Configure-first from RN and native with one shared registry and conflicting
  settings rejected.
- One-shot supplied identity, server-verified freshness, expiry suspension and
  same-account update without changing generation.
- Captured account logout, cancellation before an account exists, A → B → A,
  stale callbacks, interrupted local cleanup and process restart.
- Two surfaces sharing one account while disposal closes only its own client.
- The private root Keychain boundary and explicit current component allowlist.
- Account-bound delegated extension handoff, live revision/retirement checks,
  and rejection of an old handoff after account replacement.
- A clean build of the current private bridge ABI, including rejection of an
  older installed bridge rather than silently constructing another root.
- Both native dependency graphs, minimum-host builds and independently scoped
  real App Attest / Play / extension acceptance.

Do not add a migration inventory or identity-owner startup callback to satisfy
these checks. Fresh storage is the integration model. Persistent account logout,
component journals, retained-key cleanup and cross-process fences remain required.

## Historical source checks — 2026-09-08, before cleanup

The earlier shared-account candidate passed 168 RN unit/lifecycle/contract tests,
7 Swift bridge tests, 6 Android bridge tests, app typechecking/tests, both Metro
bundles and the RN 0.82 / React 19.1 native consumers. The minimum RN 0.74 /
React 18.2 package/type/codegen and native consumers also compiled. Those counts
describe that exact historical source, not the current branch.

A source-overlay packaging defect initially omitted the real iOS native bridge
target despite a successful application link. The corrected snapshot contained
the bridge registration class and command method. A Firebase same-account
wrapper-refresh issue was also corrected with logical-account and transition-
epoch checks. Neither required weakening attestation.

At 2026-09-08 09:22:40 UTC, the corrected source candidate completed one ordinary
standalone LangChain call with existing Firebase auth and required real App
Attest. The gateway recorded caller `react-native`, `direct_attested`, one
successful upstream attempt and 1,530 tokens (1,509 input + 21 output).
SDK request UUID: `52004c02-6c7c-4cde-aa90-7b965e136665`.
Gateway resource: `req_01M205774Z36WNDXZCGST3P458`.
It was not a tool or embedded two-account proof.

## Historical published-package check — 2026-09-08

The signed, bundled iPhone app using npm RN 1.2.0/client 1.1.0/LangChain 1.1.0 and
CocoaPods 1.2.0 completed one ordinary LangChain call at 11:55:52 UTC against the
disposable environment on server 1.1.1. It reused existing application-owned
Firebase auth and real device attestation, used no Metro or local SDK override,
and recorded one model call with zero tool calls.
SDK request UUID: `719f00ef-088c-4e13-a933-0b7013132d61`.
That UUID is not an Admin API resource ID.

The registry-pinned example passed typechecking, 14 tests, offline adapter checks
and full Android Debug APK compilation. All five native Android 1.1.0 artifacts
were downloaded from Maven Central. This is not physical Android/Play evidence.

## Not claimed

None of these historical receipts proves this new cleanup, multi-turn weather
tools for the new source, production-signed Habitify acceptance, live two-account
quota behavior, JS-pause timing or physical extension/service races. Physical
Play-distributed Android remains separate. A build, registration diagnostic or
component handoff alone is not a delegated request.

Run the README acceptance exercise on an explicitly configured Development
environment. Keep only redacted statuses, versions and request identifiers;
never attach ID tokens, passwords, keys, raw evidence or private operator files.
