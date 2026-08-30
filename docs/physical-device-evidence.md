# Physical-device release evidence

The React Native release gate proves that the published JavaScript surface
actually reaches the locked native iOS and Android SDKs on production-eligible
devices. A simulator, emulator, debug build, testing process, debugger-attached
process, software-key fallback, sideloaded Android build, or testing attestation
environment can never produce passing release evidence.

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
- a DPoP-authorized request through the opaque native dispatch boundary and the
  concrete React Native `LatchwayError` mapping for a canonical 404;
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
the exact signed `.app`, production App Attest entitlement, application
identifier, team, signing certificate, and executable hash before launch.

## Prepare immutable candidates

First produce and retain the native reports with the sibling SDK workflows:

- iOS: `latchway-ios-sdk/.github/workflows/physical-app-attest.yml`
- Android: `latchway-android/.github/workflows/physical-play-integrity.yml`

Stage each native evidence/profile pair on its matching protected runner. Pin
its evidence SHA-256 in the React Native environment. A React Native candidate
must embed all physical-run values listed in `example/.env.example`, with
`LATCHWAY_CONFORMANCE_AUTORUN=true`. Those values are release identifiers, not
credentials, but the build configuration itself remains a protected release
input. Identity-provider configuration and accounts must be supplied through
the platform's normal protected application setup and must never be stored in
evidence artifacts.

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
validator at `scripts/linked-ios-device-evidence.py`. This prevents genuine v2
iOS evidence from being treated as v1 while preserving the v1 React Native
output consumed by the current cross-repository release adapter.

For iOS, build a non-debug, production-signed New Architecture `.app` from the
exact candidate commit. `LATCHWAY_IOS_INSTALL_MODE` must be `install`: the
runner rejects preinstalled applications and installs the inspected candidate
immediately before launch. The protected executable and `main.jsbundle`
SHA-256 pins must both match. The physical device identifier is a secret and
the remaining workflow inputs are protected environment variables.

For Android, publish the same Release candidate through the pinned Play track,
install it from `com.android.vending` on the locked physical device, and sign in
with the protected licensed test account. The serial is a secret. The package,
version, version code, canonical installed base/split APK-set manifest hash,
certificate hash, Play track, and cloud project number are protected
environment variables. Every split is signature/package/version-code checked;
an added, removed, or substituted split changes the protected set hash.

The protected GitHub environments are:

- `react-native-ios-production`, on a newly booted repository-scoped JIT
  runner registered with `--ephemeral`, labelled `macOS`,
  `latchway-physical-ios`, and `latchway-ephemeral-jit`, and named exactly
  `latchway-rn-ios-<run-id>-<run-attempt>`;
- `react-native-android-production`, on the equivalent one-job runner labelled
  `Linux`, `latchway-physical-android`, and `latchway-ephemeral-jit`, and named
  exactly `latchway-rn-android-<run-id>-<run-attempt>`.

Reusable runners, runners able to accept a second job, surviving workspaces,
and shared devices are ineligible. Each environment configures the public
collector trust root and SHA-256 plus its platform-specific one-use device
grant SHA-256. The grant is provisioned after the run ID and attempt exist,
records its issuance and expiry, remains valid for at most five minutes and no
later than the runner lease, is accepted once, and is bound
to repository, source commit, run/attempt, application, a unique `jti`, and
audience `latchway-physical-evidence/rn-ios-app-attest` or
`latchway-physical-evidence/rn-android-play-integrity`. No reusable identity
session, organization/admin token, PAT, registry/cloud credential, or OIDC
authority may be present on a collector. If platform application setup cannot
consume that one-use grant, the physical gate cannot run.

The variable names are `LATCHWAY_COLLECTOR_TRUST_ROOT_PEM`,
`LATCHWAY_COLLECTOR_TRUST_ROOT_SHA256`, and respectively
`LATCHWAY_IOS_DEVICE_GRANT_SHA256` or
`LATCHWAY_ANDROID_DEVICE_GRANT_SHA256`. The public trust root and expected
hashes are repeated in `physical-evidence-signing`; no private supervisor key,
device selector, application credential, or grant value is present there.

Create a third reviewed environment, `physical-evidence-signing`, in this
repository. It must contain no device, identity, application, native-evidence,
or runner credentials. Require independent reviewers and restrict deployments
to `main`.

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
or installed APK-set, JavaScript bundle and linked-native evidence hashes, and
the one-use grant hash/`jti`/issuance/expiry. Its credential declaration must deny
long-lived, organization, administration, registry, and OIDC credentials.

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
Both environments also pin `LATCHWAY_ERROR_MAPPING_FEATURE` to a
guaranteed-absent feature; the same non-secret value is embedded in the signed
candidate.

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
example-native sinks rebuild v2 JSON from an exact seven-test runtime allowlist,
reject native-only proof fields and IDs, and expose only a fixed protected file;
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
