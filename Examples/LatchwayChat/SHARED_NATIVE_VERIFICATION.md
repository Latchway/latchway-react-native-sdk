# Shared-native source verification — 2026-09-08

These are local source/build receipts plus the explicitly scoped standalone
iPhone chat check below, not release or full shared-mode acceptance evidence.
The candidate is explicitly `publishable: false` in
`../../release-candidate.shared-native.json`. Historical released locks and
published native dependency pins are unchanged; the example opts into local
sibling SDK sources and Android `1.1.0-dev` artifacts.

## Completed

| Check | Result |
| --- | --- |
| RN unit/lifecycle/contract tests | 168 passed after device-driven loader, probe and Firebase identity regressions |
| Swift production bridge tests | 7 passed |
| Android production bridge tests | 6 passed with final local native artifacts |
| SDK typecheck, targeted lint, Codegen | Passed |
| LatchwayChat types and app tests | Passed; 14 tests in 5 files |
| LatchwayChat Metro production bundles | iOS and Android passed |
| RN 0.82 / React 19.1 LatchwayChat native consumers | iOS unsigned simulator build and Android debug APK passed |
| Signed iPhone build (2026-09-08) | Debug iPhoneOS arm64 build passed with Xcode 27; strict signature verification passed; Hermes JavaScript embedded; subsequently installed and launched on the real iPhone |
| RN 0.74 / React 18.2 isolated packed consumer | Public API types, 20-method Codegen, both Metro bundles, iOS simulator and Android debug builds passed |
| Native dependency resolution | One CocoaPods native implementation; Android core resolved once to local `1.1.0-dev` |

Final iOS rebuilds include the reviewed 256-group descriptor limit, independent
legacy component inventory decoding, and awaited extension lease disposal.
Final Android builds refreshed the completed native candidate artifacts.
Lifecycle tests cover delayed identity/logout, A-to-B fencing, failed cleanup,
late attachment/activation, disposal, stale observations and a second JS runtime.
The bridge inventory test exercises decoding with omitted legacy root-copy groups
and retained current-provisioning membership enforcement; native registry tests
own actual immutable matching and Keychain migration behavior.

The first minimum iOS link failed because the test-host Podfile edited a second
Xcode project instance and CocoaPods overwrote the Swift runtime compilation unit.
Using CocoaPods' cached user project fixed the harness. Both initial full build
and final bridge relink then passed. No upstream React Native source was patched.
Builds retain upstream CocoaPods script warnings, Gradle/toolchain deprecations,
and local Android SDK inventory warnings; none failed the builds.

## Signed iPhone build follow-up

The shared-source overlay was refreshed, existing locked Pods installed without
repository updates, and app typechecking plus all 13 app tests passed again.
The signed device build embeds Hermes bytecode and matching public/Firebase
configuration, so Metro is not required. npm and CocoaPods lock checksums stayed
unchanged. Strict code-signature validation passed with normal Keychain access.

The initial build did not replace the native iOS demo. After a separate request
to run the example, the RN app was installed over the same `dev.latchway` bundle
without uninstalling or requesting a data wipe, then launched in default
standalone mode. The device reported its process running after launch. No
verification/diagnosis launch flags, account creation, sign-out, revocation or
automatic chat were requested. This is install/process-launch evidence, not a
screen-render or live-chat acceptance result; old proof receipts were not reused.

After explicit authorization, the separate disposable RN environment received
an additive native `ios` root and a required App Attest policy allowing the
`ios` and `react-native` shared-native callers. Validation and activation passed;
its legacy RN policy, quotas, the real Habitify environments and the separate
native iOS demo configuration were verified unchanged. No gateway deployment
was needed.

The explicit existing-account Debug probe exposed a local overlay packaging
failure before any gateway request: CocoaPods did not traverse the symlinked
`ios` directory, producing an aggregate pod target without the native bridge.
Generated bridge specs and a successful app link were insufficient evidence.
The corrective check must require an actual native pod target with both the
Swift bridge and Objective-C++ registration source, and the resulting device
binary must contain the registration class. Old successful device receipts do
not establish success for this source candidate.

## Scoped live RN check — passed

The corrected source snapshot produced a real native bridge target. The final
signed iPhone binary contains `RCTNativeLatchway` and its `appCommand` method;
the SDK's lazy loader now preserves original registration errors. The example
also accepts Firebase's same-account User-wrapper refresh while fencing
observed account switches, sign-out and A→B→A during token retrieval. Tests cover
those cases; no production attestation requirement was relaxed.

At 2026-09-08 09:22:40 UTC, the explicit existing-account Debug probe completed
one standalone LangChain model call against the disposable environment. The
gateway independently recorded success with caller `react-native`, required
App Attest / `direct_attested` trust, one successful upstream attempt, and 1,530
total tokens (1,509 input + 21 output). Client request ID:
`52004c02-6c7c-4cde-aa90-7b965e136665`; gateway request ID:
`req_01M205774Z36WNDXZCGST3P458`. The fresh receipt identifies the unreleased
shared-native source candidate; historical npm version strings are not release
evidence. An earlier local `attestation_unsupported` result did not recur on the
final explicit check; its underlying provider reason was not captured.

The existing Firebase account was reused. No account creation, Firebase
sign-out, installation revocation or data wipe was performed. All seven gateway
readiness checks passed. The real Habitify Development/Production and separate
native iOS demo configurations, and the disposable RN quota, remain unchanged.
The corrected example is installed and launched on the connected iPhone.

## Not claimed

- This one standalone RN/App Attest chat check does not prove native/RN
  co-embedding, Play-distributed Android, or live two-account quota behavior.
- No real JS-pause/fast-refresh, cross-process extension/service race, upgrade
  from a deployed legacy store, or external custom-store migration proof is
  inferred from unit tests or compilation.
- The shared account-scoped Apple extension handoff is a native Swift API.
  The legacy RN extension constructor is not an account-scoped opener.
- No server deployment, native/npm publication, release tag, or immutable
  source/registry attestation was created by these checks.

Follow the two-account exercise in `README.md` on a separately configured
protocol-3 development gateway before collecting device evidence. Never attach
tokens, credentials, raw identity values or attestation evidence to receipts.
