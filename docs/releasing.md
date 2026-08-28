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
   artifacts/tag. Their package versions and tag commits must match the lock.
4. Run the manual `Published dependency consumer` workflow. It removes all
   local path/repository overrides and builds the clean npm consumer plus the
   official iOS and Android example hosts.
5. Set `core_release` in `contract.lock`, update every public SDK version and
   the changelog, and create a signed, annotated `v<package-version>` tag at the
   reviewed commit. Pushing that tag starts `.github/workflows/release.yml`.

`pnpm release:preflight -- v<package-version>` intentionally fails for a dirty
tree, lightweight/wrong-commit tag, mismatched version, unpublished core lock,
missing changelog section, local dependency, or forbidden generated/secret
file.

## npm and GitHub configuration

Configure `@latchway/react-native` on npm with this GitHub repository and the
exact `release.yml` workflow as a trusted publisher. The workflow runs on a
GitHub-hosted runner with `id-token: write`, npm 11.6.2, and
`npm publish --provenance`. If npm requires a token to bootstrap the package's
first-ever publication, add a narrowly scoped short-lived `NPM_TOKEN` secret,
publish once through the same reviewed workflow, configure trusted publishing,
and remove the secret.

The workflow first creates a draft GitHub release. It publishes the already
verified archive, checks an existing npm version by SHA-512 for safe retry, then
attaches the `.tgz` and SHA-256 file and finalizes the release. A failed npm
publication leaves the GitHub release as a recoverable draft.

Do not manually retag a failed release or overwrite a published npm version.
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
