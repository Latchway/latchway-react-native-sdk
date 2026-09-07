# Verification — 2026-09-07

## Physical follow-up: application URL compatibility fix

Launching the released packages was not sufficient evidence: the user's first
chat failed. Redacted diagnostics isolated an OpenAI-wrapped
`transport_destination_not_allowed` error before native dispatch. React Native
0.82's partial URL implementation passed the app's query-only capability probe
but changed `/v1/responses` to `/v1/responses/`. The SDK route guard correctly
rejected the changed path; it was not disabled or widened.

The app-owned bootstrap now verifies absolute paths and stable query
serialization. Tests execute the actual installed React Native URL class to
reproduce the old false positive and confirm replacement with the complete
implementation. Working host URL implementations are still retained.

The corrected Debug example was installed on the same physical iPhone 16 Pro
and ran one fixed LangChain question with its existing Firebase identity. The
answer rendered successfully; the screen showed App Attest verified and Secure
Enclave. Gateway metadata corroborated one successful, directly attested
Responses request, one HTTP 200 upstream attempt and 1,530 total tokens at
06:27:32 UTC. No account creation, sign-out, installation revocation, server
change or npm publication occurred. The app remains installed and signed in.

Thirteen example tests, TypeScript, offline adapter serialization, 11 SDK runtime
checks, the signed iOS build and Android production Metro bundle passed. Lint
has eight `no-void` warnings and no errors. This follow-up verifies a real text
turn, not a new weather-tool/multi-turn or physical Android proof. The npm SDK
remains 1.1.1; this correction is in the app-owned bootstrap, not a new release
of the SDK's deprecated compatibility helper.

## SDK 1.1.1 dependency split

The React Native SDK now requires only the shared client and private stream
fallback. The app owns its LangChain runtime polyfills and Babel configuration;
it no longer imports the SDK's deprecated convenience entrypoints.

Prepublication validation of the installed 1.1.1 archive passed:

- 103 SDK tests, 11 isolated runtime regressions (legacy and app-owned setup),
  TypeScript/lint, code generation, compatibility and native-boundary checks.
- Double-pack byte equality, package allowlist and credential scan.
- Independent default npm and pnpm core-only installs and consumer type checks;
  neither installed native randomness, URL/encoding polyfills or LangChain.
- Eight example tests, TypeScript, offline LangChain serialization, both
  production Metro bundles, signed iOS Debug build with embedded Hermes bundle,
  and Android Debug build. Example lint has seven existing `no-void` warnings,
  no errors. The separate workspace consumer's type and Metro checks also pass.

Publication succeeded through the existing main-only trusted npm workflow:
[v1.1.1 release](https://github.com/Latchway/latchway-react-native-sdk/releases/tag/v1.1.1),
source `ecacb55f51bec0dabd211f5324da66460a78902e`,
[run 34088406885](https://github.com/Latchway/latchway-react-native-sdk/actions/runs/34088406885).
npm `latest` is 1.1.1 and its metadata contains a SLSA provenance record. All
109 public archive files, including the manifest, match the tested candidate
byte-for-byte (the compressed archive hashes differ).

The example's npm lock now uses the actual public registry integrity. A clean
`npm ci --ignore-scripts` installed 953 packages, with no local SDK links;
registry checks, TypeScript, eight tests, serialization, lint (the same seven
warnings) and both Metro bundles passed again. LangChain remains 1.1.0; native SDKs remain
1.0.0. No device installation, identity revocation, live provider request or
server change was made for this packaging update. No fresh physical proof is
claimed; the earlier evidence and dependency-maintenance limitations remain below.

## SDK 1.1.0 update

The example now consumes the React Native and LangChain 1.1.0 helpers. It uses
standard Metro, the SDK's explicit bootstrap/Babel helper, stateless Responses,
tool binding and completed-message replay; copied compatibility files were removed.

Prepublication checks used installed npm-format release archives, not SDK source
links: TypeScript, lint, eight example tests, request-serialization regression,
both production Metro bundles, signed iOS Debug build (embedded Hermes bundle)
and Android Debug build passed. SDK checks passed 137 JavaScript tests, 103 React
Native tests, seven runtime regressions, code generation/native-boundary and
compatibility checks. The React Native package passed double-pack equality,
archive allowlist and credential scanning.

Publication completed through the existing main-only GitHub trusted publishers.
Both npm 1.1.0 packages have provenance records. The example lockfile was
regenerated from npm and `npm ci` performed a clean registry install; version,
integrity/no-local-link checks, TypeScript, lint, eight tests, serialization and
both standard Metro bundles passed again. All 109 React Native and eight
LangChain packaged files are byte-identical to the locally tested candidates
(the compressed archive hashes differ; file contents and manifests do not).

- [React Native v1.1.0](https://github.com/Latchway/latchway-react-native-sdk/releases/tag/v1.1.0),
  source `8fbd1ad5fc9cc98129e06ff909125bc1367b5e1f`.
- [LangChain v1.1.0](https://github.com/Latchway/latchway-js/releases/tag/langchain-v1.1.0),
  source `7ced923b29ef1942942139677275a20e71984e0c`.

The previously verified iPhone 16 Pro was disconnected during this update.
No new 1.1.0 physical-device claim is made, no other paired phone was used, and
the user's existing signed-in installation was not revoked or replaced.
Android physical Play Integrity remains deferred. The earlier live 1.0.0
baseline below is retained as separate evidence, not relabeled as 1.1.0.

## Earlier physical baseline — SDKs 1.0.0

Completed on a physical iPhone 16 Pro running iOS 27, development-signed.
The application remains installed and signed in for interactive use.

- Real Firebase email/password account creation, sign-out and sign-in passed.
- Native diagnostics reported react_native_ios, app_verified trust and
  secure_enclave key storage. Signed entitlements contain development App Attest
  and the required private root Keychain group.
- LangChain streamed two conversation turns: Singapore weather, then Ho Chi Minh
  City with prior-turn context. Two real Open-Meteo weather lookups and four model
  requests completed.
- The direct-fetch streaming mode also completed a separate Latchway question.
- Read-only Admin API corroboration found all five proof requests successful,
  directly attested, with exactly one HTTP 200 OpenRouter attempt each.
  LangChain consumed 7,793 total tokens; direct fetch consumed 1,424 (9,217 total).
  Subsequent manual user conversation is excluded from those proof totals.
- TypeScript, ESLint, eight unit/regression tests, the published LangChain
  serialization regression, registry-resolution checks and both native Debug
  builds passed.

Runtime packages: React Native 0.82.0; React 19.1.1; @latchway/react-native,
@latchway/client and @latchway/langchain 1.0.0; @langchain/core 1.2.9;
@langchain/openai 1.5.10; OpenAI 7.8.0; React Native Firebase 25.1.0.
Native dependencies resolve from public CocoaPods/Maven Central, not local SDK
paths. No registry package was modified, and no server check was disabled.

The live gateway tested here identifies itself as 1.0.2-dev.fm110.3, contract
1.0.0/protocol2. No server deployment or migration was performed during this
example task. Habitify's two environments and the Swift demo's active revision
were independently checked unchanged.

The native SDK labels requests react-native-fetch even when its transport is
called by LangChain. Framework attribution is not forged in JavaScript.

Private metadata receipts, request IDs, disposable application/account IDs and
cleanup instructions are retained outside Git in the operator's verification
resources. No password, identity/session token, DPoP proof, raw attestation,
provider key, or chat transcript is stored in those receipts.

This is development-device integration evidence, not production distribution,
Android physical/Play Integrity, extension, load, quota-boundary or comprehensive
security certification. Android compiled but was not physically verified.
See README for the known moderate tooling dependency audit findings.
