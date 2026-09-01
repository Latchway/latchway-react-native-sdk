# Releasing the React Native SDK

The release is driven by `release-compatibility.json`; it is not assembled from
whatever happens to be at the tips of sibling repositories. CI reads the
locked commits from that file, checks out those exact objects, verifies every
SDK contract lock, rebuilds and checks the full core contract bundle, and then
builds real React Native 0.82 hosts.

## Cross-repository order

1. Finalize and release the core contract bundle and server image. Record the
   immutable core tag, commit, bundle hash, image digest, and compatibility
   range.
2. Synchronize the JavaScript, iOS, Android, and React Native `contract.lock`
   files, public compatibility constants, and vendored fixtures to the same
   final contract. Update each exact source commit in
   `release-compatibility.json` only after its repository is green.
3. Publish the exact four-package JavaScript set (`@latchway/client`,
   `@latchway/openai`, `@latchway/vercel-ai`, and `@latchway/langchain`), the
   iOS pod/tag, and all Android Maven artifacts/tag. Their immutable GitHub
   releases, per-asset attestations, public registry bytes, registry signatures,
   and source commits must all match the lock; git tag or package metadata alone
   is not sufficient.
4. Run the manual `Published dependency consumer` workflow. It removes all
   local path/repository overrides and builds the clean npm consumer plus the
   official iOS and Android example hosts.
5. Set `core_release` in `contract.lock`, update every public SDK version and
   the changelog. The accepted core promotion then sends the
   `latchway_release_promoted` `repository_dispatch` payload for the exact
   reviewed commit. `.github/workflows/release.yml` verifies the attested
   promotion report before it creates, or verifies, the annotated
   `v<package-version>` tag. Operators must not create or push that tag manually.

`pnpm release:preflight -- v<package-version>` intentionally fails for a dirty
tree, lightweight/wrong-commit tag, mismatched version, unpublished core lock,
missing changelog section, local dependency, or forbidden generated/secret
file.

## npm and GitHub configuration

Configure `@latchway/react-native` on npm with this GitHub repository and the
exact `release.yml` workflow as a trusted publisher. The workflow runs on a
GitHub-hosted runner with `id-token: write`, npm 11.6.2, and provenance-enabled
publication. A separate source-free `permissions: {}` job downloads the exact
npm 11.6.2 registry tarball with lifecycle scripts disabled and authenticates a
one-file artifact closure: 2,663,834 bytes, 2,133 regular entries, 11,785,613
unpacked bytes, SHA-256
`585f95094ee5cb2788ee11d90f2a518a7c9ef6e083fa141d0b63ca3383675a20`, and
integrity
`sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==`.
The OIDC job rechecks that predeclared name-only closure, byte size, SHA-256,
SHA-512, integrity, member paths and types, and unpacked size before extraction
or execution. It invokes the verified CLI directly and never runs `npm install`,
`npm exec`, or `npx` while holding OIDC or attestation permissions. The protected `npm` environment must also contain a
fine-grained `LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN` with read-only repository
Administration permission. Before any draft or asset mutation, the workflow
requires GitHub's exact immutable-release settings response to report
`enabled: true` and a Boolean `enforced_by_owner`, and requires the installed
GitHub CLI to support JSON release and asset attestation verification. Bootstrap the npm package
record through a separately reviewed one-time procedure if the registry requires
it; the release workflow never accepts `NPM_TOKEN` or `NODE_AUTH_TOKEN`.

When any locked sibling repository is private, configure the repository or
organization Actions secret `LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN`. It must
be a fine-grained token selected only for `Latchway/latchway`,
`Latchway/latchway-js`, `Latchway/latchway-ios-sdk`, and
`Latchway/latchway-android`, with repository Contents read permission and no
write permission. Cross-repository checkout steps use it only for the pinned
sibling fetch and set `persist-credentials: false`; the promotion job also uses
it for the exact core release-asset download and attestation verification. If
the sibling repositories remain private, the published-dependency gate uses the
same read-only token to verify their immutable releases and assets. The manual
`Published dependency consumer` workflow confines that token to a protected
`authenticate-inputs` job that never checks out or executes the React Native
candidate. Fixed commands fetch and strictly validate the compatibility and
contract locks at the exact workflow commit, authenticate the locked JavaScript
source into a Git bundle, capture the immutable tag, release, asset, and build
attestation evidence, and seal everything into one size-bounded, SHA-256-bound
artifact. The Android and iOS jobs compare the sealed locks byte for byte with
their exact candidate checkout, validate the complete artifact manifest, clone
only the authenticated bundle, and use
`LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS` for offline GitHub evidence. They
receive no sibling token, `GH_TOKEN`, `GITHUB_TOKEN`, `NODE_AUTH_TOKEN`, or OIDC
request URL. The main-branch/workflow-dispatch `Locked source conformance`
workflow applies the same split to source builds. Its protected
`authenticate-inputs` job has no candidate checkout: a fixed GitHub API request
reads only `release-compatibility.json` and `contract.lock` at the exact workflow
commit, then a separately scoped step exposes the sibling token only while Git
fetches the four locked commits and creates their bundles. A credential-free
step seals those bundles and locks as an exact six-payload-file, size-bounded,
SHA-256-bound closure plus its manifest. Fresh JavaScript, Android, and iOS jobs
have no protected environment, secret, registry authentication, or OIDC
permission. Before any
candidate-owned `ci-lock-output.mjs` or build tooling runs, each job asserts that
the sibling token, `GH_TOKEN`, `GITHUB_TOKEN`, `NODE_AUTH_TOKEN`, and OIDC request
variables are empty, compares both locks byte for byte with the exact candidate,
validates the complete archive manifest, and imports all four bundles offline.
Pull-request `ci.yml` contains no secret reference. Configure and protect the
`private-sibling-read` environment before enabling these evidence jobs. The
locked-source handoff deliberately requires the fine-grained sibling token;
other protected reads may continue to fall back to the job token when every
sibling repository is public.

After the protected preflight, the workflow resolves the remote annotated tag
object to the promoted commit immediately before it creates or resumes the
fixed-asset GitHub draft before npm publication, but does not publish
that release until every asset is attached. A separate no-checkout, no-OIDC job
rechecks the immutable-release setting with the protected administration
credential. The final OIDC job receives no administration credential and
validates the exact local asset closure before attesting it. It checks an existing npm version by
exact tarball bytes and SHA-512 for safe retry, then retains the bounded raw npm
registry, `npm view --json --include-attestations`, Sigstore, and
`npm audit signatures` outputs as hash-bound release assets. Existing GitHub
assets are downloaded and compared byte for byte, only missing draft assets are
attached, and a mismatched or incomplete final release stops the run. After
finalization, it resolves the remote tag again. Bounded retries of
`gh release verify` and `gh release verify-asset` are parsed with duplicate-key
rejection: the signed source commit and exact asset-name/SHA-256 closure must
match every fixed or adoption-history asset.

If an npm publish succeeds but a later step fails, a rerun may adopt that
immutable version only after rechecking its exact bytes, signatures, and source
provenance. The attested adoption record binds the original provenance-producing
run and attempt, the current successful run and attempt, and the exact retained
registry evidence manifest. The published-dependency gate applies the same
standard to the locked JavaScript, iOS, and Android releases. React Native links
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
therefore be rerun safely.

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
