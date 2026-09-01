import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

const SHA256 = /^[0-9a-f]{64}$/u;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAXIMUM_MAVEN_ENTRY_BYTES = 20 * 1024 * 1024;

export const MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES = 128 * 1024 * 1024;
export const MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES = 160 * 1024 * 1024;
export const MAXIMUM_MAVEN_RETAINED_EXPANDED_BYTES =
  MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES + MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES;

export const ANDROID_RELEASE_SCHEMAS = Object.freeze({
  intent: "latchway.maven-central-upload-intent.v2",
  record: "latchway.maven-central-deployment.v2",
  status: "latchway.maven-central-deployment-status.v2",
  proof: 2,
  tagBinding: "latchway.github-release-tag-binding.v1",
});

export function androidReleaseAssetNames(version) {
  return [
    `latchway-android-${version}-maven-repository.zip`,
    `latchway-android-${version}-central-portal.zip`,
    `docs-bundle-${version}.tar.gz`,
    "SHA256SUMS",
    "github-release-tag-binding.json",
    "latchway-maven-signing-public-key.asc",
    "maven-central-upload-intent.json",
    "maven-central-deployment.json",
    "maven-central-deployment-status.json",
    "maven-central-release-evidence.json",
  ];
}

export function expectedMavenPrimaryPaths(version) {
  if (typeof version !== "string"
      || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
    throw new Error("Android release version is not canonical.");
  }
  const result = [];
  for (const module of [
    "latchway-core", "latchway-okhttp", "latchway-play-integrity", "latchway-firebase-auth", "latchway-bom",
  ]) {
    const extensions = ["pom", "module", "sources.jar", "javadoc.jar"];
    if (module !== "latchway-bom") extensions.push("aar");
    for (const extension of extensions) {
      const name = new Set(["pom", "module", "aar"]).has(extension)
        ? `${module}-${version}.${extension}`
        : `${module}-${version}-${extension}`;
      result.push(`${module}/${version}/${name}`);
    }
  }
  return result;
}

export function validateMavenRepositoryPathClosure(paths, version) {
  const primary = expectedMavenPrimaryPaths(version);
  const expected = primary.flatMap((path) => [
    `dev/latchway/${path}`,
    ...["md5", "sha1", "sha256", "sha512"].map((algorithm) => `dev/latchway/${path}.${algorithm}`),
  ]).sort();
  const observed = [...paths];
  if (observed.some((path) => typeof path !== "string")
      || new Set(observed).size !== observed.length
      || !isDeepStrictEqual(observed.sort(), expected)) {
    throw new Error("Reviewed Maven repository does not contain the exact primary-and-checksum path closure.");
  }
}

export function accumulateMavenArchiveBytes(totalBytes, entryBytes, kind) {
  const maximumBytes = kind === "repository"
    ? MAXIMUM_MAVEN_REPOSITORY_EXPANDED_BYTES
    : kind === "portal" ? MAXIMUM_MAVEN_PORTAL_EXPANDED_BYTES : undefined;
  if (maximumBytes === undefined || !Number.isSafeInteger(totalBytes) || totalBytes < 0
      || !Number.isSafeInteger(entryBytes) || entryBytes < 1 || entryBytes > MAXIMUM_MAVEN_ENTRY_BYTES) {
    throw new Error(`Reviewed Maven ${kind} archive entry has an invalid expanded size.`);
  }
  const next = totalBytes + entryBytes;
  if (!Number.isSafeInteger(next) || next > maximumBytes) {
    throw new Error(`Reviewed Maven ${kind} archive exceeds its aggregate expanded-byte limit.`);
  }
  return next;
}

export function validateAndroidReleaseEvidence({
  version,
  sourceCommit,
  tag,
  tagObject,
  archiveSHA256,
  portalSHA256,
  repositoryManifestSHA256,
  repositoryFileCount,
  portalFileCount,
  publicKeySHA256,
  expectedPURLs,
  intentSHA256,
  recordSHA256,
  statusSHA256,
  uploadIntent,
  deployment,
  deploymentStatus,
  proof,
  tagBinding,
}) {
  const identity = {
    version,
    sourceCommit,
    tag,
    tagObject,
    archiveSHA256,
    portalSHA256,
    repositoryManifestSHA256,
    publicKeySHA256,
    intentSHA256,
    recordSHA256,
    statusSHA256,
  };
  if (Object.values(identity).some((value) => typeof value !== "string")
      || !OBJECT_ID.test(sourceCommit) || !OBJECT_ID.test(tagObject)
      || ![archiveSHA256, portalSHA256, repositoryManifestSHA256, publicKeySHA256,
        intentSHA256, recordSHA256, statusSHA256].every((value) => SHA256.test(value))) {
    throw new Error("Android release evidence identity is invalid.");
  }
  if (!Number.isInteger(repositoryFileCount) || repositoryFileCount < 1
      || !Number.isInteger(portalFileCount) || portalFileCount <= repositoryFileCount
      || !Array.isArray(expectedPURLs) || expectedPURLs.length === 0
      || expectedPURLs.some((value) => typeof value !== "string")
      || new Set(expectedPURLs).size !== expectedPURLs.length) {
    throw new Error("Android reviewed release inputs are invalid.");
  }

  requireExactKeys(uploadIntent, [
    "schema", "repository", "source_commit", "release_tag", "version", "namespace", "deployment_name",
    "publishing_type", "reviewed_repository_archive_sha256", "reviewed_repository_manifest_sha256",
    "reviewed_repository_file_count", "reviewed_portal_bundle_sha256", "reviewed_portal_bundle_file_count",
    "reviewed_public_key_sha256", "expected_purls", "authorization",
  ], "Maven Central upload intent");
  const expectedDeploymentName = `latchway-android-v${version}-${sourceCommit.slice(0, 12)}-${portalSHA256}`;
  if (uploadIntent.schema !== ANDROID_RELEASE_SCHEMAS.intent
      || uploadIntent.repository !== "Latchway/latchway-android"
      || uploadIntent.source_commit !== sourceCommit || uploadIntent.release_tag !== tag
      || uploadIntent.version !== version || uploadIntent.namespace !== "dev.latchway"
      || uploadIntent.deployment_name !== expectedDeploymentName
      || uploadIntent.publishing_type !== "user_managed"
      || uploadIntent.authorization !== "recoverable_exact_upload"
      || uploadIntent.reviewed_repository_archive_sha256 !== archiveSHA256
      || uploadIntent.reviewed_repository_manifest_sha256 !== repositoryManifestSHA256
      || uploadIntent.reviewed_repository_file_count !== repositoryFileCount
      || uploadIntent.reviewed_portal_bundle_sha256 !== portalSHA256
      || uploadIntent.reviewed_portal_bundle_file_count !== portalFileCount
      || uploadIntent.reviewed_public_key_sha256 !== publicKeySHA256
      || !isDeepStrictEqual(uploadIntent.expected_purls, expectedPURLs)) {
    throw new Error("Maven Central upload intent does not bind the exact recoverable reviewed release.");
  }

  requireExactKeys(tagBinding, ["schema", "tag", "tag_object_sha", "commit", "message_sha256"],
    "Android GitHub release tag binding");
  if (tagBinding.schema !== ANDROID_RELEASE_SCHEMAS.tagBinding
      || tagBinding.tag !== tag || tagBinding.tag_object_sha !== tagObject
      || tagBinding.commit !== sourceCommit || !SHA256.test(tagBinding.message_sha256)) {
    throw new Error("Android GitHub release tag binding does not match the locked source.");
  }

  requireExactKeys(proof, [
    "schema_version", "registry", "namespace", "version", "reviewed_repository",
    "primary_artifacts_byte_identical", "checksum_files_byte_identical", "signature_files_present",
    "signatures_cryptographically_verified", "signing_fingerprint", "reviewed_public_key_sha256",
    "deployment", "public_manifest", "public_manifest_sha256", "files",
  ], "Maven Central release evidence");
  if (proof.schema_version !== ANDROID_RELEASE_SCHEMAS.proof
      || proof.registry !== "maven_central" || proof.namespace !== "dev.latchway"
      || proof.version !== version || proof.reviewed_repository !== true
      || proof.primary_artifacts_byte_identical !== true || proof.checksum_files_byte_identical !== true
      || proof.signature_files_present !== true || proof.signatures_cryptographically_verified !== true
      || proof.reviewed_public_key_sha256 !== publicKeySHA256
      || !Array.isArray(proof.files) || proof.files.length === 0) {
    throw new Error("Maven Central schema-v2 evidence does not bind the exact reviewed release.");
  }
  const expectedPublicManifest = publicManifestFromFiles(proof.files);
  if (!isDeepStrictEqual(proof.public_manifest, expectedPublicManifest)
      || proof.public_manifest_sha256 !== digest(canonicalJSON(expectedPublicManifest))) {
    throw new Error("Maven Central public manifest does not bind every exact public artifact.");
  }

  requireExactKeys(deployment, [
    "schema", "intent_sha256", "deployment_name", "publishing_type", "namespace", "version",
    "source_commit", "expected_purls", "reviewed_portal_bundle_sha256", "record_kind",
    "deployment_id", "public_manifest_sha256",
  ], "Maven Central deployment record");
  requireExactKeys(deploymentStatus, [
    "schema", "intent_sha256", "record_sha256", "record_kind", "deployment_id", "deployment_name",
    "deployment_state", "purls", "public_manifest_sha256",
  ], "Maven Central deployment status");
  requireExactKeys(proof.deployment, [
    "intent_sha256", "record_sha256", "status_sha256", "record_kind", "record", "status",
  ], "Maven Central retained deployment evidence");
  if (deployment.schema !== ANDROID_RELEASE_SCHEMAS.record
      || deployment.intent_sha256 !== intentSHA256 || deployment.deployment_name !== expectedDeploymentName
      || deployment.publishing_type !== "user_managed" || deployment.namespace !== "dev.latchway"
      || deployment.version !== version || deployment.source_commit !== sourceCommit
      || !isDeepStrictEqual(deployment.expected_purls, expectedPURLs)
      || deployment.reviewed_portal_bundle_sha256 !== portalSHA256
      || deploymentStatus.schema !== ANDROID_RELEASE_SCHEMAS.status
      || deploymentStatus.intent_sha256 !== intentSHA256 || deploymentStatus.record_sha256 !== recordSHA256
      || deploymentStatus.record_kind !== deployment.record_kind
      || deploymentStatus.deployment_id !== deployment.deployment_id
      || deploymentStatus.deployment_name !== expectedDeploymentName
      || deploymentStatus.deployment_state !== "PUBLISHED"
      || !isDeepStrictEqual(deploymentStatus.purls, [...expectedPURLs].sort())
      || proof.deployment.intent_sha256 !== intentSHA256
      || proof.deployment.record_sha256 !== recordSHA256
      || proof.deployment.status_sha256 !== statusSHA256
      || proof.deployment.record_kind !== deployment.record_kind
      || !isDeepStrictEqual(proof.deployment.record, deployment)
      || !isDeepStrictEqual(proof.deployment.status, deploymentStatus)) {
    throw new Error("Maven Central evidence does not bind the exact deployment and terminal status.");
  }
  if (deployment.record_kind === "portal_deployment") {
    if (typeof deployment.deployment_id !== "string" || !UUID.test(deployment.deployment_id)
        || deployment.public_manifest_sha256 !== null || deploymentStatus.public_manifest_sha256 !== null) {
      throw new Error("Maven Central Portal deployment state is invalid.");
    }
  } else if (deployment.record_kind === "public_registry_adoption") {
    if (deployment.deployment_id !== null || deployment.public_manifest_sha256 !== proof.public_manifest_sha256
        || deploymentStatus.public_manifest_sha256 !== proof.public_manifest_sha256) {
      throw new Error("Maven Central public-registry adoption state is invalid.");
    }
  } else {
    throw new Error("Maven Central deployment record kind is invalid.");
  }
}

export function publicManifestFromFiles(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("Maven Central evidence files are invalid.");
  }
  const entries = [];
  for (const file of files) {
    if (file === null || typeof file !== "object" || typeof file.path !== "string"
        || !Number.isInteger(file.bytes) || file.bytes < 1 || !SHA256.test(file.sha256)
        || !Number.isInteger(file.signature_bytes) || file.signature_bytes < 1
        || !SHA256.test(file.signature_sha256) || !Array.isArray(file.checksums)) {
      throw new Error("Maven Central evidence cannot derive its public manifest.");
    }
    entries.push({ path: file.path, bytes: file.bytes, sha256: file.sha256 });
    entries.push({ path: `${file.path}.asc`, bytes: file.signature_bytes, sha256: file.signature_sha256 });
    for (const checksum of file.checksums) {
      if (checksum === null || typeof checksum !== "object" || typeof checksum.path !== "string"
          || !Number.isInteger(checksum.bytes) || checksum.bytes < 1 || !SHA256.test(checksum.sha256)) {
        throw new Error("Maven Central checksum cannot derive its public manifest.");
      }
      entries.push({ path: checksum.path, bytes: checksum.bytes, sha256: checksum.sha256 });
    }
  }
  entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (new Set(entries.map((entry) => entry.path)).size !== entries.length) {
    throw new Error("Maven Central public manifest contains duplicate paths.");
  }
  return entries;
}

function requireExactKeys(value, keys, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)
      || !isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort())) {
    throw new Error(`${label} has an unexpected schema.`);
  }
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
