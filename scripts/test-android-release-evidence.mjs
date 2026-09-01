import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANDROID_RELEASE_SCHEMAS,
  MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES,
  MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES,
  MAXIMUM_MAVEN_RETAINED_EXPANDED_BYTES,
  accumulateMavenArchiveBytes,
  androidReleaseAssetNames,
  expectedMavenPrimaryPaths,
  publicManifestFromFiles,
  validateAndroidReleaseEvidence,
  validateMavenRepositoryPathClosure,
} from "./android-release-evidence.mjs";

test("Android dependency schemas match the canonical v2 release contract", () => {
  assert.deepEqual(ANDROID_RELEASE_SCHEMAS, {
    intent: "latchway.maven-central-upload-intent.v2",
    record: "latchway.maven-central-deployment.v2",
    status: "latchway.maven-central-deployment-status.v2",
    proof: 2,
    tagBinding: "latchway.github-release-tag-binding.v1",
  });
});

test("checked-out Android source agrees with the locked schema constants", async (context) => {
  let source;
  try {
    source = await readFile(
      new URL("../../latchway-android/scripts/central-deployment-record.py", import.meta.url),
      "utf8",
    );
  } catch (error) {
    if (error?.code === "ENOENT") {
      context.skip("canonical Android checkout is not present in this standalone SDK job");
      return;
    }
    throw error;
  }
  for (const [constant, schema] of [
    ["INTENT_SCHEMA", ANDROID_RELEASE_SCHEMAS.intent],
    ["RECORD_SCHEMA", ANDROID_RELEASE_SCHEMAS.record],
    ["STATUS_SCHEMA", ANDROID_RELEASE_SCHEMAS.status],
  ]) assert.match(source, new RegExp(`^${constant} = "${schema.replaceAll(".", "\\.")}"$`, "mu"));
});

test("Android dependency contract requires the exact ten release assets", () => {
  assert.deepEqual(androidReleaseAssetNames("1.0.0"), [
    "latchway-android-1.0.0-maven-repository.zip",
    "latchway-android-1.0.0-central-portal.zip",
    "docs-bundle-1.0.0.tar.gz",
    "SHA256SUMS",
    "github-release-tag-binding.json",
    "latchway-maven-signing-public-key.asc",
    "maven-central-upload-intent.json",
    "maven-central-deployment.json",
    "maven-central-deployment-status.json",
    "maven-central-release-evidence.json",
  ]);
});

test("Android reviewed repository requires the exact 24-primary and 120-file closure", () => {
  const primary = expectedMavenPrimaryPaths("1.0.0");
  assert.equal(primary.length, 24);
  assert.equal(new Set(primary).size, 24);
  const closure = primary.flatMap((path) => [
    `dev/latchway/${path}`,
    ...["md5", "sha1", "sha256", "sha512"].map((algorithm) => `dev/latchway/${path}.${algorithm}`),
  ]);
  assert.equal(closure.length, 120);
  assert.doesNotThrow(() => validateMavenRepositoryPathClosure(closure, "1.0.0"));
  assert.throws(
    () => validateMavenRepositoryPathClosure(closure.slice(1), "1.0.0"),
    /exact primary-and-checksum path closure/u,
  );
  assert.throws(
    () => validateMavenRepositoryPathClosure([...closure, "dev/latchway/attacker/1.0.0/extra.pom"], "1.0.0"),
    /exact primary-and-checksum path closure/u,
  );
});

test("Android archive expansion budgets cap each retained Map and their combined footprint", () => {
  assert.equal(MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES, 128 * 1024 * 1024);
  assert.equal(MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES, 160 * 1024 * 1024);
  assert.equal(MAXIMUM_MAVEN_RETAINED_EXPANDED_BYTES, 288 * 1024 * 1024);
  for (const [kind, maximum] of [
    ["repository", MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES],
    ["portal", MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES],
  ]) {
    let total = 0;
    while (maximum - total > 20 * 1024 * 1024) {
      total = accumulateMavenArchiveBytes(total, 20 * 1024 * 1024, kind);
    }
    total = accumulateMavenArchiveBytes(total, maximum - total, kind);
    assert.equal(total, maximum);
    assert.throws(
      () => accumulateMavenArchiveBytes(total, 1, kind),
      /aggregate expanded-byte limit/u,
    );
  }
  assert.throws(
    () => accumulateMavenArchiveBytes(0, (20 * 1024 * 1024) + 1, "repository"),
    /invalid expanded size/u,
  );
});

test("Android dependency contract accepts schema-v2 recoverable Portal evidence", () => {
  assert.doesNotThrow(() => validateAndroidReleaseEvidence(fixture()));
});

test("Android dependency contract rejects legacy and substituted release evidence", () => {
  const cases = [
    ["legacy schema", (value) => { value.proof.schema_version = 1; }],
    ["automatic publication", (value) => { value.uploadIntent.publishing_type = "automatic"; }],
    ["single-use authorization", (value) => { value.uploadIntent.authorization = "single_upload_only"; }],
    ["portal substitution", (value) => { value.uploadIntent.reviewed_portal_bundle_sha256 = "0".repeat(64); }],
    ["missing portal field", (value) => { delete value.uploadIntent.reviewed_portal_bundle_sha256; }],
    ["tag-object substitution", (value) => { value.tagBinding.tag_object_sha = "9".repeat(40); }],
    ["manifest substitution", (value) => { value.proof.public_manifest[0].sha256 = "0".repeat(64); }],
    ["deployment kind substitution", (value) => { value.deployment.record_kind = "invented"; }],
  ];
  for (const [name, mutate] of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => validateAndroidReleaseEvidence(value), undefined, name);
  }
});

test("Android dependency contract accepts manifest-bound public-registry adoption only", () => {
  const adopted = fixture();
  adopted.deployment.record_kind = "public_registry_adoption";
  adopted.deployment.deployment_id = null;
  adopted.deployment.public_manifest_sha256 = adopted.proof.public_manifest_sha256;
  adopted.deploymentStatus.record_kind = "public_registry_adoption";
  adopted.deploymentStatus.deployment_id = null;
  adopted.deploymentStatus.public_manifest_sha256 = adopted.proof.public_manifest_sha256;
  bindRetainedDeployment(adopted);
  assert.doesNotThrow(() => validateAndroidReleaseEvidence(adopted));

  adopted.deploymentStatus.public_manifest_sha256 = "0".repeat(64);
  bindRetainedDeployment(adopted);
  assert.throws(
    () => validateAndroidReleaseEvidence(adopted),
    /public-registry adoption state/u,
  );
});

function fixture() {
  const version = "1.0.0";
  const sourceCommit = "a".repeat(40);
  const tag = `v${version}`;
  const tagObject = "b".repeat(40);
  const archiveSHA256 = "c".repeat(64);
  const portalSHA256 = "d".repeat(64);
  const repositoryManifestSHA256 = "e".repeat(64);
  const publicKeySHA256 = "f".repeat(64);
  const intentSHA256 = "1".repeat(64);
  const recordSHA256 = "2".repeat(64);
  const statusSHA256 = "3".repeat(64);
  const expectedPURLs = [
    "latchway-core", "latchway-okhttp", "latchway-play-integrity", "latchway-firebase-auth", "latchway-bom",
  ].map((module) => `pkg:maven/dev.latchway/${module}@${version}`);
  const deploymentName = `latchway-android-v${version}-${sourceCommit.slice(0, 12)}-${portalSHA256}`;
  const checksums = ["md5", "sha1", "sha256", "sha512"].map((algorithm, index) => ({
    algorithm,
    path: `latchway-core/${version}/latchway-core-${version}.pom.${algorithm}`,
    bytes: 64 + index,
    sha256: String(6 + index).repeat(64),
    published_digest: "a".repeat(32),
  }));
  const files = [{
    path: `latchway-core/${version}/latchway-core-${version}.pom`,
    sha256: "4".repeat(64),
    bytes: 100,
    signature_sha256: "5".repeat(64),
    signature_bytes: 200,
    signature_armored: "-----BEGIN PGP SIGNATURE-----\nfixture\n-----END PGP SIGNATURE-----\n",
    gpg_status: {},
    checksums,
    checksums_byte_identical: true,
  }];
  const publicManifest = publicManifestFromFiles(files);
  const publicManifestSHA256 = digest(canonicalJSON(publicManifest));
  const uploadIntent = {
    schema: "latchway.maven-central-upload-intent.v2",
    repository: "Latchway/latchway-android",
    source_commit: sourceCommit,
    release_tag: tag,
    version,
    namespace: "dev.latchway",
    deployment_name: deploymentName,
    publishing_type: "user_managed",
    reviewed_repository_archive_sha256: archiveSHA256,
    reviewed_repository_manifest_sha256: repositoryManifestSHA256,
    reviewed_repository_file_count: 120,
    reviewed_portal_bundle_sha256: portalSHA256,
    reviewed_portal_bundle_file_count: 144,
    reviewed_public_key_sha256: publicKeySHA256,
    expected_purls: expectedPURLs,
    authorization: "recoverable_exact_upload",
  };
  const deployment = {
    schema: "latchway.maven-central-deployment.v2",
    intent_sha256: intentSHA256,
    deployment_name: deploymentName,
    publishing_type: "user_managed",
    namespace: "dev.latchway",
    version,
    source_commit: sourceCommit,
    expected_purls: expectedPURLs,
    reviewed_portal_bundle_sha256: portalSHA256,
    record_kind: "portal_deployment",
    deployment_id: "28570f16-da32-4c14-bd2e-c1acc0782365",
    public_manifest_sha256: null,
  };
  const deploymentStatus = {
    schema: "latchway.maven-central-deployment-status.v2",
    intent_sha256: intentSHA256,
    record_sha256: recordSHA256,
    record_kind: "portal_deployment",
    deployment_id: deployment.deployment_id,
    deployment_name: deploymentName,
    deployment_state: "PUBLISHED",
    purls: [...expectedPURLs].sort(),
    public_manifest_sha256: null,
  };
  const proof = {
    schema_version: 2,
    registry: "maven_central",
    namespace: "dev.latchway",
    version,
    reviewed_repository: true,
    primary_artifacts_byte_identical: true,
    checksum_files_byte_identical: true,
    signature_files_present: true,
    signatures_cryptographically_verified: true,
    signing_fingerprint: "A".repeat(40),
    reviewed_public_key_sha256: publicKeySHA256,
    deployment: {
      intent_sha256: intentSHA256,
      record_sha256: recordSHA256,
      status_sha256: statusSHA256,
      record_kind: "portal_deployment",
      record: structuredClone(deployment),
      status: structuredClone(deploymentStatus),
    },
    public_manifest: publicManifest,
    public_manifest_sha256: publicManifestSHA256,
    files,
  };
  return {
    version,
    sourceCommit,
    tag,
    tagObject,
    archiveSHA256,
    portalSHA256,
    repositoryManifestSHA256,
    repositoryFileCount: 120,
    portalFileCount: 144,
    publicKeySHA256,
    expectedPURLs,
    intentSHA256,
    recordSHA256,
    statusSHA256,
    uploadIntent,
    deployment,
    deploymentStatus,
    proof,
    tagBinding: {
      schema: "latchway.github-release-tag-binding.v1",
      tag,
      tag_object_sha: tagObject,
      commit: sourceCommit,
      message_sha256: "a".repeat(64),
    },
  };
}

function bindRetainedDeployment(value) {
  value.proof.deployment.record_kind = value.deployment.record_kind;
  value.proof.deployment.record = structuredClone(value.deployment);
  value.proof.deployment.status = structuredClone(value.deploymentStatus);
}

function canonicalJSON(value) {
  return Buffer.from(`${JSON.stringify(sortKeys(value), null, 2)}\n`, "utf8");
}

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
