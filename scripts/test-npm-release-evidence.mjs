import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVENANCE_TYPE,
  assertSafeRetainedOutput,
  buildAdoptionRecord,
  buildRegistryManifest,
  parseProvenanceOrigin,
  requireCurrentPublicationOrigin,
  sha256,
  verifyProvenanceStatement,
} from "./npm-release-evidence.mjs";
import {
  APPROVED_PUBLIC_KEY_ALGORITHMS,
  GPG_STATUS_RECORD_KEYS,
  REQUIRED_HASH_ALGORITHM,
  validateGPGStatus,
  validateRetainedGPGStatus,
} from "./gpg-status.mjs";
import {
  RELEASE_PREDICATE_TYPE,
  STATEMENT_TYPE,
  validateReleaseAttestation,
} from "./release-attestation.mjs";
import { requireAnnotatedTagRefs } from "./release-tag.mjs";

const repository = "https://github.com/Latchway/latchway-react-native-sdk";
const commit = "a".repeat(40);
const sha512 = "b".repeat(128);

test("provenance from a prior failed run can be adopted by a later attempt", () => {
  const statement = provenanceStatement(`${repository}/actions/runs/41/attempts/1`);
  const origin = verifyProvenanceStatement(statement, {
    packageName: "@latchway/react-native",
    packageVersion: "1.0.0",
    sha512,
    expectedRepositoryURL: repository,
    expectedCommit: commit,
    expectedEvent: "repository_dispatch",
  });
  assert.deepEqual(origin, {
    invocation_id: `${repository}/actions/runs/41/attempts/1`,
    run_id: 41,
    run_attempt: 1,
  });
  requireCurrentPublicationOrigin(origin, {
    publishPerformed: false,
    currentRunID: 99,
    currentRunAttempt: 2,
  });
  const manifest = Buffer.from("registry evidence\n");
  const adoption = buildAdoptionRecord({
    packageName: "@latchway/react-native",
    packageVersion: "1.0.0",
    releaseTag: "v1.0.0",
    repositoryURL: repository,
    sourceCommit: commit,
    provenanceOrigin: origin,
    tarball: {
      name: "client.tgz",
      bytes: 123,
      sha256: "d".repeat(64),
      sha512: "e".repeat(128),
      integrity: `sha512-${Buffer.from("e".repeat(128), "hex").toString("base64")}`,
    },
    manifestSHA256: sha256(manifest),
    currentRunID: 99,
    currentRunAttempt: 2,
    publishPerformed: false,
  });
  assert.equal(adoption.provenance.run_id, 41);
  assert.equal(adoption.adoption.run_id, 99);
  assert.equal(adoption.adoption.mode, "adopted_existing");
  assert.equal(adoption.tarball.sha256, "d".repeat(64));
});

test("fresh publication cannot adopt provenance from another run", () => {
  assert.throws(() => requireCurrentPublicationOrigin(
    { run_id: 41, run_attempt: 1 },
    { publishPerformed: true, currentRunID: 99, currentRunAttempt: 2 },
  ), /exact workflow attempt/u);
});

test("provenance rejects repository, commit, and workflow substitutions", () => {
  const cases = [
    provenanceStatement("https://github.com/attacker/repo/actions/runs/41/attempts/1"),
    provenanceStatement(`${repository}/actions/runs/41/attempts/1`, { commit: "f".repeat(40) }),
    provenanceStatement(`${repository}/actions/runs/41/attempts/1`, { workflow: "evil.yml" }),
  ];
  for (const statement of cases) {
    assert.throws(() => verifyProvenanceStatement(statement, {
      packageName: "@latchway/react-native",
      packageVersion: "1.0.0",
      sha512,
      expectedRepositoryURL: repository,
      expectedCommit: commit,
      expectedEvent: "repository_dispatch",
    }), /provenance/u);
  }
});

test("retained output is bounded JSON and rejects credentials", () => {
  assert.deepEqual(assertSafeRetainedOutput(Buffer.from('{"ok":true}\n'), "test", 64), { ok: true });
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from('{"token":"npm_abcdefghijklmnopqrstuvwxyz123456"}'), "test", 128),
    /credential-like/u,
  );
  assert.throws(() => assertSafeRetainedOutput(Buffer.alloc(129, 1), "test", 128), /size/u);
});

test("registry manifest hashes exact retained output bytes", () => {
  const first = Buffer.from('{"one":1}\n');
  const second = Buffer.from('{"two":2}\n');
  const manifest = buildRegistryManifest({
    packageName: "@latchway/react-native",
    packageVersion: "1.0.0",
    tarball: { name: "client.tgz", sha256: "c".repeat(64) },
    evidence: [{ name: "two.json", bytes: second }, { name: "one.json", bytes: first }],
  });
  assert.deepEqual(manifest.evidence.map((entry) => entry.name), ["one.json", "two.json"]);
  assert.equal(manifest.evidence[0].sha256, sha256(first));
});

test("provenance invocation parser rejects ambiguous or unbounded paths", () => {
  for (const value of [
    `${repository}/actions/runs/0/attempts/1`,
    `${repository}/actions/runs/1/attempts/0`,
    `${repository}/actions/runs/1/attempts/1/extra`,
    `${repository}@attacker/actions/runs/1/attempts/1`,
  ]) assert.throws(() => parseProvenanceOrigin(value, repository), /provenance/u);
});

test("release workflow drafts before npm and publishes GitHub only after evidence attestation", async () => {
  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const draft = workflow.indexOf("Preflight immutable release and create draft with fixed API calls");
  const cliCapability = workflow.indexOf("gh release verify --help");
  const npmPublish = workflow.indexOf('"$LATCHWAY_NPM_CLI" publish "$archive"');
  const registryVerify = workflow.indexOf("node scripts/verify-published.mjs");
  const assetClosure = workflow.indexOf(
    "Validate exact React Native asset closure before OIDC attestation",
  );
  const evidenceAttestation = workflow.indexOf(
    "Attest exact retained registry and release evidence without candidate checkout",
  );
  const githubPublish = workflow.indexOf(
    "Reconcile, publish, and verify immutable release with fixed API calls",
  );
  assert.ok(cliCapability >= 0 && cliCapability < draft && draft < npmPublish);
  assert.ok(npmPublish < registryVerify && registryVerify < assetClosure
    && assetClosure < evidenceAttestation && evidenceAttestation < githubPublish);
  for (const asset of [
    "npm-registry-version.json",
    "npm-registry-view.json",
    "npm-attestations.json",
    "npm-audit-signatures.json",
    "npm-registry-evidence-manifest.json",
    "npm-release-adoption-",
  ]) assert.ok(workflow.slice(githubPublish).includes(asset), `final reconciliation omits ${asset}`);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--clobber/u);
  assert.match(workflow,
    /NPM_CLI_SHA512: ee22b335fcbc95662cdf3ab8a053daf045d9cf9c6df6040d28965abb707512b2c16fa6c5eec049d34c74f78f390cebd14f697919eadb97756564d4f9eccc4954/u);
  assert.match(workflow,
    /NPM_CLI_INTEGRITY: sha512-7iKzNfy8lWYs3zq4oFPa8EXZz5xt9gQNKJZau3B1ErLBb6bF7sBJ00x09485DOvRT2l5Gerbl3VlZNT57MxJVA==/u);
  const trustedNpmJob = workflow.slice(
    workflow.indexOf("\n  trusted-npm-cli:\n"),
    workflow.indexOf("\n  github-draft:\n"),
  );
  const npmPublishJob = workflow.slice(
    workflow.indexOf("\n  npm-publish:\n"),
    workflow.indexOf("\n  publish:\n"),
  );
  const registryEvidenceJob = workflow.slice(
    workflow.indexOf("\n  publish:\n"),
    workflow.indexOf("\n  github-release-policy:\n"),
  );
  assert.match(trustedNpmJob, /permissions: \{\}/u);
  assert.match(trustedNpmJob, /NPM_CONFIG_IGNORE_SCRIPTS: "true"/u);
  assert.match(trustedNpmJob, /sha512sum --check --strict/u);
  assert.doesNotMatch(trustedNpmJob,
    /actions\/checkout|secrets\.|github\.token|id-token:|attestations:|npm install|npm exec/u);
  assert.doesNotMatch(trustedNpmJob, /(?:^|\n)\s*npx\s/u);
  assert.match(npmPublishJob,
    /needs: \[promote, verify, android, ios, trusted-npm-cli, github-draft\]/u);
  assert.match(npmPublishJob, /Verify exact npm CLI closure before extraction or execution/u);
  assert.doesNotMatch(npmPublishJob, /npm install|npm exec/u);
  assert.doesNotMatch(npmPublishJob, /(?:^|\n)\s*npx\s/u);
  assert.ok(
    npmPublishJob.indexOf("sha512sum --check --strict")
      < npmPublishJob.indexOf('tar --extract --gzip --file "$archive"')
      && npmPublishJob.indexOf('tar --extract --gzip --file "$archive"')
      < npmPublishJob.indexOf('test "$("$cli" --version)"'),
  );
  assert.match(registryEvidenceJob,
    /needs: \[promote, verify, android, ios, trusted-npm-cli, github-draft, npm-publish\]/u);
  assert.match(registryEvidenceJob, /Verify exact npm CLI closure before registry evidence/u);
  assert.match(registryEvidenceJob, /LATCHWAY_NPM_CLI/u);
  assert.doesNotMatch(registryEvidenceJob, /npm install --global|npm exec/u);
  const registryVerifier = await readFile(new URL("verify-published.mjs", import.meta.url), "utf8");
  assert.match(registryVerifier, /LATCHWAY_NPM_CLI/u);
  assert.match(registryVerifier, /spawnSync\(process\.execPath, \[trustedNpmCLI, \.\.\.arguments_\]/u);
  assert.equal((workflow.match(/\$\{\{\s*secrets\.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN\s*\}\}/gu) ?? []).length, 2);
  const policyJob = workflow.slice(
    workflow.indexOf("\n  github-release-policy:\n"),
    workflow.indexOf("\n  github-release:\n"),
  );
  const releaseJob = workflow.slice(workflow.indexOf("\n  github-release:\n"));
  assert.match(policyJob, /LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN/u);
  assert.doesNotMatch(policyJob, /id-token: write|attestations: write|actions\/checkout|scripts\//u);
  assert.doesNotMatch(releaseJob, /LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN/u);
  assert.match(releaseJob, /cmp --silent "\$RUNNER_TEMP\/expected-assets\.txt"/u);
  const reconciler = await readFile(new URL("reconcile-github-release.py", import.meta.url), "utf8");
  for (const control of [
    "repos/{repository}/immutable-releases",
    'set(value) == {"enabled", "enforced_by_owner"}',
    '"gh", "release", "verify"',
    '"gh", "release", "verify-asset"',
    "validate_remote_tag",
    "_strict_json_loads",
    "expected_commit",
    "os.environ.pop",
    "_run_json_with_retries",
  ]) assert.ok(reconciler.includes(control), `release reconciler omits ${control}`);
  assert.match(workflow.slice(githubPublish), /\.object\.sha == \$commit/u);
});

test("private sibling reads stay outside pull-request CI and use the bounded token", async () => {
  const token = "token: ${{ secrets.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN || github.token }}";
  const pullRequestWorkflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.doesNotMatch(pullRequestWorkflow, /secrets\.|repository:\s+Latchway\//u);
  const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const siblingCheckouts = releaseWorkflow.match(/^\s+repository:\s+Latchway\//gmu)?.length ?? 0;
  assert.ok(siblingCheckouts > 0, "release.yml no longer exercises a sibling checkout");
  for (const match of releaseWorkflow.matchAll(/^\s+repository:\s+Latchway\//gmu)) {
    const nextStep = releaseWorkflow.indexOf("\n      - ", match.index + 1);
    assert.ok(releaseWorkflow.slice(match.index, nextStep === -1 ? undefined : nextStep).includes(token),
      "release.yml has a sibling checkout without the bounded token fallback");
  }

  const lockedSources = await readFile(new URL("../.github/workflows/locked-sources.yml", import.meta.url), "utf8");
  assert.doesNotMatch(lockedSources, /^\s+repository:\s+Latchway\//mu);
  assert.equal((lockedSources.match(
    /\$\{\{ secrets\.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN \}\}/gu,
  ) ?? []).length, 1);
  assert.equal((lockedSources.match(/environment: private-sibling-read/gu) ?? []).length, 1);
  for (const marker of [
    'bundle_locked_repository Latchway/latchway-js "$JAVASCRIPT_COMMIT" latchway-js',
    'bundle_locked_repository Latchway/latchway-android "$ANDROID_COMMIT" latchway-android',
    'bundle_locked_repository Latchway/latchway-ios-sdk "$IOS_COMMIT" latchway-ios-sdk',
    'bundle_locked_repository Latchway/latchway "$CORE_COMMIT" latchway',
  ]) assert.ok(lockedSources.includes(marker), `locked source handoff omits ${marker}`);
  const documentation = await readFile(new URL("../docs/releasing.md", import.meta.url), "utf8");
  const overviewDocumentation = await Promise.all([
    readFile(new URL("../README.md", import.meta.url), "utf8"),
    readFile(new URL("../docs/native-installation.md", import.meta.url), "utf8"),
  ]);
  assert.match(documentation, /`LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN`/u);
  assert.match(documentation, /Contents read permission and no\s+write permission/u);
  assert.match(documentation, /repository_dispatch/u);
  assert.match(documentation, /tag manually/iu);
  assert.doesNotMatch(documentation, /\n(?:git tag|git push)\s/u);
  assert.doesNotMatch(
    `${documentation}\n${overviewDocumentation.join("\n")}`,
    /tag-triggered release workflow|the tag workflow/iu,
  );
});

test("published native consumers receive only a sealed credential-free input artifact", async () => {
  const workflow = await readFile(new URL("../.github/workflows/native-consumer.yml", import.meta.url), "utf8");
  const authenticated = workflow.slice(
    workflow.indexOf("\n  authenticate-inputs:\n"), workflow.indexOf("\n  android:\n"),
  );
  const consumers = workflow.slice(workflow.indexOf("\n  android:\n"));

  assert.doesNotMatch(authenticated, /actions\/checkout|working-directory:|node scripts\//u);
  assert.match(authenticated, /environment: private-sibling-read/u);
  assert.match(authenticated,
    /GH_TOKEN: \$\{\{ secrets\.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN \|\| github\.token \}\}/u);
  assert.match(authenticated,
    /repos\/\$GITHUB_REPOSITORY\/contents\/\$path\?ref=\$GITHUB_SHA/u);
  assert.match(authenticated, /jq --exit-status/u);
  assert.match(authenticated, /release-compatibility\.json/u);
  assert.match(authenticated, /\.wire_protocol == 2/u);
  assert.match(authenticated, /test "\$WIRE_PROTOCOL" = 2/u);
  assert.match(authenticated,
    /keys == \["attestation-binding-v1\.json", "component-attestation-binding-v2\.json", "dpop-v1\.json", "installation-family-v2\.json", "protocol-version\.json"\]/u);
  assert.match(authenticated, /git init --bare/u);
  assert.match(authenticated, /locked-latchway-js\.bundle/u);
  assert.match(authenticated, /authenticate_tag\(\)/u);
  assert.match(authenticated, /authenticate_release\(\)/u);
  assert.match(authenticated, /gh release verify-asset/u);
  assert.match(authenticated, /gh attestation verify/u);
  assert.match(authenticated, /MANIFEST\.sha256/u);
  assert.match(authenticated, /native-consumer-inputs\.tar/u);
  assert.equal(authenticated.match(/actions\/upload-artifact@/gu)?.length ?? 0, 1);

  assert.doesNotMatch(consumers,
    /environment: private-sibling-read|secrets\.|repository:\s+Latchway\/|GH_TOKEN:\s*\$\{\{/u);
  assert.equal(consumers.match(/actions\/download-artifact@/gu)?.length ?? 0, 2);
  assert.equal(consumers.match(/needs: authenticate-inputs/gu)?.length ?? 0, 2);
  assert.equal(consumers.match(/persist-credentials: false/gu)?.length ?? 0, 2);
  assert.equal(consumers.match(/LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS/gu)?.length ?? 0, 4);
  assert.equal(consumers.match(/ACTIONS_ID_TOKEN_REQUEST_URL/gu)?.length ?? 0, 13);
  assert.match(consumers, /cmp -s "\$root\/release-compatibility\.json"/u);
  assert.match(consumers, /git clone --no-local "\$root\/locked-latchway-js\.bundle"/u);
  assert.doesNotMatch(consumers, /registry-url:/u);
});

test("raw GitHub dependency readers use only authenticated offline captures in consumer jobs", async () => {
  const command = "node scripts/verify-published-dependencies.mjs --all";
  const consumerWorkflow = await readFile(new URL("../.github/workflows/native-consumer.yml", import.meta.url), "utf8");
  assert.equal(consumerWorkflow.split(command).length - 1, 2);
  const authenticatedConsumerInputs = consumerWorkflow.slice(
    consumerWorkflow.indexOf("\n  authenticate-inputs:\n"),
    consumerWorkflow.indexOf("\n  android:\n"),
  );
  const credentialFreeConsumers = consumerWorkflow.slice(consumerWorkflow.indexOf("\n  android:\n"));
  assert.match(authenticatedConsumerInputs,
    /GH_TOKEN: \$\{\{ secrets\.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN \|\| github\.token \}\}/u);
  assert.doesNotMatch(credentialFreeConsumers, /secrets\.|GH_TOKEN:\s*\$\{\{/u);
  assert.match(credentialFreeConsumers, /LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS/u);

  const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.equal(releaseWorkflow.split(command).length - 1, 1);
  const releaseVerifier = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  verify:\n"), releaseWorkflow.indexOf("\n  android:\n"),
  );
  assert.doesNotMatch(releaseVerifier, /GH_TOKEN:\s*\$\{\{/u);
  assert.match(releaseVerifier, /LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS/u);

  const source = await readFile(new URL("verify-published-dependencies.mjs", import.meta.url), "utf8");
  assert.equal(source.match(/execFileSync\("gh"/gu)?.length ?? 0, 1,
    "all GitHub CLI calls must pass through the authenticated wrapper");
  assert.equal((source.match(/runGitHubCLI\(/gu)?.length ?? 0) - 1, 4,
    "each GitHub CLI consumer must use the authenticated wrapper");
  assert.match(source,
    /execFileSync\("gh", arguments_, \{ \.\.\.options, env: githubReadEnvironment\(\) \}\)/u);
  assert.equal(source.match(/execFileSync\("git"/gu)?.length ?? 0, 1,
    "all raw Git tag reads must remain visibly authenticated");
  const gitRead = source.slice(source.indexOf('execFileSync("git"'), source.indexOf("}).trim()", source.indexOf('execFileSync("git"')));
  assert.match(gitRead, /\["-c", "credential\.helper=", "ls-remote"/u);
  assert.match(gitRead, /env: authenticatedGitEnvironment\(\)/u);
  assert.match(source, /GIT_ASKPASS: gitAskpass/u);
  assert.match(source, /GIT_TERMINAL_PROMPT: "0"/u);
  assert.match(source, /\["GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN"/u,
    "the sibling read token must not be inherited by npm subprocesses");
  assert.doesNotMatch(source, /https:\/\/[^\s"'`]*x-access-token/iu);
});

test("published dependency gate requires immutable attested assets and live registry bytes", async () => {
  const source = await readFile(new URL("verify-published-dependencies.mjs", import.meta.url), "utf8");
  const releaseWorkflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const androidContract = await readFile(new URL("android-release-evidence.mjs", import.meta.url), "utf8");
  const verifierSource = `${source}\n${androidContract}`;
  const dependencyGate = releaseWorkflow.slice(
    releaseWorkflow.indexOf("Authenticate published sibling inputs without candidate checkout"),
  );
  assert.match(
    dependencyGate,
    /GH_TOKEN: \$\{\{ secrets\.LATCHWAY_SIBLING_REPOSITORIES_READ_TOKEN \|\| github\.token \}\}/u,
  );
  const credentialFreeVerification = releaseWorkflow.slice(
    releaseWorkflow.indexOf("\n  verify:\n"),
    releaseWorkflow.indexOf("\n  android:\n"),
  );
  assert.doesNotMatch(credentialFreeVerification, /secrets\.|GH_TOKEN:\s*\$\{\{/u);
  assert.match(credentialFreeVerification, /LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS/u);
  assert.match(source, /GitHub CLI access is forbidden while using authenticated offline dependency inputs/u);
  for (const control of [
    "release.immutable !== true",
    '"release", "verify"',
    '"release", "verify-asset"',
    "requireExactReleaseAssets",
    "--source-digest",
    "npm-registry-evidence-manifest.json",
    "cocoapods-release-evidence.json",
    "maven-central-release-evidence.json",
    "maven-central-deployment-status.json",
    '["audit", "signatures", "--json"',
    "Live JavaScript npm bytes differ",
    "Live CocoaPods metadata differs",
    "Maven Central bytes differ",
    "reviewed_repository_manifest_sha256",
    "verifyDetachedSignature",
    "immutable_attestation",
    "validateReleaseAttestation",
    "validateGPGStatus",
    "validateRetainedGPGStatus",
    "requireAnnotatedTagRefs",
  ]) assert.ok(verifierSource.includes(control), `dependency verifier omits ${control}`);
  assert.doesNotMatch(source, /gitHead/u);
  for (const control of [
    "central-portal.zip",
    "github-release-tag-binding.json",
    "reviewed_portal_bundle_sha256",
    "reviewed_portal_bundle_file_count",
    'publishing_type !== "user_managed"',
    'authorization !== "recoverable_exact_upload"',
    "proof.schema_version !== ANDROID_RELEASE_SCHEMAS.proof",
    'intent: "latchway.maven-central-upload-intent.v2"',
    'record: "latchway.maven-central-deployment.v2"',
    'status: "latchway.maven-central-deployment-status.v2"',
    'record_kind === "public_registry_adoption"',
  ]) assert.ok(androidContract.includes(control), `Android dependency contract omits ${control}`);
  assert.doesNotMatch(
    androidContract,
    /single_upload_only|publishing_type\s*!==\s*"automatic"|proof\.schema_version\s*!==\s*1|maven-central-(?:upload-intent|deployment(?:-status)?)\.v1/u,
  );

  assert.match(releaseWorkflow, /attestations: read/u);
  assert.match(releaseWorkflow, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(releaseWorkflow, /published-dependency-evidence\.json/u);
  assert.doesNotMatch(releaseWorkflow, /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN/u);
});

test("release attestation parser binds exact source and asset closure", () => {
  const assets = [
    { name: "client.tgz", sha256: "d".repeat(64) },
    { name: "SHA256SUMS", sha256: "e".repeat(64) },
  ];
  const valid = releaseAttestationDocument(assets);
  assert.deepEqual(validateReleaseAttestation(Buffer.from(JSON.stringify(valid)), {
    repository: "Latchway/latchway-react-native-sdk",
    tag: "v1.0.0",
    expectedCommit: commit,
    assets,
  }), {
    bytes: Buffer.byteLength(JSON.stringify(valid)),
    sha256: sha256(Buffer.from(JSON.stringify(valid))),
    source_commit: commit,
    asset_count: 2,
  });

  const wrongCommit = releaseAttestationDocument(assets, { commit: "f".repeat(40) });
  assert.throws(() => validateReleaseAttestation(Buffer.from(JSON.stringify(wrongCommit)), {
    repository: "Latchway/latchway-react-native-sdk", tag: "v1.0.0", expectedCommit: commit, assets,
  }), /locked source commit/u);
  const missing = releaseAttestationDocument(assets.slice(0, 1));
  assert.throws(() => validateReleaseAttestation(Buffer.from(JSON.stringify(missing)), {
    repository: "Latchway/latchway-react-native-sdk", tag: "v1.0.0", expectedCommit: commit, assets,
  }), /exact release asset set/u);
  const wrongBytes = releaseAttestationDocument([
    assets[0], { name: "SHA256SUMS", sha256: "a".repeat(64) },
  ]);
  assert.throws(() => validateReleaseAttestation(Buffer.from(JSON.stringify(wrongBytes)), {
    repository: "Latchway/latchway-react-native-sdk", tag: "v1.0.0", expectedCommit: commit, assets,
  }), /exact bytes/u);
});

test("release attestation parser rejects duplicate JSON keys and malformed DSSE", () => {
  const assets = [{ name: "client.tgz", sha256: "d".repeat(64) }];
  const expected = {
    repository: "Latchway/latchway-react-native-sdk",
    tag: "v1.0.0",
    expectedCommit: commit,
    assets,
  };
  for (const document of [
    '{"attestation":{},"attestation":{},"verificationResult":{}}',
    '{"attestation":NaN,"verificationResult":{}}',
    '{"attestation":1e9999,"verificationResult":{}}',
    '{"attestation":{},"verification\u0052esult":{},"verificationResult":{}}',
  ]) assert.throws(() => validateReleaseAttestation(Buffer.from(document), expected), /JSON|schema/u);

  const missingSignature = releaseAttestationDocument(assets);
  delete missingSignature.attestation.bundle.dsseEnvelope.signatures;
  assert.throws(() => validateReleaseAttestation(
    Buffer.from(JSON.stringify(missingSignature)), expected,
  ), /DSSE envelope/u);

  const duplicateStatement = releaseAttestationDocument(assets);
  const envelope = duplicateStatement.attestation.bundle.dsseEnvelope;
  const statement = Buffer.from(envelope.payload, "base64").toString("utf8")
    .replace('"_type":', '"_type":"duplicate","_type":', 1);
  envelope.payload = Buffer.from(statement).toString("base64");
  assert.throws(() => validateReleaseAttestation(
    Buffer.from(JSON.stringify(duplicateStatement)), expected,
  ), /duplicate JSON key/u);
});

test("GnuPG parser accepts a signing subkey and rejects revoked, expired, unknown, or weak status", () => {
  const primary = "A".repeat(40);
  const subkey = "B".repeat(40);
  const valid = validGPGStatus(subkey, primary);
  assert.deepEqual(validateGPGStatus(valid, primary), {
    hashAlgorithm: "10",
    primaryFingerprint: primary,
    publicKeyAlgorithm: "1",
    signingFingerprint: subkey,
  });
  for (const tag of [
    "REVKEYSIG", "EXPKEYSIG", "EXPSIG", "KEYREVOKED", "KEYEXPIRED", "SIGEXPIRED", "BADSIG", "ERRSIG",
  ]) {
    assert.throws(() => validateGPGStatus([...valid, `[GNUPG:] ${tag} rejected`], primary), RegExp(tag, "u"));
  }
  assert.throws(
    () => validateGPGStatus([...valid, "[GNUPG:] FUTURE_SUCCESS maybe"], primary),
    /unreviewed status/u,
  );
  assert.throws(() => validateGPGStatus([...valid, valid[4]], primary), /exactly 1 VALIDSIG/u);
  assert.throws(() => validateGPGStatus(valid.filter((line) => !line.includes(" GOODSIG ")), primary), /GOODSIG/u);
  assert.throws(() => validateGPGStatus([...valid, "gpg: forged human output"], primary), /non-status/u);
  for (const replacement of [
    " 4 0 1 2 00 ",
    " 4 0 17 10 00 ",
    " 4 0 1 10 01 ",
  ]) {
    const weak = valid.map((line) => line.startsWith("[GNUPG:] VALIDSIG ")
      ? line.replace(" 4 0 1 10 00 ", replacement) : line);
    assert.throws(() => validateGPGStatus(weak, primary), /unapproved/u);
  }
});

test("retained GnuPG proof requires Android's exact six fields and algorithm binding", () => {
  const primary = "A".repeat(40);
  const subkey = "B".repeat(40);
  const valid = {
    schema_version: 1,
    primary_fingerprint: primary,
    signing_fingerprint: subkey,
    public_key_algorithm: "1",
    hash_algorithm: "10",
    status_lines: validGPGStatus(subkey, primary),
  };
  assert.deepEqual(GPG_STATUS_RECORD_KEYS, [
    "schema_version",
    "primary_fingerprint",
    "signing_fingerprint",
    "public_key_algorithm",
    "hash_algorithm",
    "status_lines",
  ]);
  assert.deepEqual(APPROVED_PUBLIC_KEY_ALGORITHMS, ["1", "3", "19", "22", "27"]);
  assert.equal(REQUIRED_HASH_ALGORITHM, "10");
  assert.deepEqual(validateRetainedGPGStatus(valid, primary), {
    hashAlgorithm: "10",
    primaryFingerprint: primary,
    publicKeyAlgorithm: "1",
    signingFingerprint: subkey,
  });

  for (const [name, mutate] of [
    ["missing algorithm", (value) => { delete value.public_key_algorithm; }],
    ["extra field", (value) => { value.unreviewed = true; }],
    ["unapproved key algorithm", (value) => { value.public_key_algorithm = "17"; }],
    ["unapproved hash algorithm", (value) => { value.hash_algorithm = "8"; }],
    ["key algorithm substitution", (value) => { value.public_key_algorithm = "3"; }],
  ]) {
    const candidate = structuredClone(valid);
    mutate(candidate);
    assert.throws(() => validateRetainedGPGStatus(candidate, primary), undefined, name);
  }
});

test("checked-out Android producer emits the exact retained GnuPG proof", async (context) => {
  const verifierURL = new URL("../../latchway-android/scripts/verify-gpg-status.py", import.meta.url);
  try {
    await readFile(verifierURL, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("canonical Android checkout is not present in this standalone SDK job");
      return;
    }
    throw error;
  }
  const primary = "A".repeat(40);
  const subkey = "B".repeat(40);
  const directory = await mkdtemp(join(tmpdir(), "latchway-android-gpg-golden-"));
  try {
    const statusPath = join(directory, "status.txt");
    await writeFile(statusPath, `${validGPGStatus(subkey, primary).join("\n")}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    const output = execFileSync("python3", [
      fileURLToPath(verifierURL),
      "--status", statusPath,
      "--expected-primary-fingerprint", primary,
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const produced = JSON.parse(output);
    assert.deepEqual(Object.keys(produced).sort(), [...GPG_STATUS_RECORD_KEYS].sort());
    assert.deepEqual(validateRetainedGPGStatus(produced, primary), {
      hashAlgorithm: "10",
      primaryFingerprint: primary,
      publicKeyAlgorithm: "1",
      signingFingerprint: subkey,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("public dependency tag parser requires one annotated tag object peeled to the locked commit", () => {
  const tagObject = "b".repeat(40);
  const tag = "v1.0.0";
  const valid = `${tagObject}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`;
  assert.deepEqual(requireAnnotatedTagRefs(valid, {
    tag, expectedCommit: commit, label: "JavaScript",
  }), { commit, tagObject });
  for (const invalid of [
    `${commit}\trefs/tags/${tag}\n`,
    `${tagObject}\trefs/tags/${tag}\n${"f".repeat(40)}\trefs/tags/${tag}^{}\n`,
    `${tagObject}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n${commit}\trefs/tags/${tag}^{}\n`,
    `${commit}\trefs/tags/${tag}\n${commit}\trefs/tags/${tag}^{}\n`,
  ]) assert.throws(() => requireAnnotatedTagRefs(invalid, {
    tag, expectedCommit: commit, label: "JavaScript",
  }), /annotated|commit mismatch|ambiguous/u);
});

function releaseAttestationDocument(assets, overrides = {}) {
  const statement = {
    _type: STATEMENT_TYPE,
    subject: [
      {
        uri: "pkg:github/Latchway/latchway-react-native-sdk@v1.0.0",
        digest: { sha1: overrides.commit ?? commit },
      },
      ...assets.map((asset) => ({ name: asset.name, digest: { sha256: asset.sha256 } })),
    ],
    predicateType: RELEASE_PREDICATE_TYPE,
    predicate: { release: { tag: "v1.0.0" } },
  };
  return {
    attestation: { bundle: { dsseEnvelope: {
      payloadType: "application/vnd.in-toto+json",
      payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
      signatures: [{ sig: "verified-by-gh" }],
    } } },
    verificationResult: { verified: true },
  };
}

function validGPGStatus(signingFingerprint, primaryFingerprint) {
  return [
    "[GNUPG:] NEWSIG",
    `[GNUPG:] KEY_CONSIDERED ${primaryFingerprint} 0`,
    `[GNUPG:] GOODSIG ${signingFingerprint.slice(-16)} Latchway Release`,
    "[GNUPG:] SIG_ID c2lnbmF0dXJl 2026-08-29 1787961600",
    `[GNUPG:] VALIDSIG ${signingFingerprint} 2026-08-29 1787961600 0 4 0 1 10 00 ${primaryFingerprint}`,
    "[GNUPG:] TRUST_UNDEFINED 0 pgp",
  ];
}

function provenanceStatement(invocation, overrides = {}) {
  const resolvedCommit = overrides.commit ?? commit;
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: PROVENANCE_TYPE,
    subject: [{
      name: "pkg:npm/%40latchway/react-native@1.0.0",
      digest: { sha512 },
    }],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository,
            path: `.github/workflows/${overrides.workflow ?? "release.yml"}`,
            ref: "refs/heads/main",
          },
        },
        resolvedDependencies: [{
          uri: `git+${repository}@${resolvedCommit}`,
          digest: { gitCommit: resolvedCommit },
        }],
        internalParameters: { github: { event_name: "repository_dispatch" } },
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: invocation },
      },
    },
  };
}
