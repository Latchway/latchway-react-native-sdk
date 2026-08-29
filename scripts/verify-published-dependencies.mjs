import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { readJSON, readLock, requireLockValue } from "./release-metadata.mjs";
import {
  PROVENANCE_TYPE,
  PUBLISH_TYPE,
  SOURCE_REF,
  WORKFLOW_PATH,
  parseProvenanceOrigin,
  verifyProvenanceStatement,
  verifyPublishStatement,
} from "./npm-release-evidence.mjs";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/";

const compatibility = await readJSON("release-compatibility.json");
const contractLock = await readLock();
const selected = new Set(process.argv.slice(2));
const verifyAll = selected.size === 0 || selected.has("--all");
const evidence = {
  schema_version: 1,
  kind: "latchway_react_native_published_dependency_evidence",
  dependencies: {},
};
const temporary = await mkdtemp(join(tmpdir(), "latchway-published-dependencies-"));
try {
  if (verifyAll || selected.has("--javascript")) evidence.dependencies.javascript = await verifyJavaScript();
  if (verifyAll || selected.has("--core-ref")) {
    verifyReleaseTag({
      repository: compatibility.contract.repository,
      source_commit: compatibility.contract.core_commit,
    }, "core", requireLockValue(contractLock, "core_release"));
    evidence.dependencies.core = {
      repository: normalizeRepository(compatibility.contract.repository),
      source_commit: compatibility.contract.core_commit,
      release_tag: requireLockValue(contractLock, "core_release"),
    };
  }
  if (verifyAll || selected.has("--native-refs")) {
    evidence.dependencies.ios = await verifyIOS();
    evidence.dependencies.android = await verifyAndroid();
  }
  const output = process.env.LATCHWAY_PUBLISHED_DEPENDENCY_EVIDENCE;
  if (typeof output === "string") {
    if (output.length === 0 || output.includes("\0")) throw new Error("Invalid dependency evidence output path.");
    await writeFile(output, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  }
  process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function verifyJavaScript() {
  const dependency = compatibility.javascript;
  const repository = repositorySlug(dependency.repository, "Latchway/latchway-js");
  const tag = `v${dependency.version}`;
  verifyReleaseTag(dependency, "JavaScript", tag);
  const release = githubRelease(repository, tag);
  requireImmutableRelease(release, tag);
  const releaseAttestation = verifyReleaseAttestation(repository, tag);
  const archiveName = `latchway-client-${dependency.version}.tgz`;
  const fixed = [
    archiveName,
    "SHA256SUMS",
    "build-reproducibility.json",
    "contract-evidence.json",
    "package-evidence.json",
    "post-publish-evidence.json",
    "publish-input-evidence.json",
    "release-candidate-evidence.json",
    "tag-evidence.json",
    "npm-registry-version.json",
    "npm-registry-view.json",
    "npm-attestations.json",
    "npm-audit-signatures.json",
    "npm-registry-evidence-manifest.json",
  ];
  const adoptions = release.assets.map((asset) => asset.name)
    .filter((name) => /^npm-release-adoption-[1-9]\d*-[1-9]\d*\.json$/u.test(name)).sort();
  if (adoptions.length === 0) throw new Error("JavaScript release is missing an authenticated npm adoption record.");
  requireExactReleaseAssets(release, [...fixed, ...adoptions]);
  const assets = await downloadAssets(repository, release, [...fixed, ...adoptions], "javascript");
  for (const name of [archiveName, "build-reproducibility.json", "package-evidence.json",
    "post-publish-evidence.json", "npm-registry-version.json", "npm-registry-view.json",
    "npm-attestations.json", "npm-audit-signatures.json", "npm-registry-evidence-manifest.json",
    ...adoptions]) {
    verifyGitHubAttestation(repository, assets.get(name).path, dependency.source_commit);
  }

  const packageEvidence = await jsonAsset(assets, "package-evidence.json");
  const post = await jsonAsset(assets, "post-publish-evidence.json");
  const manifest = await jsonAsset(assets, "npm-registry-evidence-manifest.json");
  const registryMetadata = await jsonAsset(assets, "npm-registry-version.json");
  const npmView = await jsonAsset(assets, "npm-registry-view.json");
  const retainedAttestations = await jsonAsset(assets, "npm-attestations.json");
  const retainedAudit = await jsonAsset(assets, "npm-audit-signatures.json");
  if (packageEvidence.package !== dependency.package || packageEvidence.version !== dependency.version
      || packageEvidence.tarball !== archiveName || !/^[0-9a-f]{64}$/u.test(packageEvidence.sha256)
      || !/^[0-9a-f]{40}$/u.test(packageEvidence.sha1) || !/^[0-9a-f]{128}$/u.test(packageEvidence.sha512)
      || !Number.isInteger(packageEvidence.bytes) || packageEvidence.bytes < 1
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(packageEvidence.integrity)) {
    throw new Error("JavaScript package evidence does not bind the locked public coordinate.");
  }
  const archive = assets.get(archiveName).bytes;
  if (digest(archive) !== packageEvidence.sha256 || archive.byteLength !== packageEvidence.bytes
      || assets.get("SHA256SUMS").bytes.toString("utf8") !== `${packageEvidence.sha256}  ${archiveName}\n`) {
    throw new Error("JavaScript GitHub archive hash mismatch.");
  }
  if (!hasExactKeys(manifest, ["schema_version", "kind", "package", "version", "tarball", "evidence"])
      || !hasExactKeys(manifest.tarball, ["name", "bytes", "sha256", "sha512", "integrity"])
      || manifest.schema_version !== 1 || manifest.kind !== "latchway_npm_registry_evidence_manifest"
      || manifest.package !== dependency.package || manifest.version !== dependency.version
      || manifest.tarball?.name !== archiveName || manifest.tarball?.bytes !== archive.byteLength
      || manifest.tarball?.sha256 !== packageEvidence.sha256 || manifest.tarball?.sha512 !== packageEvidence.sha512
      || manifest.tarball?.integrity !== packageEvidence.integrity || !Array.isArray(manifest.evidence)
      || manifest.evidence.length !== 4) {
    throw new Error("JavaScript registry evidence manifest has an unexpected schema or coordinate.");
  }
  const manifestEntries = new Map(manifest.evidence?.map((entry) => [entry.name, entry]));
  if (manifestEntries.size !== 4) throw new Error("JavaScript registry evidence manifest has duplicate entries.");
  for (const name of [
    "npm-registry-version.json", "npm-registry-view.json", "npm-attestations.json", "npm-audit-signatures.json",
  ]) {
    const entry = manifestEntries.get(name);
    const asset = assets.get(name);
    if (!hasExactKeys(entry, ["name", "bytes", "sha256"])
        || entry?.bytes !== asset.bytes.byteLength || entry?.sha256 !== digest(asset.bytes)) {
      throw new Error(`JavaScript registry manifest does not bind ${name}.`);
    }
  }
  const expectedRepositoryURL = "https://github.com/Latchway/latchway-js";
  if (!hasExactKeys(post, [
    "schema_version", "kind", "package", "version", "source", "release_tag", "registry", "tarball",
    "trusted_publisher", "registry_signature_verification", "retained_outputs", "evidence_manifest",
  ]) || post.schema_version !== 2 || post.kind !== "latchway_npm_publication_evidence"
      || post.package !== dependency.package
      || post.version !== dependency.version || post.source?.repository !== expectedRepositoryURL
      || post.source?.commit !== dependency.source_commit || post.source?.workflow !== ".github/workflows/release.yml"
      || post.source?.ref !== "refs/heads/main" || post.release_tag !== tag
      || post.registry !== NPM_REGISTRY_URL || post.tarball?.name !== archiveName
      || post.tarball?.bytes !== archive.byteLength
      || post.tarball?.sha256 !== packageEvidence.sha256 || post.tarball?.integrity !== packageEvidence.integrity
      || post.tarball?.sha512 !== packageEvidence.sha512
      || post.tarball?.registry_bytes_sha256 !== packageEvidence.sha256
      || post.registry_signature_verification?.output?.sha256 !== digest(assets.get("npm-audit-signatures.json").bytes)
      || post.trusted_publisher?.sigstore_bundle?.sha256 !== digest(assets.get("npm-attestations.json").bytes)
      || post.evidence_manifest?.sha256 !== digest(assets.get("npm-registry-evidence-manifest.json").bytes)
      || post.evidence_manifest?.bytes !== assets.get("npm-registry-evidence-manifest.json").bytes.byteLength) {
    throw new Error("JavaScript npm evidence does not bind registry bytes, signatures, and locked source.");
  }
  const expectedRetainedNames = [...manifestEntries.keys()].sort();
  if (!isDeepStrictEqual(Object.keys(post.retained_outputs ?? {}).sort(), expectedRetainedNames)) {
    throw new Error("JavaScript publication evidence does not enumerate the exact retained outputs.");
  }
  for (const name of expectedRetainedNames) {
    if (!isDeepStrictEqual(post.retained_outputs[name], {
      bytes: assets.get(name).bytes.byteLength,
      sha256: digest(assets.get(name).bytes),
    })) throw new Error(`JavaScript publication evidence does not bind ${name}.`);
  }

  const repositoryFromView = typeof npmView.repository === "object" ? npmView.repository?.url : npmView.repository;
  for (const value of [registryMetadata, npmView]) {
    if (value.name !== dependency.package || value.version !== dependency.version
        || value.dist?.integrity !== packageEvidence.integrity || value.dist?.shasum !== packageEvidence.sha1
        || !Array.isArray(value.dist?.signatures) || value.dist.signatures.length === 0
        || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE) {
      throw new Error("Retained npm registry metadata does not bind the exact signed package.");
    }
  }
  if (registryMetadata._npmUser?.trustedPublisher?.id !== "github"
      || normalizeRepository(repositoryFromView) !== expectedRepositoryURL.toLowerCase()) {
    throw new Error("Retained npm metadata does not identify the expected trusted publisher source.");
  }
  if (retainedAudit === null || typeof retainedAudit !== "object" || Object.hasOwn(retainedAudit, "error")) {
    throw new Error("Retained npm signature audit is not a successful exact JSON result.");
  }
  if (!Array.isArray(retainedAttestations.attestations)) {
    throw new Error("Retained npm Sigstore bundle has an unexpected schema.");
  }
  const provenance = exactlyOne(retainedAttestations.attestations, PROVENANCE_TYPE);
  const publication = exactlyOne(retainedAttestations.attestations, PUBLISH_TYPE);
  const provenanceOrigin = verifyProvenanceStatement(decodeNpmStatement(provenance), {
    packageName: dependency.package,
    packageVersion: dependency.version,
    sha512: packageEvidence.sha512,
    expectedRepositoryURL,
    expectedCommit: dependency.source_commit,
    expectedEvent: "repository_dispatch",
  });
  verifyNpmWorkflowCertificate(provenance, expectedRepositoryURL);
  verifyPublishStatement(decodeNpmStatement(publication), {
    packageName: dependency.package,
    packageVersion: dependency.version,
    sha512: packageEvidence.sha512,
    registryURL: NPM_REGISTRY_URL,
  });
  if (!isDeepStrictEqual(post.trusted_publisher?.provenance_origin, provenanceOrigin)
      || post.trusted_publisher?.provider !== "github"
      || post.trusted_publisher?.provenance_predicate_type !== PROVENANCE_TYPE) {
    throw new Error("JavaScript publication evidence provenance differs from the retained Sigstore statement.");
  }

  const manifestSHA = digest(assets.get("npm-registry-evidence-manifest.json").bytes);
  const sourceBinding = {
    repository: expectedRepositoryURL,
    commit: dependency.source_commit,
    workflow: WORKFLOW_PATH,
    ref: SOURCE_REF,
  };
  for (const name of adoptions) {
    const adoption = await jsonAsset(assets, name);
    const match = /^npm-release-adoption-([1-9]\d*)-([1-9]\d*)\.json$/u.exec(name);
    const adoptedOrigin = parseProvenanceOrigin(adoption.provenance?.invocation_id, expectedRepositoryURL);
    if (!hasExactKeys(adoption, [
      "schema_version", "kind", "package", "version", "release_tag", "tarball", "source", "provenance",
      "adoption", "registry_evidence_manifest",
    ]) || !hasExactKeys(adoption.provenance, [
      "repository", "commit", "workflow", "ref", "predicate_type", "invocation_id", "run_id", "run_attempt",
    ]) || !hasExactKeys(adoption.adoption, [
      "repository", "commit", "workflow", "ref", "run_id", "run_attempt", "mode",
    ]) || adoption.schema_version !== 1 || adoption.kind !== "latchway_npm_release_adoption"
        || adoption.package !== dependency.package
        || adoption.version !== dependency.version || adoption.release_tag !== tag
        || !isDeepStrictEqual(adoption.tarball, manifest.tarball)
        || !isDeepStrictEqual(adoption.source, sourceBinding)
        || adoption.provenance?.repository !== sourceBinding.repository
        || adoption.provenance?.commit !== sourceBinding.commit
        || adoption.provenance?.workflow !== sourceBinding.workflow
        || adoption.provenance?.ref !== sourceBinding.ref
        || adoption.provenance?.predicate_type !== PROVENANCE_TYPE
        || !isDeepStrictEqual(adoptedOrigin, provenanceOrigin)
        || String(adoption.adoption?.run_id) !== match?.[1]
        || String(adoption.adoption?.run_attempt) !== match?.[2]
        || adoption.adoption?.repository !== sourceBinding.repository
        || adoption.adoption?.commit !== sourceBinding.commit
        || adoption.adoption?.workflow !== sourceBinding.workflow
        || adoption.adoption?.ref !== sourceBinding.ref
        || !new Set(["published", "adopted_existing"]).has(adoption.adoption?.mode)
        || adoption.registry_evidence_manifest?.sha256 !== manifestSHA) {
      throw new Error(`JavaScript adoption record ${name} is not bound to the locked source and provenance.`);
    }
  }

  const liveMetadataResult = await fetchBounded(
    `https://registry.npmjs.org/${encodeURIComponent(dependency.package)}/${encodeURIComponent(dependency.version)}`,
    2 * 1024 * 1024,
    new Set(["https://registry.npmjs.org"]),
  );
  const liveMetadata = JSON.parse(liveMetadataResult.bytes.toString("utf8"));
  if (!liveMetadataResult.bytes.equals(assets.get("npm-registry-version.json").bytes)
      || liveMetadata.dist?.integrity !== packageEvidence.integrity || liveMetadata.dist?.shasum !== packageEvidence.sha1
      || liveMetadata._npmUser?.trustedPublisher?.id !== "github" || !Array.isArray(liveMetadata.dist?.signatures)
      || liveMetadata.dist.signatures.length === 0) {
    throw new Error("Live JavaScript npm metadata no longer matches retained signed evidence.");
  }
  const liveAttestations = await fetchBounded(liveMetadata.dist?.attestations?.url, 10 * 1024 * 1024,
    new Set(["https://registry.npmjs.org"]));
  if (!liveAttestations.bytes.equals(assets.get("npm-attestations.json").bytes)) {
    throw new Error("Live JavaScript npm Sigstore bundle differs from retained evidence.");
  }
  const liveTarball = await fetchBounded(liveMetadata.dist.tarball, 20 * 1024 * 1024,
    new Set(["https://registry.npmjs.org"]));
  if (!liveTarball.bytes.equals(archive)) throw new Error("Live JavaScript npm bytes differ from attested release bytes.");
  await auditNpmSignatures(dependency.package, dependency.version, packageEvidence.integrity, "javascript-audit");
  return dependencySummary(repository, tag, dependency.source_commit, releaseAttestation, assets, {
    registry: "npm",
    integrity: packageEvidence.integrity,
    tarball_sha256: packageEvidence.sha256,
    provenance_run_id: post.trusted_publisher?.provenance_origin?.run_id,
    provenance_run_attempt: post.trusted_publisher?.provenance_origin?.run_attempt,
  });
}

async function verifyIOS() {
  const dependency = compatibility.ios;
  const repository = repositorySlug(dependency.repository, "Latchway/latchway-ios-sdk");
  const tag = `v${dependency.version}`;
  verifyReleaseTag(dependency, "iOS", tag);
  const release = githubRelease(repository, tag);
  requireImmutableRelease(release, tag);
  const releaseAttestation = verifyReleaseAttestation(repository, tag);
  const archiveName = `latchway-ios-sdk-${dependency.version}.tar.gz`;
  const names = [
    archiveName,
    `${archiveName}.sha256`,
    "cocoapods-published-podspec.json",
    "cocoapods-reviewed-podspec.json",
    "cocoapods-release-evidence.json",
    "cocoapods-release-evidence.SHA256SUMS",
  ];
  requireExactReleaseAssets(release, names);
  const assets = await downloadAssets(repository, release, names, "ios");
  for (const name of names.filter((name) => name !== `${archiveName}.sha256`)) {
    verifyGitHubAttestation(repository, assets.get(name).path, dependency.source_commit);
  }
  const archiveSHA = digest(assets.get(archiveName).bytes);
  if (assets.get(`${archiveName}.sha256`).bytes.toString("utf8") !== `${archiveSHA}  ${archiveName}\n`) {
    throw new Error("iOS release checksum does not bind the source archive.");
  }
  const sums = parseSHA256SUMS(assets.get("cocoapods-release-evidence.SHA256SUMS").bytes.toString("utf8"));
  if (sums.size !== 3) throw new Error("CocoaPods evidence checksum set has unexpected entries.");
  for (const name of ["cocoapods-published-podspec.json", "cocoapods-reviewed-podspec.json", "cocoapods-release-evidence.json"]) {
    if (sums.get(name) !== digest(assets.get(name).bytes)) throw new Error(`CocoaPods evidence checksum omits ${name}.`);
  }
  const proof = await jsonAsset(assets, "cocoapods-release-evidence.json");
  const publishedSpec = await jsonAsset(assets, "cocoapods-published-podspec.json");
  const reviewedSpec = await jsonAsset(assets, "cocoapods-reviewed-podspec.json");
  if (!hasExactKeys(proof, [
    "schema_version", "kind", "status", "registry", "package", "version", "published_spec_sha256",
    "reviewed_source_archive_sha256", "published_spec_equals_reviewed_podspec",
    "reviewed_source_archive_equals_release_tag", "reviewed_spec_sha256", "source_commit", "source_tag",
    "registry_url", "source",
  ]) || proof.schema_version !== 1 || proof.kind !== "latchway_cocoapods_release_evidence"
      || proof.status !== "passed" || proof.registry !== "cocoapods" || proof.package !== "Latchway"
      || proof.version !== dependency.version || proof.source_commit !== dependency.source_commit
      || proof.source_tag !== tag || proof.reviewed_source_archive_sha256 !== archiveSHA
      || proof.published_spec_equals_reviewed_podspec !== true
      || proof.reviewed_source_archive_equals_release_tag !== true
      || proof.published_spec_sha256 !== digest(assets.get("cocoapods-published-podspec.json").bytes)
      || proof.reviewed_spec_sha256 !== digest(assets.get("cocoapods-reviewed-podspec.json").bytes)
      || !isDeepStrictEqual(publishedSpec, reviewedSpec)
      || publishedSpec.source?.git !== dependency.repository || publishedSpec.source?.tag !== tag) {
    throw new Error("Attested CocoaPods evidence does not bind exact registry metadata and locked source.");
  }
  const expectedRegistryURL = cocoaPodsURL(dependency.version);
  if (proof.registry_url !== expectedRegistryURL) throw new Error("CocoaPods evidence uses an unexpected registry URL.");
  const live = await fetchBounded(expectedRegistryURL, 2 * 1024 * 1024,
    new Set(["https://cdn.cocoapods.org"]));
  if (!live.bytes.equals(assets.get("cocoapods-published-podspec.json").bytes)) {
    throw new Error("Live CocoaPods metadata differs from the attested registry bytes.");
  }
  return dependencySummary(repository, tag, dependency.source_commit, releaseAttestation, assets, {
    registry: "cocoapods",
    source_archive_sha256: archiveSHA,
    published_spec_sha256: digest(live.bytes),
  });
}

async function verifyAndroid() {
  const dependency = compatibility.android;
  const repository = repositorySlug(dependency.repository, "Latchway/latchway-android");
  const tag = `v${dependency.version}`;
  verifyReleaseTag(dependency, "Android", tag);
  const release = githubRelease(repository, tag);
  requireImmutableRelease(release, tag);
  const releaseAttestation = verifyReleaseAttestation(repository, tag);
  const archiveName = `latchway-android-${dependency.version}-maven-repository.zip`;
  const required = [
    archiveName,
    "SHA256SUMS",
    "latchway-maven-signing-public-key.asc",
    "maven-central-upload-intent.json",
    "maven-central-deployment.json",
    "maven-central-deployment-status.json",
    "maven-central-release-evidence.json",
  ];
  requireExactReleaseAssets(release, required);
  const assets = await downloadAssets(repository, release, required, "android");
  for (const name of required) {
    verifyGitHubAttestation(repository, assets.get(name).path, dependency.source_commit);
  }
  const sums = parseSHA256SUMS(assets.get("SHA256SUMS").bytes.toString("utf8"));
  const checksumTargets = required.filter((name) => name !== "SHA256SUMS");
  if (sums.size !== checksumTargets.length
      || checksumTargets.some((name) => sums.get(name) !== digest(assets.get(name).bytes))) {
    throw new Error("Android SHA256SUMS does not bind every exact fixed release asset.");
  }
  const proof = await jsonAsset(assets, "maven-central-release-evidence.json");
  const uploadIntent = await jsonAsset(assets, "maven-central-upload-intent.json");
  const deployment = await jsonAsset(assets, "maven-central-deployment.json");
  const deploymentStatus = await jsonAsset(assets, "maven-central-deployment-status.json");
  const reviewedRepository = inspectMavenRepositoryArchive(assets.get(archiveName).path);
  const expectedPURLs = expectedMavenPURLs(dependency.version);
  const intentSHA = digest(assets.get("maven-central-upload-intent.json").bytes);
  const recordSHA = digest(assets.get("maven-central-deployment.json").bytes);
  const statusSHA = digest(assets.get("maven-central-deployment-status.json").bytes);
  if (!hasExactKeys(uploadIntent, [
    "schema", "repository", "source_commit", "release_tag", "version", "namespace", "deployment_name",
    "publishing_type", "reviewed_repository_archive_sha256", "reviewed_repository_manifest_sha256",
    "reviewed_repository_file_count", "reviewed_public_key_sha256", "expected_purls", "authorization",
  ]) || !hasExactKeys(proof, [
    "schema_version", "registry", "namespace", "version", "reviewed_repository",
    "primary_artifacts_byte_identical", "checksum_files_byte_identical", "signature_files_present",
    "signatures_cryptographically_verified", "signing_fingerprint", "reviewed_public_key_sha256",
    "deployment", "files",
  ]) || uploadIntent.schema !== "latchway.maven-central-upload-intent.v1"
      || uploadIntent.repository !== "Latchway/latchway-android"
      || uploadIntent.source_commit !== dependency.source_commit || uploadIntent.release_tag !== tag
      || uploadIntent.version !== dependency.version || uploadIntent.namespace !== "dev.latchway"
      || uploadIntent.publishing_type !== "automatic" || uploadIntent.authorization !== "single_upload_only"
      || uploadIntent.reviewed_repository_archive_sha256 !== digest(assets.get(archiveName).bytes)
      || uploadIntent.reviewed_repository_manifest_sha256 !== reviewedRepository.manifestSHA256
      || uploadIntent.reviewed_repository_file_count !== reviewedRepository.files.size
      || uploadIntent.reviewed_public_key_sha256 !== digest(assets.get("latchway-maven-signing-public-key.asc").bytes)
      || !isDeepStrictEqual(uploadIntent.expected_purls, expectedPURLs)
      || proof.schema_version !== 1 || proof.registry !== "maven_central" || proof.namespace !== "dev.latchway"
      || proof.version !== dependency.version || proof.reviewed_repository !== true
      || proof.primary_artifacts_byte_identical !== true || proof.checksum_files_byte_identical !== true
      || proof.signature_files_present !== true
      || proof.reviewed_public_key_sha256 !== digest(assets.get("latchway-maven-signing-public-key.asc").bytes)
      || proof.signatures_cryptographically_verified !== true || !Array.isArray(proof.files) || proof.files.length === 0) {
    throw new Error("Attested Maven Central evidence does not bind exact signed registry bytes and locked source.");
  }
  if (!hasExactKeys(deployment, [
    "schema", "intent_sha256", "deployment_id", "deployment_name", "publishing_type", "namespace", "version",
    "source_commit", "expected_purls",
  ]) || !hasExactKeys(deploymentStatus, [
    "schema", "intent_sha256", "record_sha256", "deployment_id", "deployment_name", "deployment_state", "purls",
  ]) || !hasExactKeys(proof.deployment, ["intent_sha256", "record_sha256", "status_sha256", "record", "status"])
      || deployment.schema !== "latchway.maven-central-deployment.v1" || deployment.intent_sha256 !== intentSHA
      || deployment.deployment_name !== uploadIntent.deployment_name
      || deployment.publishing_type !== uploadIntent.publishing_type
      || deployment.namespace !== uploadIntent.namespace || deployment.version !== uploadIntent.version
      || deployment.source_commit !== uploadIntent.source_commit
      || !isDeepStrictEqual(deployment.expected_purls, expectedPURLs)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(deployment.deployment_id)
      || deploymentStatus.schema !== "latchway.maven-central-deployment-status.v1"
      || deploymentStatus.intent_sha256 !== intentSHA || deploymentStatus.record_sha256 !== recordSHA
      || deploymentStatus.deployment_id !== deployment.deployment_id
      || deploymentStatus.deployment_name !== deployment.deployment_name
      || deploymentStatus.deployment_state !== "PUBLISHED"
      || !isDeepStrictEqual(deploymentStatus.purls, [...expectedPURLs].sort())
      || proof.deployment?.intent_sha256 !== intentSHA
      || proof.deployment?.record_sha256 !== recordSHA
      || proof.deployment?.status_sha256 !== statusSHA
      || !isDeepStrictEqual(proof.deployment.record, deployment)
      || !isDeepStrictEqual(proof.deployment.status, deploymentStatus)) {
    throw new Error("Maven Central evidence does not bind the exact deployment and terminal status.");
  }
  const expectedPrimaryPaths = new Set(expectedMavenPrimaryPaths(dependency.version));
  if (proof.files.length !== expectedPrimaryPaths.size) {
    throw new Error("Maven Central evidence does not enumerate every exact primary artifact.");
  }
  const gpgHome = await prepareGPGVerifier(
    assets.get("latchway-maven-signing-public-key.asc").path,
    proof.signing_fingerprint,
  );
  const seen = new Set();
  for (const [index, file] of proof.files.entries()) {
    if (!hasExactKeys(file, [
      "path", "sha256", "bytes", "signature_sha256", "signature_bytes", "signature_armored", "gpg_status",
      "checksums", "checksums_byte_identical",
    ]) || !hasExactKeys(file.gpg_status, [
      "schema_version", "primary_fingerprint", "signing_fingerprint", "status_lines",
    ]) || typeof file.path !== "string" || !/^[-A-Za-z0-9._/]+$/u.test(file.path) || seen.has(file.path)
        || !expectedPrimaryPaths.has(file.path)
        || !/^[0-9a-f]{64}$/u.test(file.sha256) || !/^[0-9a-f]{64}$/u.test(file.signature_sha256)
        || !Number.isInteger(file.bytes) || file.bytes < 1 || !Number.isInteger(file.signature_bytes)
        || file.signature_bytes < 1 || typeof file.signature_armored !== "string"
        || digest(Buffer.from(file.signature_armored, "ascii")) !== file.signature_sha256
        || file.gpg_status?.schema_version !== 1
        || file.gpg_status?.primary_fingerprint !== proof.signing_fingerprint
        || !/^[0-9A-F]{40}$/u.test(file.gpg_status?.signing_fingerprint)
        || !Array.isArray(file.gpg_status?.status_lines)
        || file.gpg_status.status_lines.length === 0 || file.gpg_status.status_lines.length > 64
        || file.gpg_status.status_lines.some((line) => typeof line !== "string" || line.length > 2048
          || !line.startsWith("[GNUPG:] "))
        || !file.gpg_status.status_lines.some((line) => line.startsWith(
          `[GNUPG:] VALIDSIG ${file.gpg_status.signing_fingerprint} `,
        ))
        || file.checksums_byte_identical !== true || !Array.isArray(file.checksums)
        || file.checksums.length !== 4) {
      throw new Error("Maven Central evidence contains an invalid or duplicate signed file.");
    }
    seen.add(file.path);
    const live = await fetchBounded(`https://repo1.maven.org/maven2/dev/latchway/${file.path}`,
      20 * 1024 * 1024, new Set(["https://repo1.maven.org"]));
    const reviewed = reviewedRepository.files.get(`dev/latchway/${file.path}`);
    if (file.bytes !== live.bytes.byteLength || !Buffer.isBuffer(reviewed) || !reviewed.equals(live.bytes)
        || digest(live.bytes) !== file.sha256) {
      throw new Error(`Maven Central bytes differ from the reviewed repository for ${file.path}.`);
    }
    const signature = await fetchBounded(`https://repo1.maven.org/maven2/dev/latchway/${file.path}.asc`,
      512 * 1024, new Set(["https://repo1.maven.org"]));
    if (file.signature_bytes !== signature.bytes.byteLength
        || !signature.bytes.equals(Buffer.from(file.signature_armored, "ascii"))
        || digest(signature.bytes) !== file.signature_sha256) {
      throw new Error(`Maven Central signature differs for ${file.path}.`);
    }
    await verifyDetachedSignature(gpgHome, index, live.bytes, signature.bytes, file.gpg_status);
    const checksumAlgorithms = new Set();
    for (const checksum of file.checksums) {
      if (!hasExactKeys(checksum, ["algorithm", "path", "bytes", "sha256", "published_digest"])
          || !new Set(["md5", "sha1", "sha256", "sha512"]).has(checksum.algorithm)
          || checksumAlgorithms.has(checksum.algorithm)
          || checksum.path !== `${file.path}.${checksum.algorithm}` || !/^[0-9a-f]{64}$/u.test(checksum.sha256)
          || !Number.isInteger(checksum.bytes) || checksum.bytes < 1 || typeof checksum.published_digest !== "string") {
        throw new Error(`Maven Central checksum evidence is invalid for ${file.path}.`);
      }
      checksumAlgorithms.add(checksum.algorithm);
      const liveChecksum = await fetchBounded(`https://repo1.maven.org/maven2/dev/latchway/${checksum.path}`,
        1024, new Set(["https://repo1.maven.org"]));
      const reviewedChecksum = reviewedRepository.files.get(`dev/latchway/${checksum.path}`);
      const calculated = createHash(checksum.algorithm).update(live.bytes).digest("hex");
      if (checksum.bytes !== liveChecksum.bytes.byteLength || !Buffer.isBuffer(reviewedChecksum)
          || !reviewedChecksum.equals(liveChecksum.bytes) || digest(liveChecksum.bytes) !== checksum.sha256
          || checksum.published_digest !== calculated
          || liveChecksum.bytes.toString("ascii").trim() !== checksum.published_digest) {
        throw new Error(`Maven Central checksum bytes differ for ${checksum.path}.`);
      }
    }
  }
  return dependencySummary(repository, tag, dependency.source_commit, releaseAttestation, assets, {
    registry: "maven_central",
    repository_archive_sha256: digest(assets.get(archiveName).bytes),
    signing_fingerprint: proof.signing_fingerprint,
  });
}

function expectedMavenPURLs(version) {
  return ["latchway-core", "latchway-okhttp", "latchway-play-integrity", "latchway-firebase-auth", "latchway-bom"]
    .map((module) => `pkg:maven/dev.latchway/${module}@${version}`);
}

function expectedMavenPrimaryPaths(version) {
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

function inspectMavenRepositoryArchive(archive) {
  const listing = execFileSync("unzip", ["-Z1", archive], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const rawNames = listing.split("\n").filter(Boolean);
  if (rawNames.length === 0 || rawNames.length > 10_000) {
    throw new Error("Reviewed Maven repository ZIP has an invalid entry count.");
  }
  const files = new Map();
  for (const rawName of rawNames) {
    const name = rawName.replace(/^\.\//u, "");
    if (!/^dev\/latchway\/(?:[-A-Za-z0-9._]+\/)*[-A-Za-z0-9._]+$/u.test(name)
        || files.has(name) || name.includes("..")) {
      throw new Error(`Reviewed Maven repository ZIP contains an unsafe or duplicate path: ${name}.`);
    }
    const bytes = execFileSync("unzip", ["-p", archive, rawName], {
      encoding: "buffer", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (bytes.byteLength === 0 || bytes.byteLength > 20 * 1024 * 1024) {
      throw new Error(`Reviewed Maven repository entry has an invalid size: ${name}.`);
    }
    files.set(name, bytes);
  }
  const rows = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, bytes]) => ({ bytes: bytes.byteLength, path, sha256: digest(bytes) }));
  return {
    files,
    manifestSHA256: digest(Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, "utf8")),
  };
}

async function prepareGPGVerifier(publicKey, expectedFingerprint) {
  if (!/^[0-9A-F]{40}$/u.test(expectedFingerprint)) {
    throw new Error("Maven Central evidence has an invalid reviewed signing fingerprint.");
  }
  const home = join(temporary, "android-gpg");
  await mkdir(home, { mode: 0o700 });
  execFileSync("gpg", ["--batch", "--homedir", home, "--import", publicKey], {
    stdio: ["ignore", "ignore", "pipe"], maxBuffer: 1024 * 1024,
  });
  const listing = execFileSync("gpg", ["--batch", "--homedir", home, "--with-colons", "--fingerprint",
    expectedFingerprint], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
  const observed = listing.split("\n").map((line) => line.split(":"))
    .find((fields) => fields[0] === "fpr")?.[9];
  if (observed !== expectedFingerprint) {
    throw new Error("Reviewed Maven signing key does not match the attested fingerprint.");
  }
  return home;
}

async function verifyDetachedSignature(home, index, artifactBytes, signatureBytes, retainedStatus) {
  const artifact = join(temporary, `android-central-${index}.artifact`);
  const signature = join(temporary, `android-central-${index}.asc`);
  await writeFile(artifact, artifactBytes, { mode: 0o600, flag: "wx" });
  await writeFile(signature, signatureBytes, { mode: 0o600, flag: "wx" });
  const status = execFileSync("gpg", ["--batch", "--homedir", home, "--status-fd", "1", "--verify",
    signature, artifact], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024 });
  const valid = status.split("\n").filter((line) => line.startsWith("[GNUPG:] VALIDSIG "));
  if (valid.length !== 1) throw new Error("Independent GnuPG verification did not return one VALIDSIG result.");
  const fields = valid[0].split(/ +/u).slice(2);
  if (!new Set([9, 10]).has(fields.length)) throw new Error("Independent GnuPG VALIDSIG is malformed.");
  const signingFingerprint = fields[0];
  const primaryFingerprint = fields.length === 10 ? fields[9] : signingFingerprint;
  if (signingFingerprint !== retainedStatus.signing_fingerprint
      || primaryFingerprint !== retainedStatus.primary_fingerprint) {
    throw new Error("Independent GnuPG verification differs from retained signature proof.");
  }
}

function githubRelease(repository, tag) {
  const output = execFileSync("gh", ["api", "-H", "X-GitHub-Api-Version: 2026-03-10",
    `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const release = JSON.parse(output);
  if (!Array.isArray(release.assets)) throw new Error(`${repository} returned invalid release metadata.`);
  return release;
}

function requireImmutableRelease(release, tag) {
  if (release.tag_name !== tag || release.draft !== false || release.immutable !== true) {
    throw new Error(`GitHub release ${tag} is not finalized and immutable.`);
  }
}

function requireExactReleaseAssets(release, names) {
  const expected = [...names].sort();
  const observed = release.assets.map((asset) => asset.name).sort();
  if (new Set(expected).size !== expected.length || !isDeepStrictEqual(observed, expected)) {
    throw new Error(`GitHub release ${release.tag_name} does not contain the exact fixed asset set.`);
  }
}

function verifyReleaseAttestation(repository, tag) {
  return captureGHVerification(
    ["release", "verify", tag, "--repo", repository, "--format", "json"],
    `${repository}@${tag} immutable release attestation`,
  );
}

function verifyReleaseAsset(repository, tag, path) {
  return captureGHVerification(
    ["release", "verify-asset", tag, path, "--repo", repository, "--format", "json"],
    `${repository}@${tag} immutable release asset attestation`,
  );
}

function captureGHVerification(arguments_, label) {
  const bytes = execFileSync("gh", arguments_, {
    encoding: "buffer", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  if (bytes.byteLength === 0 || bytes.byteLength > 4 * 1024 * 1024) {
    throw new Error(`${label} returned an invalid amount of evidence.`);
  }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`${label} did not return JSON.`); }
  if (value === null || typeof value !== "object" || Object.keys(value).length === 0) {
    throw new Error(`${label} returned empty evidence.`);
  }
  return { bytes: bytes.byteLength, sha256: digest(bytes) };
}

async function downloadAssets(repository, release, names, directory) {
  const result = new Map();
  const root = join(temporary, directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const name of names) {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1 || !Number.isInteger(matches[0].id) || matches[0].state !== "uploaded") {
      throw new Error(`${repository} release asset ${name} is missing or ambiguous.`);
    }
    const bytes = execFileSync("gh", ["api", "--method", "GET", "-H", "Accept: application/octet-stream",
      "-H", "X-GitHub-Api-Version: 2026-03-10",
      `repos/${repository}/releases/assets/${matches[0].id}`], {
      encoding: "buffer", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    if (bytes.byteLength === 0 || bytes.byteLength !== matches[0].size) {
      throw new Error(`${repository} release asset ${name} has invalid downloaded bytes.`);
    }
    const observed = digest(bytes);
    if (matches[0].digest !== undefined && matches[0].digest !== null
        && matches[0].digest !== "" && matches[0].digest !== `sha256:${observed}`) {
      throw new Error(`${repository} release asset ${name} digest differs from downloaded bytes.`);
    }
    const path = join(root, name);
    await writeFile(path, bytes, { mode: 0o600 });
    const immutableAttestation = verifyReleaseAsset(repository, release.tag_name, path);
    result.set(name, { path, bytes, sha256: observed, immutableAttestation });
  }
  return result;
}

function verifyGitHubAttestation(repository, path, sourceCommit) {
  execFileSync("gh", ["attestation", "verify", path,
    "--repo", repository,
    "--signer-workflow", `${repository}/.github/workflows/release.yml`,
    "--source-ref", "refs/heads/main",
    "--source-digest", sourceCommit,
    "--deny-self-hosted-runners"], { stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024 });
}

function exactlyOne(attestations, predicateType) {
  const matches = attestations.filter((entry) => entry?.predicateType === predicateType);
  if (matches.length !== 1) throw new Error(`Expected exactly one npm attestation for ${predicateType}.`);
  return matches[0];
}

function decodeNpmStatement(attestation) {
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json"
      || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0
      || typeof envelope.payload !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.payload)) {
    throw new Error("Retained npm Sigstore DSSE envelope is malformed.");
  }
  const bytes = Buffer.from(envelope.payload, "base64");
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    throw new Error("Retained npm attestation statement has an invalid size.");
  }
  try { return JSON.parse(bytes.toString("utf8")); } catch {
    throw new Error("Retained npm attestation statement is not JSON.");
  }
}

function verifyNpmWorkflowCertificate(attestation, repositoryURL) {
  const encoded = attestation?.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Retained npm provenance bundle is missing its signing certificate.");
  }
  const certificate = new X509Certificate(Buffer.from(encoded, "base64"));
  if (certificate.subjectAltName !== `URI:${repositoryURL}/${WORKFLOW_PATH}@${SOURCE_REF}`) {
    throw new Error("Retained npm provenance certificate has an unexpected workflow identity.");
  }
}

async function jsonAsset(assets, name) {
  const bytes = assets.get(name)?.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > 10 * 1024 * 1024) throw new Error(`Invalid JSON asset ${name}.`);
  try { return JSON.parse(bytes.toString("utf8")); } catch { throw new Error(`Release asset ${name} is not JSON.`); }
}

function verifyReleaseTag(dependency, label, explicitTag) {
  const tag = explicitTag ?? `v${dependency.version}`;
  const output = execFileSync("git", ["ls-remote", dependency.repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  }).trim();
  if (output.length === 0) throw new Error(`${label} release tag ${tag} does not exist.`);
  const lines = output.split("\n").map((line) => line.split(/\s+/u));
  const peeled = lines.find(([, reference]) => reference === `refs/tags/${tag}^{}`)?.[0];
  const direct = lines.find(([, reference]) => reference === `refs/tags/${tag}`)?.[0];
  if ((peeled ?? direct) !== dependency.source_commit) throw new Error(`${label} release tag commit mismatch.`);
}

async function auditNpmSignatures(packageName, version, integrity, directory) {
  const root = join(temporary, directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "latchway-dependency-signature-audit", version: "0.0.0", private: true,
    dependencies: { [packageName]: version },
  }, null, 2)}\n`);
  const npmrc = join(root, ".npmrc");
  await writeFile(npmrc, "registry=https://registry.npmjs.org/\nfund=false\n", { mode: 0o600 });
  const environment = sanitizedNpmEnvironment(npmrc, join(root, ".npm-cache"));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
  const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
  if (lock.packages?.[`node_modules/${packageName}`]?.integrity !== integrity) {
    throw new Error("npm signature audit installed a different dependency integrity.");
  }
  execFileSync("npm", ["audit", "signatures", "--json", "--registry=https://registry.npmjs.org/"], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
}

function sanitizedNpmEnvironment(userconfig, cache) {
  const excluded = new Set(["NODE_AUTH_TOKEN", "NPM_TOKEN", "npm_config__auth", "npm_config_auth",
    "npm_config__authToken", "NPM_CONFIG__AUTH", "NPM_CONFIG_AUTH"]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !excluded.has(name))),
    NPM_CONFIG_USERCONFIG: userconfig,
    NPM_CONFIG_CACHE: cache,
  };
}

async function fetchBounded(rawURL, maximumBytes, allowedOrigins) {
  const url = new URL(rawURL);
  if (url.protocol !== "https:" || !allowedOrigins.has(url.origin) || url.username !== "" || url.password !== ""
      || url.search !== "" || url.hash !== "") throw new Error(`Untrusted public registry URL ${url.origin}.`);
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
  if (response.status !== 200) throw new Error(`Public registry returned HTTP ${response.status}.`);
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maximumBytes) throw new Error("Public registry output exceeds limit.");
  if (response.body === null) throw new Error("Public registry returned no response body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new Error("Public registry output exceeds limit.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  if (bytes.byteLength === 0) throw new Error("Public registry returned an empty response.");
  return { response, bytes };
}

function cocoaPodsURL(version) {
  const md5 = createHash("md5").update("Latchway").digest("hex");
  return `https://cdn.cocoapods.org/Specs/${md5[0]}/${md5[1]}/${md5[2]}/Latchway/${version}/Latchway.podspec.json`;
}

function parseSHA256SUMS(text) {
  const result = new Map();
  for (const line of text.split("\n").filter(Boolean)) {
    const match = /^([0-9a-f]{64}) {2}([A-Za-z0-9._-]+)$/u.exec(line);
    if (match === null || result.has(match[2])) throw new Error("Invalid or duplicate SHA256SUMS entry.");
    result.set(match[2], match[1]);
  }
  return result;
}

function dependencySummary(repository, tag, sourceCommit, releaseAttestation, assets, registry) {
  return {
    repository: `https://github.com/${repository}`,
    release_tag: tag,
    source_commit: sourceCommit,
    github_release_immutable: true,
    github_release_attestation: releaseAttestation,
    release_assets: Object.fromEntries([...assets.entries()].sort(([left], [right]) => left.localeCompare(right))
      .map(([name, asset]) => [name, {
        bytes: asset.bytes.byteLength,
        sha256: asset.sha256,
        immutable_attestation: asset.immutableAttestation,
      }])),
    public_registry: registry,
  };
}

function repositorySlug(repository, expected) {
  const normalized = normalizeRepository(repository);
  if (normalized !== `https://github.com/${expected}`.toLowerCase()) throw new Error(`Unexpected repository ${repository}.`);
  return expected;
}

function normalizeRepository(repository) {
  return String(repository).replace(/^git\+/u, "").replace(/\.git$/u, "").toLowerCase();
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
