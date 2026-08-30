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
3. Publish the exact JavaScript package, the iOS pod/tag, and all Android Maven
   artifacts/tag. Their immutable GitHub releases, per-asset attestations,
   public registry bytes, registry signatures, and source commits must all match
   the lock; git tag or package metadata alone is not sufficient.
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
GitHub-hosted runner with `id-token: write`, npm 11.6.2, and
`npm publish --provenance`. The protected `npm` environment must also contain a
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
same read-only token to verify their immutable releases and assets. If every
sibling is public, the secret may be omitted and the job token is used.

After the protected preflight, the workflow resolves the remote annotated tag
object to the promoted commit immediately before it creates or resumes the
fixed-asset GitHub draft before npm publication, but does not publish
that release until every asset is attached. It checks an existing npm version by
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
standard to the locked JavaScript, iOS, and Android releases: it verifies every
strictly parsed automatic release/asset attestation, annotated source tag,
source-bound workflow attestation, and live
registry byte; it also reruns npm signature audit and independently verifies
Maven signatures against the attested public key with a fail-closed GnuPG status
allowlist that rejects revoked, expired, unknown, or weak signatures. An interrupted exact promotion
can therefore be rerun safely.

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
