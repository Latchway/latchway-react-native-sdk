import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  ANDROID_RELEASE_PROFILES,
  ANDROID_RELEASE_SCHEMAS,
  MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES,
  MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES,
  MAXIMUM_MAVEN_RETAINED_EXPANDED_BYTES,
  accumulateMavenArchiveBytes,
  androidReleaseAssetNames,
  expectedSingleMaintainerAndroidTagMessage,
  expectedMavenPrimaryPaths,
  publicManifestFromFiles,
  validateAndroidReleaseEvidence,
  validateSingleMaintainerAndroidReleaseEvidence,
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
  assert.deepEqual(androidReleaseAssetNames("1.0.0", ANDROID_RELEASE_PROFILES.singleMaintainerV1), [
    "latchway-android-1.0.0-maven-repository.zip",
    "latchway-android-1.0.0-central-portal.zip",
    "docs-bundle-1.0.0.tar.gz",
    "android-dependency-vulnerability-scan.json",
    "latchway-maven-signing-public-key.asc",
    "maven-central-upload-intent.json",
    "latchway-single-maintainer-v1-intent.json",
    "pinned-core-conformance.tar.gz",
    "maven-central-deployment.json",
    "maven-central-deployment-status.json",
    "maven-central-release-evidence.json",
    "github-release-tag-binding.json",
    "single-maintainer-release-evidence.json",
    "SHA256SUMS",
  ]);
  assert.throws(() => androidReleaseAssetNames("1.0.0", "permissive"), /Unsupported Android release/u);
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

test("Android single-maintainer proof requires exact public signature byte identity", () => {
  const value = fixture();
  value.profile = ANDROID_RELEASE_PROFILES.singleMaintainerV1;
  value.proof.signature_files_byte_identical = true;
  value.proof.files[0].expected_signature_sha256 = value.proof.files[0].signature_sha256;
  value.proof.files[0].signature_byte_identical = true;
  assert.doesNotThrow(() => validateAndroidReleaseEvidence(value));

  for (const [name, mutate] of [
    ["missing aggregate signature identity", (candidate) => {
      delete candidate.proof.signature_files_byte_identical;
    }],
    ["false aggregate signature identity", (candidate) => {
      candidate.proof.signature_files_byte_identical = false;
    }],
    ["substituted expected signature", (candidate) => {
      candidate.proof.files[0].expected_signature_sha256 = "0".repeat(64);
    }],
    ["false per-file signature identity", (candidate) => {
      candidate.proof.files[0].signature_byte_identical = false;
    }],
  ]) {
    const candidate = structuredClone(value);
    mutate(candidate);
    assert.throws(() => validateAndroidReleaseEvidence(candidate), undefined, name);
  }
  const strict = fixture();
  strict.proof.signature_files_byte_identical = true;
  assert.throws(
    () => validateAndroidReleaseEvidence(strict),
    /unexpected schema/u,
    "the strict profile must not silently accept the lower-assurance proof extension",
  );
});

test("Android single-maintainer completion binds exact source, intent, Maven proof, and deferrals", () => {
  const value = singleMaintainerFixture();
  assert.doesNotThrow(() => validateSingleMaintainerAndroidReleaseEvidence(value));
  const recovered = structuredClone(value);
  recovered.completion.workflow.run_attempt = 2;
  assert.doesNotThrow(() => validateSingleMaintainerAndroidReleaseEvidence(recovered));
  assert.equal(
    expectedSingleMaintainerAndroidTagMessage(value.version, value.intentSHA256),
    `Latchway Android SDK v1.0.0\n\nRelease profile: single_maintainer_v1\n`
      + "Assurance: deferred; not release-qualified or independently reviewed\n"
      + `Maintainer intent SHA-256: ${value.intentSHA256}`,
  );
  for (const [name, mutate] of [
    ["source substitution", (candidate) => { candidate.completion.source.commit = "9".repeat(40); }],
    ["Maven proof substitution", (candidate) => {
      candidate.completion.maven_central_release_evidence_sha256 = "9".repeat(64);
    }],
    ["missing deferred evidence", (candidate) => { candidate.completion.deferred_evidence.pop(); }],
    ["strong release claim", (candidate) => { candidate.completion.release_qualified = true; }],
    ["different workflow run", (candidate) => { candidate.completion.workflow.run_id = 124; }],
    ["earlier completion attempt", (candidate) => {
      candidate.intent.workflow.run_attempt = 2;
      candidate.completion.workflow.run_attempt = 1;
    }],
    ["boolean workflow run", (candidate) => { candidate.intent.workflow.run_id = true; }],
    ["unexpected intent field", (candidate) => { candidate.intent.unreviewed = true; }],
  ]) {
    const candidate = structuredClone(value);
    mutate(candidate);
    assert.throws(() => validateSingleMaintainerAndroidReleaseEvidence(candidate), undefined, name);
  }
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

function singleMaintainerFixture() {
  const version = "1.0.0";
  const sourceCommit = "a".repeat(40);
  const coreCommit = "b".repeat(40);
  const tag = `v${version}`;
  const coreBundleSHA256 = "c".repeat(64);
  const intentSHA256 = "d".repeat(64);
  const mavenEvidenceSHA256 = "e".repeat(64);
  const pinnedCoreConformanceSHA256 = "f".repeat(64);
  const publishedCoordinates = [
    "latchway-core", "latchway-okhttp", "latchway-play-integrity", "latchway-firebase-auth", "latchway-bom",
  ].map((module) => `dev.latchway:${module}:${version}`);
  const deferredEvidence = [
    "independent_human_review", "live_sdk_conformance", "physical_devices",
    "apple_distribution_and_extensions", "play_integrity_and_android_device", "firebase_app_check",
    "turnstile", "live_provider", "cloud_deployments.aws_verified", "cloud_deployments.fly_io_verified",
    "cloud_deployments.cloudflare_containers_verified", "operational_resilience",
    "public_registries.documentation_production_verified", "mintlify_production",
  ];
  const forbiddenClaims = ["release_qualified", "fully_evidence_gated", "independently_reviewed"];
  const globalEvidence = ["cloud_deployments.compose_verified", "cloud_deployments.gcp_cloud_run_verified"];
  const intent = {
    schema_version: 1,
    kind: "latchway_single_maintainer_release_intent",
    profile: "single_maintainer_v1",
    status: "maintainer_requested",
    status_claim: "v1_publication_in_progress_with_deferred_assurance",
    publication_ready: false,
    release_qualified: false,
    requires_independent_human_review: false,
    source: {
      repository: "Latchway/latchway-android", commit: sourceCommit, version, tag, ref: "refs/heads/main",
    },
    contract: { core_commit: coreCommit, core_tag: tag, bundle_sha256: coreBundleSHA256, wire_protocol: 2 },
    workflow: {
      file: ".github/workflows/single-maintainer-release.yml", event: "workflow_dispatch", run_id: 123, run_attempt: 1,
    },
    maintainer_confirmation: "accepted_exact_phrase",
    maven_coordinates: publishedCoordinates,
    deferred_evidence: deferredEvidence,
    forbidden_claims: forbiddenClaims,
    global_profile_required_evidence: globalEvidence,
    downstream_required_gates: [
      "complete_local_release_tests_before_tag", "dependency_vulnerability_scan_before_tag",
      "deterministic_maven_repository_before_tag", "annotated_tag_exact_commit",
      "openpgp_signed_maven_artifacts", "exact_maven_central_byte_verification",
      "build_provenance_attestation", "exact_github_release",
    ],
  };
  const completion = {
    schema_version: 1,
    kind: "latchway_single_maintainer_release_evidence",
    profile: "single_maintainer_v1",
    status: "publication_completed_with_deferred_assurance",
    publication_completed: true,
    release_qualified: false,
    fully_evidence_gated: false,
    independently_reviewed: false,
    source: { repository: "Latchway/latchway-android", commit: sourceCommit, tag, version },
    workflow: { file: ".github/workflows/single-maintainer-release.yml", run_id: 123, run_attempt: 1 },
    maintainer_intent_sha256: intentSHA256,
    maven_central_release_evidence_sha256: mavenEvidenceSHA256,
    pinned_core_conformance_sha256: pinnedCoreConformanceSHA256,
    published_coordinates: publishedCoordinates,
    global_profile_required_evidence: globalEvidence,
    deferred_evidence: deferredEvidence,
    forbidden_claims: forbiddenClaims,
  };
  return {
    version, sourceCommit, tag, coreCommit, coreBundleSHA256, intentSHA256, mavenEvidenceSHA256,
    pinnedCoreConformanceSHA256, intent, completion,
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
