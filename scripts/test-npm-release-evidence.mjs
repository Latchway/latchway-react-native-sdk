import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

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
import { validateGPGStatus } from "./gpg-status.mjs";
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
  const draft = workflow.indexOf("Create or resume the fail-closed GitHub draft");
  const cliCapability = workflow.indexOf("gh release verify --help");
  const npmPublish = workflow.indexOf("node scripts/publish-or-verify.mjs");
  const registryVerify = workflow.indexOf("node scripts/verify-published.mjs");
  const evidenceAttestation = workflow.indexOf("Attest exact retained registry and adoption evidence");
  const githubPublish = workflow.indexOf("Attach every fixed asset, publish once, and require immutability");
  assert.ok(cliCapability >= 0 && cliCapability < draft && draft < npmPublish);
  assert.ok(npmPublish < registryVerify && registryVerify < evidenceAttestation && evidenceAttestation < githubPublish);
  for (const asset of [
    "npm-registry-version.json",
    "npm-registry-view.json",
    "npm-attestations.json",
    "npm-audit-signatures.json",
    "npm-registry-evidence-manifest.json",
    "steps.registry_evidence.outputs.adoption_asset",
  ]) assert.ok(workflow.slice(githubPublish).includes(asset), `final reconciliation omits ${asset}`);
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|--clobber/u);
  assert.equal((workflow.match(/\$\{\{\s*secrets\.LATCHWAY_GITHUB_RELEASE_ADMIN_TOKEN\s*\}\}/gu) ?? []).length, 2);
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
  assert.match(workflow, /--expected-commit "\$RELEASE_COMMIT"/u);
  assert.doesNotMatch(workflow, /--source-commit/u);
});

test("published dependency gate requires immutable attested assets and live registry bytes", async () => {
  const source = await readFile(new URL("verify-published-dependencies.mjs", import.meta.url), "utf8");
  const androidContract = await readFile(new URL("android-release-evidence.mjs", import.meta.url), "utf8");
  const verifierSource = `${source}\n${androidContract}`;
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

  const workflow = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  assert.match(workflow, /attestations: read/u);
  assert.match(workflow, /GH_TOKEN: \$\{\{ github\.token \}\}/u);
  assert.match(workflow, /published-dependency-evidence\.json/u);
  assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN/u);
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
    primaryFingerprint: primary,
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
