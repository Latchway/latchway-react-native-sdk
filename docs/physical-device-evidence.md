# Physical-device release evidence

The React Native release gate proves that the published JavaScript surface
actually reaches the locked native iOS and Android SDKs on production-eligible
devices. A simulator, emulator, debug build, testing process, debugger-attached
process, software-key fallback, sideloaded Android build, or testing attestation
environment can never produce passing release evidence.

The optional iOS development Firebase bootstrap is likewise excluded. Its
bridge exists only in `DEBUG`, its plist phase refuses Release/candidate builds,
and its one-read grant is launched outside the protected collector. Its local
runner does require a fresh sign-in, replacement App Attest session, Responses,
quota, exact trusted diagnostics, terminal revocation/sign-out, and a run-bound
app-container marker. Even so, a successful development-signed `dev.latchway`
run is source verification, not production App Attest, immutable-candidate, or
publication evidence.

This is an external release gate. Repository CI validates the collectors and
their failure cases, but it does not claim a physical-device success. Only the
protected, manually dispatched `Physical React Native evidence` workflow can
collect a candidate report, and the final cross-repository adapter requires all
four independently validated native and React Native reports.

The raw React Native device record is
`latchway.react-native-device-run.v2`. It contains only checks the opaque
production bridge can prove without exporting credentials. The protected
finalizer imports replay rejection, proof-tamper rejection, refresh-token
rotation, protocol-version rejection, and post-revocation enforcement from the
exact linked native report. A JavaScript record that supplies any of those
native-only proof IDs is rejected.

## What the run proves

Each platform run uses the real example application and verifies:

- the React Native New Architecture bridge reached the locked native SDK;
- a production App Attest session with a Secure Enclave key on iOS, or a Play
  Integrity session with hardware-backed Android Keystore key material;
- on iOS, an initial App Attest registration followed by session-only local
  retirement and an App Attest assertion that reuses the same installation;
- a DPoP-authorized request through the opaque native dispatch boundary and the
  concrete React Native `LatchwayError` mapping for authorization-first HTTP
  403 `component_feature_not_granted`;
- exact HTTP 401 replay/tamper rejection, redacted refresh-credential rotation
  for one stable installation, HTTP 426 protocol-version-zero rejection, and
  HTTP 403 post-revocation enforcement imported unchanged, field-for-field,
  from the linked, release-eligible native report;
- a bounded, non-empty SSE stream and a quota response through the pinned
  gateway image and configuration;
- one short-lived, P-256-signed deployment statement fetched from the same
  gateway origin before and after each run, with the exact native/RN client
  policy requiring request-hash-bound production trust;
- exact app/package version, build, team or cloud project, signing-certificate,
  distribution/Play track, source, native SDK, core, and contract hashes;
- linkage to a separately passing native iOS or Android physical-device report;
- absence of identity/session/refresh tokens, DPoP proofs, raw attestation,
  private keys, and provider credentials from every retained document.

The Android gate additionally requires the Play installer, a locked production
device with green Verified Boot, a Play-recognized app, and a licensed account.
Installing an APK with `adb` is deliberately insufficient. The iOS gate checks
a private snapshot of the exact signed `.app`, production App Attest
entitlement, application identifier, team, signing certificate, executable
hash, canonical per-file manifest hash, and deterministic whole-bundle tree
hash before inspection and again
immediately before installing that same snapshot.

## Prepare immutable candidates

First produce and retain the native reports with the sibling SDK workflows:

- iOS: `latchway-ios-sdk/.github/workflows/physical-app-attest.yml`
- Android: `latchway-android/.github/workflows/physical-play-integrity.yml`

Stage each native evidence/profile pair on its matching protected runner. Pin
its evidence SHA-256 in the React Native environment. A React Native candidate
must embed all physical-run values listed in `example/.env.example`, with
`LATCHWAY_CONFORMANCE_AUTORUN=true`. Those values are release identifiers, not
credentials, but the build configuration itself remains a protected release
input. Produce the candidate with
`scripts/stage-physical-react-native-candidate.py ios|android`. The producer
requires clean exact React Native, JavaScript SDK, native SDK, and core
worktrees and checks their commits against `release-compatibility.json` and
`contract.lock`. It materializes the exact React Native and JavaScript commits
as fresh sibling worktrees, regenerates their dependencies and JavaScript build
output from protected locks, uses external Firebase configuration, performs a
Release build, inspects the result, and emits canonical source/candidate
manifests plus `SHA256SUMS`. The platform candidate necessarily embeds only its
non-secret Firebase client configuration. Provider credentials, provider
secrets, and signing passwords are never included anywhere in candidate
output. Its output directory must not already exist.

Run the producer from the clean React Native repository. Common protected
inputs are `LATCHWAY_SOURCE_COMMIT`, `LATCHWAY_CORE_COMMIT`,
`LATCHWAY_CORE_SOURCE_PATH`, `LATCHWAY_JAVASCRIPT_SDK_PATH`,
`LATCHWAY_CONTRACT_VERSION`,
`LATCHWAY_CONTRACT_BUNDLE_SHA256`, `LATCHWAY_RN_SDK_VERSION`,
`LATCHWAY_NATIVE_SDK_VERSION`, `LATCHWAY_NATIVE_EVIDENCE_PATH` and its
`LATCHWAY_NATIVE_EVIDENCE_SHA256`, all gateway coordinates listed in
`example/.env.example`, and a new `LATCHWAY_CANDIDATE_OUTPUT_DIR`. The producer
requires the repository-pinned Node 24.19.0 and pnpm 10.15.0
toolchain and records both versions in `source-inputs.json`. iOS also
requires `LATCHWAY_IOS_SDK_PATH`, `LATCHWAY_IOS_COMMIT`,
`LATCHWAY_BUNDLE_ID`, version/build/distribution pins,
`LATCHWAY_FIREBASE_IOS_CONFIG_PATH`, `LATCHWAY_IOS_PODFILE_LOCK_PATH`,
`LATCHWAY_TEAM_ID`, `LATCHWAY_IOS_APP_ID_PREFIX`,
`LATCHWAY_IOS_CODE_SIGN_IDENTITY`,
`LATCHWAY_IOS_PROVISIONING_PROFILE_UUID`,
`LATCHWAY_IOS_APPINTENTS_BUNDLE_ID`,
`LATCHWAY_IOS_APPINTENTS_PROVISIONING_PROFILE_UUID`,
`LATCHWAY_IOS_SHARED_KEYCHAIN_ACCESS_GROUP`, and the production App Attest and
`LATCHWAY_SIGNING_CERTIFICATE_SHA256` pins. Android requires
`LATCHWAY_ANDROID_SDK_PATH`, `LATCHWAY_ANDROID_COMMIT`,
`LATCHWAY_PACKAGE_NAME`, `LATCHWAY_APP_VERSION`, `LATCHWAY_VERSION_CODE`,
`LATCHWAY_PLAY_TRACK`, `LATCHWAY_REQUIRE_LICENSED`,
`LATCHWAY_CLOUD_PROJECT_NUMBER`, `LATCHWAY_FIREBASE_ANDROID_CONFIG_PATH`, and
the expected Play App Signing `LATCHWAY_SIGNING_CERTIFICATE_SHA256`. The
checkout and Gradle are strictly unsigned-only and reject every
keystore/password/alias/upload-certificate input. The repository producer emits
only a closed unsigned AAB/APK handoff and a canonical pre-sign AAB payload
manifest. A protected fresh signer job receives that data without a checkout or
Gradle. Before any step receives key material it separately downloads the AAB
verifier, checks its protected SHA-256, regenerates the canonical AAB payload
manifest and byte-compares it with the carried manifest. It also strictly parses
the unsigned APK, binds its package/version, embedded configuration and
JavaScript bundle, rejects every `META-INF` signature control and requires
`apksigner` to reject it as unsigned. The secret-bearing step invokes only
system signing tools; APK signing fixes minimum SDK 24 and disables v1/JAR
signatures. A second fresh job has no secret and no checkout; it accepts the
verifier source only when its SHA-256 matches the same protected pin. The
verifier independently parses local and central ZIP records,
rejects structural mismatches, unsafe modes, overlaps, trailing/polyglot bytes,
ambiguous names and extra signature metadata, fully reads every payload, pins
one common leaf signer, and requires exact continuity with the separately
carried pre-sign manifest. The exact independently verified AAB/APK bytes are
the only publishable signed output. The signer also retains the source-built
unsigned APK. The fresh verifier hash-binds it to the unsigned candidate
manifest, rejects `META-INF` signature controls in both APKs, requires the
signed APK's complete ZIP payload to be identical (only the v2/v3 APK signing
block may differ outside the ZIP payload), and independently rechecks package,
version, embedded Firebase and candidate-configuration hashes, JavaScript
bundle, and upload signer. This
prevents a correctly signed APK substituted inside the key-bearing boundary
from becoming a release output. Passwords and keystores never enter the
repository build or candidate output. Runtime identity grants are rejected if
present during candidate production.

Use `.github/workflows/react-native-android-candidate.yml` for the Android
release handoff. Its build job is the only job with a checkout and emits only
unsigned data; `sign-isolated` has no checkout or Gradle, and `verify-signed`
has neither signing secrets nor a checkout. Configure the protected verifier
environment with the exact SHA-256 of
`scripts/VerifyReactNativeAabSignature.java`; changing the verifier therefore
requires an explicit protected-coordinate review. Also set the protected
`LATCHWAY_ANDROID_UPLOAD_SIGNATURE_ALGORITHM` coordinate to the upload key's
exact `SHA256withRSA` or `SHA256withECDSA` algorithm.

Before importing native-only proofs, the finalizer validates the native profile
and report against its platform-authoritative checked-in schema, requires
`release_eligible=true`, checks the platform and repository, and binds native
SDK, core, contract, gateway image/configuration/origin/deployment-statement
coordinates. The native
report's byte SHA-256 must match all three independent bindings: the value
embedded in the signed React Native candidate, the protected React Native
profile, and the externally signed one-job collector lease. Only the five exact
allowlisted native tests are copied. Missing, failed, renamed, extended,
cross-platform, rehashed, or coordinate-substituted reports fail closed.

Android native and React Native output evidence use the shared v1 contract. The
pinned iOS SDK uses the component-aware v2 contract; this repository carries an
exact reviewed snapshot at
`Conformance/linked-ios-physical-device-evidence.schema.json` together with its
validator at `scripts/linked-ios-device-evidence.py`. The finalizer test pins the
raw reviewed bytes (validator SHA-256
`8d12b2beb887cebb10f1fcc634cd9ebad839e3b40372a03f5f558ad5f41bc0d4`, schema
SHA-256 `b0f399ff16ff21e80ac1528af143e3834d0ef80e8a8dbeb9c7d4a2e354ead8c6`),
so an unreviewed snapshot change fails CI. This prevents genuine v2 iOS evidence
from being treated as v1 while preserving the v1 React Native output consumed
by the current cross-repository release adapter.

The linked iOS report must contain the exact 13-test component-observation v2
set. Widget, Share, and Action must each record a distinct successful delegated
request; sibling server credentials must be rejected; an Action attempt to read
a Widget or Share private key must record `SecItemCopyMatching` returning
`errSecMissingEntitlement` without key material; and two overlapping refreshes
must independently return the same rotated credentials and session. The fresh
GitHub-hosted signer rechecks those concrete fields before attesting the React
Native evidence bundle. The finalizer still imports only the five allowlisted
native security proofs into the outer report.

The React Native example does not reproduce or claim the linked SDK's
Widget/Share/Action operations: its App Intents target has no React Native
runtime or component-request bridge and fails closed when invoked. The React
Native iOS run proves the root App Attest path plus the exact, hash-bound native
Installation Family evidence.

For iOS, the producer archives a non-debug, production-signed New Architecture
`.app` from the exact candidate commit. It requires a protected `Podfile.lock`,
Firebase plist, signing identity, distinct root and App Intents bundle IDs and
provisioning-profile UUIDs, the protected shared Keychain access group,
certificate hash, Team ID, and App ID Prefix. App ID Prefix is independently
protected because it can differ from Team ID; it binds `application-identifier`
and both Keychain access groups. The signed root target must have exactly the
private app-ID group first and the shared component group second. The signed
App Intents extension must have only the shared group, so it cannot read root
default Keychain state. Each modern provisioning profile is verified with
OpenSSL CMS, then its UUID, devices, Team ID, App ID Prefix, bundle ID, and
App Attest/get-task-allow policy are checked. Every signed Keychain group must
be authorized by an exact profile entry or a well-formed terminal `*` prefix;
unrelated profile grants are allowed, while malformed wildcards and
unauthorized signed groups fail closed. Root signing and its profile must both
carry the exact App Attest `app-attest-opt-in=[CDhash]` value, and the profile
must authorize the production environment. The App Intents extension and its
profile must carry neither App Attest entitlement key.
`LATCHWAY_IOS_INSTALL_MODE` must be `install`:
the runner uninstalls any old application, verifies absence, and installs the
inspected candidate immediately before launch. The executable and
`main.jsbundle` SHA-256 pins must both match. The producer also emits a
canonical per-file `ios-app-files.sha256` manifest and the native-compatible
`latchway.ios-app-bundle-tree.v1` digest, which additionally binds directory
and file modes. Both hashes are protected lease coordinates and are copied to
the final profile/evidence. The collector copies the `.app` into a private
snapshot, verifies both hashes there, re-verifies both immediately before
handoff, and installs that exact snapshot. The bundle cannot contain its own
JavaScript hash, so that non-secret, lease-bound digest is supplied at launch
through the native child environment.

For Android, publish the same Release AAB through the pinned Play track,
install it from `com.android.vending` on the locked physical device, and keep a
licensed Play account on that device. This Play licensing account is only for
Play Integrity recognition; it is not the application's Firebase identity.
The serial is a secret. The package,
version, version code, canonical installed base/split APK-set manifest hash,
certificate hash, Play track, and cloud project number are protected
environment variables. Every split is signature/package/version-code checked;
the complete installed split manifest is captured before launch and again
after the observed run, and both the digest and byte-for-byte manifest must be
identical before the observed digest is written to the evidence profile;
an added, removed, or substituted split changes the protected set hash.

The protected GitHub environments are:

- `react-native-ios-production`, on a newly booted repository-scoped JIT
  runner registered with `--ephemeral`, labelled `macOS`,
  `latchway-physical-ios`, and `latchway-ephemeral-jit`, and named exactly
  `latchway-rn-ios-<run-id>-<run-attempt>`;
- `react-native-android-production`, on the equivalent one-job runner labelled
  `Linux`, `latchway-physical-android`, and `latchway-ephemeral-jit`, and named
  exactly `latchway-rn-android-<run-id>-<run-attempt>`.

The application identity bootstrap is a Firebase custom token minted for the
protected run. It is not a Latchway session/admin grant and crosses only the
example-specific `LatchwayEvidence` bridge; it never crosses the public
`@latchway/react-native` SDK bridge. The token must be 32–65,536 bytes and exactly three
non-empty base64url JWT segments. The signed collector lease and issuer record,
not the Firebase JWT's provider-defined `aud` field, authoritatively bind its
SHA-256, repository, source commit, run/attempt, exact Latchway
`application_id`, exact iOS bundle ID or Android package name in
`package_or_bundle_identifier`, `identity_provider="firebase"`, issuance,
expiry, and collector audience. Both the source-free collector gate and the
fresh candidate-code-free attestation signer revalidate all three
identity/application fields.
The example exchanges it exactly once with
`signInWithCustomToken` to obtain a Firebase ID token; native Latchway code
continues to own App Attest/Play Integrity, DPoP, session, and refresh state.

Reusable runners, runners able to accept a second job, surviving workspaces,
and shared devices are ineligible. Each environment configures the public
collector trust root and SHA-256 plus its platform-specific one-use device
grant SHA-256. The grant is provisioned after the run ID and attempt exist,
records its issuance and expiry, remains valid for at most five minutes and no
later than the runner lease, is accepted once, and is bound
to repository, source commit, run/attempt, application, and
collector audience `latchway-physical-evidence/rn-ios-app-attest` or
`latchway-physical-evidence/rn-android-play-integrity`. No reusable identity
session, organization/admin token, PAT, registry/cloud credential, or OIDC
authority may be present on a collector. If platform application setup cannot
consume that one-use Firebase custom token, the physical gate cannot run.

Only the platform collection step receives the actual custom token. It first
hash-verifies the value against the signed lease coordinate and removes it from
the runner environment immediately after launch/staging. iOS inherits it
through `DEVICECTL_CHILD_*`; the app captures it before React Native starts,
unsets the process environment, and has one terminal in-memory read. This is a
bounded lifetime, not a claim that immutable Swift string bytes are
cryptographically zeroized; uninstall is authoritative. Android streams it on
stdin through a shell-only `android.permission.DUMP` content provider into one
process-memory slot—never an intent extra, argv value, log, or file—and clears
the mutable byte buffers. Fresh install/app-data clear forbids a persisted
Firebase `currentUser` from satisfying either platform run.

The variable names are `LATCHWAY_COLLECTOR_TRUST_ROOT_PEM`,
`LATCHWAY_COLLECTOR_TRUST_ROOT_SHA256`, `LATCHWAY_APPLICATION_ID`, and
respectively `LATCHWAY_IOS_BUNDLE_ID` plus
`LATCHWAY_IOS_DEVICE_GRANT_SHA256` and the producer-emitted
`LATCHWAY_IOS_APP_FILES_MANIFEST_SHA256` and
`LATCHWAY_IOS_APP_BUNDLE_TREE_SHA256`, or `LATCHWAY_ANDROID_PACKAGE_NAME` plus
`LATCHWAY_ANDROID_DEVICE_GRANT_SHA256`. The public trust root, expected hashes,
and non-secret application identifiers are repeated in
`physical-evidence-signing`; no private supervisor key, device selector,
application credential, or grant value is present there.

Create a third reviewed environment, `physical-evidence-signing`, in this
repository. It must contain no device, identity, application, native-evidence,
or runner credentials; the exact application identifiers above are coordinates,
not credentials. Require independent reviewers and restrict deployments to
`main`.

Environment protection should require an independent reviewer and prevent
untrusted pull-request code from reaching the devices or application accounts.
Toolchain identities are compared byte-for-byte with the protected expected
Xcode, `adb`, and `apksigner` versions before collection.

## Ephemeral runner identity and teardown

The GitHub-hosted `authorize-source` job checks out the React Native candidate
only as data, executes no repository code, records its exact commit and Git
tree for both platform audiences and this run/attempt, and creates a GitHub
Sigstore attestation. Each collector verifies that bundle with
`--deny-self-hosted-runners` before checking out or executing candidate code.

Every JIT image exposes root-owned, non-writable
`/etc/latchway/physical-collector/lease.json` and `lease.sig`, and the
root-owned client `/usr/local/libexec/latchway-physical-collector-finalize`.
The ECDSA/SHA-256 lease is signed outside the candidate VM and binds repository,
source commit and authorization hash, workflow run/attempt/job/audience,
runner name/image/boot identity, one-job/fresh/JIT flags, the exact signed app
or installed APK-set, the iOS per-file manifest and whole-tree digests,
JavaScript bundle and linked-native evidence hashes, and
the one-use grant hash/issuance/expiry. Its credential declaration must deny
long-lived, organization, administration, registry, and OIDC credentials.
The signed lease uses `latchway.physical-collector-lease.v2`, requires the exact
canonical grant key set, and asserts that the supervisor enforces the protected
grant digest once. The signed `latchway.physical-collector-teardown.v2` must
assert one consumption and gateway-receipt binding, and its
`observations.identity_grant_sha256` must equal that protected digest. Both the
collector and fresh signer enforce these fields for iOS and Android.

The finalizer is a client for an authenticated privileged supervisor, not a
general signing utility. The signing key and gateway observer capability stay
outside candidate control. The service accepts file paths rather than
caller-supplied digest claims, independently hashes and validates the source,
evidence, and wipe receipt, independently observes the device and the
gateway's server-side App Attest or Play Integrity run receipt, and permits one
invocation per lease. It deregisters the runner, prevents another job, and
schedules VM destruction within ten minutes. Candidate code can force a
failure, but it cannot obtain a signature over arbitrary hashes or a synthetic
device/provider verdict.

The supervisor's out-of-band watchdog must revoke the JIT registration,
invalidate the one-use grant, wipe/reset the attached device, and destroy the
VM after cancellation, timeout, runner crash, network loss, or a missing
finalizer receipt. This path cannot depend on candidate code or a final Actions
step executing.

Platform app-data wipe and supervisor finalization are separate unconditional
`if: always()` steps. iOS uninstalls the conformance app and confirms absence;
Android runs `pm clear` and confirms no process remains. Finalization still
runs if lease, source, toolchain, grant, collection, or wipe validation fails.
Only a signed teardown with `evidence_eligible=true`, independent
device/provider and gateway-receipt verification, successful wipe, JIT
deregistration, no further jobs, and a bounded destruction deadline can be
handed to the signer.

Both environments configure `LATCHWAY_GATEWAY_ORIGIN`, the deployment key ID,
the exact statement SHA-256, the local P-256 public-key path and SPKI SHA-256,
and `LATCHWAY_GATEWAY_MINIMUM_TRUST_LEVEL`. The gateway publishes canonical
`/.well-known/latchway/deployment-statement-v1.json` plus its detached DER
ECDSA/SHA-256 `.sig`. Statements last no more than 24 hours. Android policy
requires `PLAY_RECOGNIZED` and `LICENSED`; both platforms deny testing/debug
clients and require request-hash binding. The candidate embeds the origin,
environment, key ID, statement digest, and public-key digest.
The iOS client policy pins the core-normalized App Attest trust level exactly
to `app_verified`; the Android policy pins `device_verified` or
`strong_device_verified` according to its protected device requirement. A
provider's normalized trust level is never accepted as evidence for the other
provider. Both environments also pin `LATCHWAY_ERROR_MAPPING_FEATURE` to a
syntactically valid feature that is intentionally absent from the root
component's grant; the same non-secret value is embedded in the signed
candidate. It may also be absent from gateway configuration. The canonical
result remains HTTP 403 `component_feature_not_granted`, proving authorization
precedes feature lookup and does not disclose whether the feature exists.
This is the React Native wrapper's canonical mapping proof. The independently
versioned native iOS and Android reports retain their HTTP 404
`feature_not_found` mapping contract; the finalizer validates those reports
before importing only their five native-only security proofs.

## Collect and validate

Dispatch `.github/workflows/physical-device-evidence.yml` with the full
40-character React Native commit. The runners invoke:

```sh
scripts/run-physical-react-native-ios.sh
scripts/run-physical-react-native-android.sh
```

Each protected environment also pins `LATCHWAY_SOURCE_COMMIT` to that exact
40-character candidate. The workflow refuses a dispatch input that differs
from the environment pin. The example retires its dedicated prior Latchway
installation before the measured calls, so a session created by an older app
build cannot be reused as current App Attest or Play Integrity proof.

The scripts refuse dirty source trees, symbolic-link inputs, mismatched hashes,
unsafe devices, untrusted builds, stale run IDs, and malformed records. The
example-native sinks rebuild v2 JSON from exact platform runtime allowlists
(eight tests on iOS and seven on Android), reject native-only proof fields and
IDs, and expose only a fixed protected file;
they do not accept an arbitrary output path. Successful
artifacts contain the profile, sanitized observation, schema-validated evidence,
JUnit, validation summary, device inventory, linked native report/profile,
signed statement, signature, public key, exact client policy, verification
result, and `SHA256SUMS`. A failed run never becomes a passing report.

Each protected JIT collector runs with only repository-scoped `actions: read`
and `contents: read`: candidate
checkout, native/device execution, and access to app/device credentials have no
OIDC, attestation, or artifact-metadata authority. It uploads a bounded one-day
`react-native-<platform>-physical-unsigned-<run>-<attempt>` handoff. A fresh
GitHub-hosted Ubuntu job behind `physical-evidence-signing` downloads that
handoff without checking out source and uses only fixed inline shell, `jq`, and
hash checks to enforce the exact file set, size limits, manifest, source
commit, run/attempt, platform, physical-device, production-provider,
passing-test, and redaction coordinates. Only that job receives OIDC and
attestation permissions. It emits the observer-compatible final artifacts
`react-native-ios-physical-<run>-<attempt>` and
`react-native-android-physical-<run>-<attempt>`, with the GitHub Sigstore bundle
at exactly `github-attestation.sigstore.json` beside the attested profile,
evidence, and `SHA256SUMS`.

The signer additionally verifies the GitHub-hosted source authorization,
trust-root signatures on the lease and teardown, exact run/grant/artifact
coordinates, device-wipe receipt, evidence-manifest binding, independent
supervisor verdict, and destruction deadline. It attests a
`collector-isolation-validation.json` subject and retains separate
`react-native-<platform>-collector-isolation-<run>-<attempt>` artifacts for 30
days. The observer-compatible physical artifact file sets remain unchanged.

Repository validation cannot create hardware, a JIT provisioning service, the
root supervisor, isolated signing key/observer capability, one-use grant
issuer, protected environments, or a post-job hypervisor destruction record.
Those remain external release prerequisites. Operators must independently
retain a destruction log bound to the same lease/run as each final artifact;
the signed teardown proves deregistration and scheduled destruction, not that
the hypervisor later completed it.

Repository-only validation is safe to run anywhere:

```sh
python3 scripts/test-device-evidence.py
python3 scripts/test-physical-evidence-workflow.py
python3 scripts/test-finalize-react-native-device-run.py
python3 scripts/test-export-core-physical-evidence.py
python3 scripts/test-verify-gateway-deployment.py
bash -n scripts/gateway-deployment-evidence.sh
bash -n scripts/run-physical-react-native-ios.sh
bash -n scripts/run-physical-react-native-android.sh
```

These tests use synthetic *rejection* fixtures and schema-valid offline
documents. They are not physical-device evidence.

## Emit the core external domain document

After all four reports exist for one release, create a protected coordinates
file with exactly this shape:

```json
{
  "schema_version": 1,
  "core_commit": "<40 lowercase hex>",
  "core_release": "v<semver>",
  "contract_version": "<semver>",
  "bundle_sha256": "<64 lowercase hex>",
  "oci_image_digest": "ghcr.io/latchway/latchway@sha256:<64 lowercase hex>",
  "gateway_configuration_sha256": "<64 lowercase hex>",
  "repositories": {
    "core": { "commit": "<40 lowercase hex>", "tag": "v<semver>", "version": "<semver>" },
    "javascript": { "commit": "<40 lowercase hex>", "tag": "v<semver>", "version": "<semver>" },
    "ios": { "commit": "<40 lowercase hex>", "tag": "v<semver>", "version": "<semver>" },
    "android": { "commit": "<40 lowercase hex>", "tag": "v<semver>", "version": "<semver>" },
    "react_native": { "commit": "<40 lowercase hex>", "tag": "v<semver>", "version": "<semver>" }
  }
}
```

This file is prepared before publication: `tag` values are the intended
release names and need not exist yet. The adapter never resolves or fetches a
tag; it binds each report to the exact candidate commit and SDK version, while
requiring each future tag to equal `v<version>`.

Then run the deterministic offline adapter into a new, empty output directory:

```sh
python3 scripts/export-core-physical-evidence.py \
  --schema Conformance/physical-device-evidence.schema.json \
  --coordinates /protected/release-coordinates.json \
  --ios-profile /protected/ios/app-attest-profile.json \
  --ios-evidence /protected/ios/app-attest-evidence.json \
  --ios-attestation /protected/ios/github-attestation.sigstore.json \
  --ios-manifest /protected/ios/SHA256SUMS \
  --android-profile /protected/android/play-integrity-profile.json \
  --android-evidence /protected/android/play-integrity-evidence.json \
  --android-attestation /protected/android/github-attestation.sigstore.json \
  --android-manifest /protected/android/SHA256SUMS \
  --rn-ios-profile /protected/rn-ios/react-native-ios-profile.json \
  --rn-ios-evidence /protected/rn-ios/react-native-ios-evidence.json \
  --rn-ios-attestation /protected/rn-ios/github-attestation.sigstore.json \
  --rn-ios-manifest /protected/rn-ios/SHA256SUMS \
  --rn-android-profile /protected/rn-android/react-native-android-profile.json \
  --rn-android-evidence /protected/rn-android/react-native-android-evidence.json \
  --rn-android-attestation /protected/rn-android/github-attestation.sigstore.json \
  --rn-android-manifest /protected/rn-android/SHA256SUMS \
  --output-root /protected/core-physical-evidence
```

Run this on a trusted release host with the GitHub CLI (`gh`) available. The
adapter verifies each profile and evidence file against its retained GitHub
Sigstore bundle, exact repository, protected workflow path, and candidate
source commit before parsing its claims. It then validates every report again,
requires the exact SDK version and shared gateway configuration/release
coordinates, requires all four reports to bind the same signed deployment
origin/key/statement, verifies both React Native-to-native evidence hashes, enforces a
seven-day collection/freshness window, copies all sixteen hashed source
artifacts. The gateway configuration hash remains mandatory in the protected coordinates
and every raw report, and is retained through the copied artifacts and their
hashes. It is intentionally not a top-level member of `physical_devices.json`,
whose envelope exactly matches the core consumer contract. Only then does the
adapter write that domain with these four claims:

- `app_attest_production_verified`
- `play_integrity_play_distributed_verified`
- `react_native_ios_verified`
- `react_native_android_verified`

All four claims are written together and only as `true`; there is no switch or
manual override that can manufacture a passing domain document. Preserve the
output as an immutable release artifact and run the core cross-repository
conformance validator against that directory.
