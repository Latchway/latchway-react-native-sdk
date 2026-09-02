# Releasing the React Native SDK

The release is driven by `release-compatibility.json`; it is not assembled from
whatever happens to be at the tips of sibling repositories. CI reads the
locked commits from that file, checks out those exact objects, verifies every
SDK contract lock, rebuilds and checks the full core contract bundle, and then
builds real React Native 0.82 hosts.

## Single-maintainer v1 publication profile

The additive `single-maintainer-release.yml` workflow is the explicit launch
path for `1.0.0` while independent human review and external device/provider
evidence remain deferred. It accepts only an exact `main` commit, validates all
four locked sibling source commits, and records
`single_maintainer_v1`, `release_qualified: false`, and the forbidden stronger
claims before proceeding.

Before any React Native tag mutation, the workflow requires exact annotated
`v1.0.0` tags for core, JavaScript, iOS, and Android; a byte-identical locked
`@latchway/client` npm archive; and the exact CocoaPods source binding. The
Android dependency gate authenticates the exact finalized 14-asset
`single_maintainer_v1` GitHub release, annotated tag message, per-asset GitHub
build provenance, maintainer intent, completion record, and the declared
deferred-evidence set against the Android commit in
`release-compatibility.json`. It then compares every Maven Central primary
artifact and checksum byte with the reviewed repository archive, compares every
public OpenPGP signature with the signed Portal candidate, and independently
verifies each signature against the release public key. A POM or coordinate
existence check is not sufficient. The workflow then runs the complete
TypeScript, compatibility, deterministic package, consumer, Android host, and
iOS host gates. Deferring Android physical-device evidence therefore does not
defer the Android SDK or Maven publication dependency.

`pnpm verify:compatibility` also requires both `Package.swift` and the
`latchway-ios-sdk` entry in `Package.resolved` to use the exact iOS source
revision in `release-compatibility.json`. Updating the compatibility tuple
without updating either SwiftPM lock fails ordinary CI and both release paths.

Create a `single-maintainer-v1` GitHub environment restricted to `main`, with
the environment-only `LATCHWAY_RELEASE_CONTROL_POLICY_ID` variable set exactly
to
`latchway-release-controls-v1:latchway-react-native-sdk:single-maintainer-v1`.
The first step of every job that names this environment checks the sentinel
before any checkout, credential access, OIDC request, or mutation, so a missing
environment cannot be silently auto-created without the intended controls. It
contains no npm token and does not require an independent reviewer. Configure
`@latchway/react-native`'s one npm trusted publisher as organization
`Latchway`, repository `latchway-react-native-sdk`, workflow file
`single-maintainer-release.yml`, environment `single-maintainer-v1`, and the
publish action. npm permits only one trusted publisher: while this tuple is
active, strict `release.yml` cannot publish the package. A future `strict_full`
release requires deliberate reconfiguration back to workflow file
`release.yml` and environment `npm`.

```bash
gh workflow run single-maintainer-release.yml --ref main \
  -f release_profile=single_maintainer_v1 \
  -f release_commit="$(git rev-parse HEAD)" \
  -f release_version=1.0.0 \
  -f confirmation=publish-v1.0.0-with-deferred-assurance
```

The additive workflow treats one workflow run as the transaction owner. Its
intent hash binds the run ID and run attempt into the annotated tag. Before the
candidate checkout can execute, a source-free step authenticates the GitHub run
ID, attempt, workflow path, `main` head branch, and requested source commit.
Dispatch strings reach shell commands only through quoted environment
variables. Immediately before tag creation, the protected job rechecks that
the authenticated intent commit, dispatch input, workflow SHA, and current
public `main` head are identical. Before the tag exists, the intent job rejects
any pre-existing `v1.0.0` tag unless that tag belongs to this exact
transaction. Once the tag, npm coordinate, or GitHub
draft has been created, resume only with **Re-run failed jobs** on that same
workflow run. Never use **Re-run all jobs** and never start a new workflow
dispatch after a mutation: either action creates a different intent and the
early tag-owner guard fails closed. Prerequisite intent, package, and npm
evidence artifacts are retained for 90 days. The GitHub publisher resumes an
exact partial draft asset-by-asset, compares every adopted asset byte for byte,
and finalizes only an exact remote closure; it never overwrites an asset.

Before any React Native tag or npm mutation, the workflow authenticates the
public core `v1.0.0` `single_maintainer_v1` record, annotated core tag, candidate
and deployment attestations, scans, SBOMs, image digest, and the exact Docker
Compose and Google Cloud Run captures. The locked contract commit must be an
ancestor of that published core commit. Existing
`@latchway/react-native@1.0.0` bytes are not sufficient for adoption: npm's
Sigstore provenance must bind the exact `Latchway/latchway-react-native-sdk`
repository, `single-maintainer-release.yml`, `main` ref, and source commit, and
the package signature is audited. AWS, Fly.io, Cloudflare Containers, devices,
providers, and independent review remain explicitly deferred.

## Cross-repository order

1. Create a core **contract checkpoint** that marks the manifest released,
   records the fresh `released_at` value, and rebuilds the deterministic
   contract archive. Commit that checkpoint, but do not publish the core tag or
   image yet.
2. Create successor JavaScript, iOS, and Android commits whose `contract.lock`
   files name `v1.0.0`, the exact contract-checkpoint commit, and its new bundle
   hash. Synchronize their public constants, vendored fixtures, and final
   `## [1.0.0]` changelog headings. Create the React Native successor last so
   `release-compatibility.json` pins those three exact green successor commits.
3. Build every SDK documentation bundle from its clean successor commit. Import
   those exact bundles into a final core candidate and synchronize the
   documentation mirror. The final core candidate must retain an `api/` tree
   byte-identical to the contract checkpoint; its later documentation and
   release metadata do not change the contract archive.
4. Run the candidate, cross-repository, security, provider, device, cloud, and
   operations evidence workflows against that exact five-repository tuple.
   Promote the final core commit only after every non-publication release domain
   passes. Core promotion publishes the image and release, then dispatches the
   exact SDK successor coordinates through the `repository_dispatch` event.
5. Publish the exact four-package JavaScript set (`@latchway/client`,
   `@latchway/openai`, `@latchway/vercel-ai`, and `@latchway/langchain`), the
   iOS pod/tag, and all Android Maven artifacts/tag. Their immutable GitHub
   releases, per-asset attestations, public registry bytes, registry signatures,
   and source commits must all match the lock; git tag or package metadata alone
   is not sufficient.
6. After the promotion envelope is authenticated, the promotion-dispatched
   `.github/workflows/release.yml` starts three parallel branches: one creates
   or verifies the protected annotated `v<package-version>` tag at the exact
   promoted commit, one authenticates locked source, and one waits for and
   authenticates the immutable JavaScript, iOS, and Android releases. The
   downstream dependency-validation and consumer jobs wait for all three, so
   the irreversible tag exists before those gates execute. They then remove
   local path/repository overrides and build the clean npm consumer plus the
   official iOS and Android example hosts. The manual
   `Published dependency consumer` workflow is an optional independent
   diagnostic; its output is not a release workflow input and does not require
   promotion to be rerun.
7. After those internal dependency and consumer gates pass, the same release
   run publishes npm through the trusted publisher and finalizes the immutable
   GitHub release. Operators must not create or push the tag manually. Because
   the protected tag already exists, a later dependency, consumer, npm, or
   GitHub-release failure can strand that semantic version; never move or reuse
   it. Correct the inputs and restart the cross-repository sequence with a new
   version.

The released-lock successor tuple now satisfies the source transition in steps
1 through 3. It is still not independently publishable: the protected evidence,
promotion, public dependency, and registry gates in steps 4 through 7 remain
mandatory. The coordinated successor sequence is a required release
transition, not a post-publication cleanup.

`pnpm release:preflight -- v<package-version>` intentionally fails for a dirty
tree, lightweight/wrong-commit tag, mismatched version, unpublished core lock,
missing changelog section, local dependency, or forbidden generated/secret
file.

## npm and GitHub configuration

The inert `@latchway/react-native@0.0.0-bootstrap.0` package record must exist
under the `bootstrap` dist-tag before stable promotion. Configure that package's
npm trusted publisher with organization `Latchway`, repository
`latchway-react-native-sdk`, workflow filename `release.yml`, environment
`npm`, and allowed action `npm publish`. Configure four protected GitHub
environments: `private-sibling-read`, `npm`, `release-administration`, and
`github-release`. Every environment must require at least one reviewer, set
`prevent_self_review: true`, use an exact main-only custom deployment branch
rule with no tag policy, and disable administrator bypass wherever the repository
plan exposes that control. A human or administrator is never a release-control
bypass actor; the active `refs/tags/v*` ruleset may allow only the GitHub Actions
integration used by this workflow to create the tag.

Each environment must define exactly one environment variable named
`LATCHWAY_RELEASE_CONTROL_POLICY_ID`, with no repository- or organization-level
fallback:

- `private-sibling-read`:
  `latchway-release-controls-v1:latchway-react-native-sdk:private-sibling-read`
- `npm`: `latchway-release-controls-v1:latchway-react-native-sdk:npm`
- `release-administration`:
  `latchway-release-controls-v1:latchway-react-native-sdk:release-administration`
- `github-release`:
  `latchway-release-controls-v1:latchway-react-native-sdk:github-release`

Delete any repository or organization variable with that name. The first step
of every protected release job checks the environment-specific value before an
action, checkout, download, credential, job token, OIDC request, or mutation can
run; a missing environment that GitHub auto-creates therefore fails closed. The
`npm` environment is limited to trusted npm publication and retained
registry evidence; it contains no reusable credential. The
`release-administration` environment contains only a fine-grained
`LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN` with read-only repository Administration
permission, stored only as an environment secret. Its jobs use
`permissions: {}`, never check out candidate source,
and receive neither OIDC nor GitHub content-write authority. The
`github-release` protects the promotion job that creates or verifies the
annotated tag as well as the separate draft and final GitHub release mutation
jobs; those jobs receive neither the administration token nor npm credentials,
and that environment contains no secret. Do not define any of
these protected names as a repository or organization secret: environment
review must never fall back to a broader secret scope. The built-in
`github.token` used for public reads is not a substitute for a protected secret.
`Latchway/latchway-react-native-sdk` must be public at
publication time because the required npm provenance is not generated for a
private source repository. The workflow runs on a GitHub-hosted runner with
`id-token: write`, npm 11.6.2, and provenance-enabled publication. A separate
source-free `permissions: {}` job downloads the exact
npm 11.6.2 registry tarball with lifecycle scripts disabled and authenticates a
one-file artifact closure: 2,663,834 bytes, 2,133 regular entries, 11,785,613
unpacked bytes, SHA-256
`585f95094ee5cb2788ee11d90f2a518a7c9ef6e083fa141d0b63ca3383675a20`, and
integrity
`sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==`.
The OIDC job rechecks that predeclared name-only closure, byte size, SHA-256,
SHA-512, integrity, member paths and types, and unpacked size before extraction
or execution. It invokes the verified CLI directly and never runs `npm install`,
`npm exec`, or `npx` while holding OIDC or attestation permissions. Before any
draft or asset mutation, a source-free `release-administration` job requires
GitHub's exact immutable-release settings response to report
`enabled: true` and `enforced_by_owner: true`, and requires the installed
GitHub CLI to support JSON release and asset attestation verification. Bootstrap the npm package
record through a separately reviewed one-time procedure if the registry requires
it; the release workflow never accepts `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

Before release, install an active repository ruleset for `refs/tags/v*` that
allows tag creation only through the GitHub Actions integration used by
`.github/workflows/release.yml` and denies tag updates, deletion, and
non-fast-forward changes. Operators and administrators must not create, move,
or delete the release tag manually. This server-side rule remains an external
release prerequisite. Annotated tag creation is the one release mutation that
uses the authenticated core-promotion report and tag ruleset as its authority;
it deliberately precedes immutable-release authorization and never uses the
administration credential.

The v1 release requires the core and all sibling SDK repositories to be public
before promotion. Keep the historically named `private-sibling-read`
environment as a credential-free protected approval boundary: it contains no
secret and must use the reviewer, self-review prevention, main-only branch,
sentinel, and no-bypass controls above. Never define
`LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN` at environment, repository, or
organization scope. The release and promotion-envelope jobs use only their
built-in `github.token` for public GitHub API and checkout reads. The locked
source workflow instead uses a credential-helper-disabled anonymous HTTPS fetch
for each exact public commit and rejects every credential prompt. A private
sibling therefore fails closed; it is not supported by the v1 public release
workflow and must not be enabled by adding a broader-scoped fallback secret.

The manual `Published dependency consumer` workflow uses only the job's built-in
`github.token` for public reads inside a protected `authenticate-inputs` job that
never checks out or executes the React Native candidate. Fixed commands validate
the compatibility and
contract locks at the exact workflow commit, authenticate the locked JavaScript
source into a Git bundle, capture the immutable tag, release, asset, and build
attestation evidence, and seal everything into one size-bounded, SHA-256-bound
artifact. The Android and iOS jobs compare the sealed locks byte for byte with
their exact candidate checkout, validate the complete artifact manifest, clone
only the authenticated bundle, and use
`LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS` for offline GitHub evidence. They
receive no `GH_TOKEN`, `GITHUB_TOKEN`, `NODE_AUTH_TOKEN`, or OIDC request URL.

The main-branch/workflow-dispatch `Locked source conformance` workflow applies
the same split to source builds. Its protected `authenticate-inputs` job has no
candidate checkout: a fixed GitHub API request reads only
`release-compatibility.json` and `contract.lock` at the exact workflow commit,
then a separately scoped, credential-free step fetches the four locked public
commits and creates their bundles. Another credential-free step seals those
bundles and locks as an exact six-payload-file, size-bounded, SHA-256-bound
closure plus its manifest. Fresh JavaScript, Android, and iOS jobs have no
protected environment, secret, registry authentication, or OIDC permission.
Before candidate-owned `ci-lock-output.mjs` or build tooling runs, each job
asserts that credential and OIDC variables are empty, compares both locks byte
for byte with the exact candidate, validates the complete archive manifest, and
imports all four bundles offline. Pull-request `ci.yml` contains no secret
reference.

The first source-free `release-administration` preflight waits for the full
verification, Android, iOS, and authenticated npm-CLI prerequisites. It emits a
canonical JSON lease plus its SHA-256, bound to the exact repository, release
coordinates, workflow run and attempt, `draft-and-npm` phase, and the exact
owner-enforced immutable-release settings. Run and attempt identifiers are
positive, bounded JSON integers no larger than 9,007,199,254,740,991; strings,
fractions, zero, and larger values are rejected. The lease lifetime is at most
600 seconds and its validity interval is half-open:
`issued_at_epoch <= now < expires_at_epoch`, so the exact expiration second is
unauthorized. It travels only as canonical JSON and SHA-256 scalar job outputs,
never as a downloadable
archive or artifact whose nested filesystem closure could be expanded. Both the
draft and npm publication jobs reject a noncanonical or oversized JSON closure,
hash mismatch, wrong run or attempt, wrong phase, repository or release
substitution, extra field, non-owner-enforced setting, future issue time, or
expired or overlong lease. They recheck the lease immediately before draft
creation, npm provenance attestation, and the first npm publish.

After that preflight, the separately reviewed `github-release` job resolves the
remote annotated tag object to the promoted commit immediately before it creates
or resumes the fixed-asset GitHub draft before npm publication, but does not
publish that release until every asset is attached. A second no-checkout,
no-OIDC `release-administration` job rechecks the immutable-release setting and
emits a separate `final-github-release` JSON and SHA-256 lease. The final
`github-release` OIDC job receives no administration credential, validates that
lease before tooling, and rechecks it immediately before its public provenance
attestation and every GitHub asset upload or release-finalization mutation. It
validates the exact local asset closure before attesting it. It checks an existing npm version by
exact tarball bytes and SHA-512 for safe retry, then retains the bounded raw npm
registry, `npm view --json --include-attestations`, Sigstore, and
`npm audit signatures` outputs as hash-bound release assets. Project and user
configuration cannot redirect these scoped operations: each npm or
pnpm network command pins both the default registry and `@latchway:registry` to
`https://registry.npmjs.org/` at CLI precedence, while isolated user, global,
project, and cache configuration removes inherited registry overrides.
Existing GitHub assets are downloaded and compared byte for byte, only missing
draft assets are attached, and a mismatched or incomplete final release stops
the run. After
finalization and every release/asset attestation verification, it fetches the
remote tag ref and annotated tag object again and requires the exact tag name
and promoted commit binding. Bounded retries of `gh release verify` and
`gh release verify-asset` are parsed with duplicate-key rejection: the signed
source commit and exact asset-name/SHA-256 closure must match every fixed or
adoption-history asset.

If an npm publish succeeds but a later step fails, only GitHub's **Re-run all
jobs** operation or a fresh promotion dispatch may adopt that immutable version,
and only after rechecking its exact bytes, signatures, and source provenance.
Never use **Re-run failed jobs**: successful lease-producing jobs would retain
the previous `run_attempt`, while their consumers execute under the new attempt
and correctly reject the stale lease. The attested adoption record binds the
original provenance-producing run and attempt, the current successful run and
attempt, and the exact retained registry evidence manifest. The
published-dependency gate applies the same standard to the locked JavaScript,
iOS, and Android releases. React Native links
only `@latchway/client`, but the JavaScript release is indivisible: the gate
requires its exact 31 fixed assets, all four package archives, the version 2
reviewed package-set and registry-manifest schemas, the version 2 publish-input
schema, the version 3 publication schema, and at least one package-suffixed
adoption record for each package. It independently checks the client entry,
four-package order, per-package retained-output names and hashes, byte identity
from each GitHub archive through npm, trusted-publisher provenance, and live
signature audit for every package. It also verifies every strictly parsed
automatic release/asset attestation, annotated source tag, source-bound workflow
attestation, and each live registry byte. It independently verifies Maven
signatures against the attested
public key with a fail-closed GnuPG status allowlist that rejects revoked,
expired, unknown, or weak signatures. An interrupted exact promotion can
therefore be retried only by re-running all jobs or starting a fresh dispatch.

Do not manually create or retag a failed release or overwrite a published npm version.
Fix the release inputs, choose a new semantic version, and rerun the complete
cross-repository sequence.

## Gates that require external infrastructure

Repository CI cannot manufacture registry credentials, published CocoaPods or
Maven coordinates, a released core tag/image, Apple/Google provider
configuration, signing identities, Play distribution, or physical devices.
Those are explicit release or device-conformance gates, not reasons to weaken
source verification. See [native installation](native-installation.md) and
[conformance](conformance.md) for the device evidence required after the source
and published-consumer builds are green.
