import { createHash, X509Certificate } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  accumulateMavenArchiveBytes,
  androidReleaseAssetNames,
  expectedMavenPrimaryPaths,
  validateAndroidReleaseEvidence,
  validateMavenRepositoryPathClosure,
} from "./android-release-evidence.mjs";
import { validateCocoaPodsSourceBinding } from "./ios-release-evidence.mjs";
import { readJSON, readLock, requireLockValue } from "./release-metadata.mjs";
import {
  PROVENANCE_TYPE,
  PUBLISH_TYPE,
  SOURCE_REF,
  WORKFLOW_PATH,
  verifyProvenanceStatement,
  verifyPublishStatement,
} from "./npm-release-evidence.mjs";
import {
  JAVASCRIPT_ADOPTION_PATTERN,
  MAXIMUM_JAVASCRIPT_ARCHIVE_BYTES,
  externalPeerDependencies,
  inspectNpmArchive,
  validateCleanJavascriptConsumer,
  validateJavascriptAdoptionClosure,
  validateJavascriptAdoptionRecord,
  validateNpmArchiveMatchesLockedPack,
} from "./javascript-release-contract.mjs";
import {
  GPG_STATUS_RECORD_KEYS,
  validateGPGStatus,
  validateRetainedGPGStatus,
} from "./gpg-status.mjs";
import {
  decodeBase64Strict,
  parseStrictJSONBytes,
  readBoundedFileSync,
  readBoundedStrictJSONFileSync,
  validateReleaseAttestation,
} from "./release-attestation.mjs";
import { requireAnnotatedTagRefs } from "./release-tag.mjs";
import { validatePublishedDependencyAssetMetadata } from "./published-dependency-assets.mjs";

const NPM_REGISTRY_URL = "https://registry.npmjs.org/";
const JAVASCRIPT_RELEASE_PACKAGES = Object.freeze([
  Object.freeze({ id: "client", package: "@latchway/client" }),
  Object.freeze({ id: "openai", package: "@latchway/openai" }),
  Object.freeze({ id: "vercel-ai", package: "@latchway/vercel-ai" }),
  Object.freeze({ id: "langchain", package: "@latchway/langchain" }),
]);
const authenticatedInputs = authenticatedInputRoot();

execFileSync("python3", [fileURLToPath(new URL("./require-gh-version.py", import.meta.url))], {
  stdio: ["ignore", "ignore", "inherit"],
});

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
const gitAskpass = join(temporary, "github-git-askpass.sh");
try {
  await writeFile(gitAskpass, [
    "#!/usr/bin/env sh",
    "set -eu",
    'case "${1:-}" in',
    "  *github.com*Username*|*Username*github.com*) printf '%s\\n' x-access-token ;;",
    '  *github.com*Password*|*Password*github.com*) test -n "${GH_TOKEN:-}"; printf \'%s\\n\' "$GH_TOKEN" ;;',
    "  *) exit 1 ;;",
    "esac",
    "",
  ].join("\n"), { mode: 0o700, flag: "wx" });
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
  if (dependency.package !== JAVASCRIPT_RELEASE_PACKAGES[0].package) {
    throw new Error("The React Native JavaScript dependency must be the client entry in the fixed release set.");
  }
  verifyReleaseTag(dependency, "JavaScript", tag);
  const release = githubRelease(repository, tag);
  requireImmutableRelease(release, tag);
  const packages = JAVASCRIPT_RELEASE_PACKAGES.map((entry) => ({
    ...entry,
    version: dependency.version,
    tarball: `latchway-${entry.id}-${dependency.version}.tgz`,
    registryVersion: `npm-${entry.id}-registry-version.json`,
    registryView: `npm-${entry.id}-registry-view.json`,
    attestations: `npm-${entry.id}-attestations.json`,
    auditSignatures: `npm-${entry.id}-audit-signatures.json`,
  }));
  const fixed = [
    ...packages.map((entry) => entry.tarball),
    `docs-bundle-${dependency.version}.tar.gz`,
    "SHA256SUMS",
    "build-reproducibility.json",
    "contract-evidence.json",
    "dependency-vulnerability-scan.json",
    "package-evidence.json",
    "post-publish-evidence.json",
    "publish-input-evidence.json",
    "release-candidate-evidence.json",
    "tag-evidence.json",
    "npm-registry-evidence-manifest.json",
    ...packages.flatMap((entry) => [
      entry.registryVersion, entry.registryView, entry.attestations, entry.auditSignatures,
    ]),
  ];
  if (fixed.length !== 31 || new Set(fixed).size !== fixed.length) {
    throw new Error("The JavaScript fixed release asset contract is not exactly 31 unique assets.");
  }
  const adoptions = release.assets.map((asset) => asset.name)
    .filter((name) => JAVASCRIPT_ADOPTION_PATTERN.test(name)).sort();
  validateJavascriptAdoptionClosure(adoptions, packages.map((entry) => entry.id));
  requireExactReleaseAssets(release, [...fixed, ...adoptions]);
  const assets = await downloadAssets(repository, release, [...fixed, ...adoptions], "javascript");
  const releaseAttestation = verifyImmutableReleaseAttestations(
    repository, tag, dependency.source_commit, assets,
  );
  for (const name of [...fixed, ...adoptions]) {
    verifyGitHubAttestation(repository, assets.get(name).path, dependency.source_commit);
  }

  const packageSet = await jsonAsset(assets, "package-evidence.json");
  const post = await jsonAsset(assets, "post-publish-evidence.json");
  const manifest = await jsonAsset(assets, "npm-registry-evidence-manifest.json");
  const publishInput = await jsonAsset(assets, "publish-input-evidence.json");
  const reproducibility = await jsonAsset(assets, "build-reproducibility.json");
  const contractEvidence = await jsonAsset(assets, "contract-evidence.json");
  const releaseCandidate = await jsonAsset(assets, "release-candidate-evidence.json");
  const tagEvidence = await jsonAsset(assets, "tag-evidence.json");
  const vulnerabilityEvidence = await jsonAsset(assets, "dependency-vulnerability-scan.json");
  const expectedOrder = packages.map((entry) => entry.package);
  const reviewedReproducibility = await inspectJavascriptReproducibility(packages, dependency.source_commit);
  if (!hasExactKeys(packageSet, [
    "schema_version", "kind", "version", "package_count", "publish_order", "packages", "consumer",
  ]) || packageSet.schema_version !== 2 || packageSet.kind !== "latchway_npm_package_set_evidence"
      || packageSet.version !== dependency.version || packageSet.package_count !== packages.length
      || !isDeepStrictEqual(packageSet.publish_order, expectedOrder)
      || !Array.isArray(packageSet.packages) || packageSet.packages.length !== packages.length) {
    throw new Error("JavaScript package-set evidence does not bind the exact four-package release order.");
  }
  validatePackageSetConsumer(packageSet.consumer, packages, { typescript: true, peerSource: "reviewed" });
  const packageEvidenceByName = new Map();
  const checksumLines = [];
  for (const [index, package_] of packages.entries()) {
    const packageEvidence = packageSet.packages[index];
    if (!hasExactKeys(packageEvidence, [
      "id", "package", "version", "tarball", "bytes", "sha1", "sha256", "sha512", "integrity",
      "double_pack_byte_identical", "archive_allowlist_verified", "archive_regular_files_only",
      "credential_scan", "entries", "unpacked_bytes", "published_peer_dependencies",
    ]) || packageEvidence.id !== package_.id || packageEvidence.package !== package_.package
        || packageEvidence.version !== dependency.version || packageEvidence.tarball !== package_.tarball
        || !Number.isSafeInteger(packageEvidence.bytes) || packageEvidence.bytes < 1
        || !/^[0-9a-f]{40}$/u.test(packageEvidence.sha1)
        || !/^[0-9a-f]{64}$/u.test(packageEvidence.sha256)
        || !/^[0-9a-f]{128}$/u.test(packageEvidence.sha512)
        || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(packageEvidence.integrity)
        || packageEvidence.double_pack_byte_identical !== true
        || packageEvidence.archive_allowlist_verified !== true
        || packageEvidence.archive_regular_files_only !== true
        || packageEvidence.credential_scan !== "passed"
        || !Array.isArray(packageEvidence.entries) || packageEvidence.entries.length === 0
        || new Set(packageEvidence.entries).size !== packageEvidence.entries.length
        || !Number.isSafeInteger(packageEvidence.unpacked_bytes) || packageEvidence.unpacked_bytes < 1
        || packageEvidence.published_peer_dependencies === null
        || typeof packageEvidence.published_peer_dependencies !== "object"
        || Array.isArray(packageEvidence.published_peer_dependencies)) {
      throw new Error(`JavaScript package-set evidence does not bind ${package_.package}.`);
    }
    const archive = assets.get(package_.tarball).bytes;
    const observed = npmArchiveDigest(archive);
    if (archive.byteLength !== packageEvidence.bytes
        || !isDeepStrictEqual(observed, {
          sha1: packageEvidence.sha1,
          sha256: packageEvidence.sha256,
          sha512: packageEvidence.sha512,
          integrity: packageEvidence.integrity,
        })) {
      throw new Error(`JavaScript GitHub archive hash mismatch for ${package_.package}.`);
    }
    validateNpmArchiveMatchesLockedPack(
      archive, reviewedReproducibility.packedArchives.get(package_.package), package_,
    );
    inspectNpmArchive(assets.get(package_.tarball).path, package_, packageEvidence, reviewedReproducibility);
    packageEvidenceByName.set(package_.package, packageEvidence);
    checksumLines.push(`${packageEvidence.sha256}  ${package_.tarball}`);
  }
  if (packageEvidenceByName.size !== packages.length
      || assets.get("SHA256SUMS").bytes.toString("utf8") !== `${checksumLines.sort().join("\n")}\n`) {
    throw new Error("JavaScript SHA256SUMS does not exactly bind all four reviewed package archives.");
  }

  if (!hasExactKeys(manifest, [
    "schema_version", "kind", "version", "package_count", "publish_order", "packages",
  ]) || manifest.schema_version !== 2
      || manifest.kind !== "latchway_npm_registry_package_set_evidence_manifest"
      || manifest.version !== dependency.version || manifest.package_count !== packages.length
      || !isDeepStrictEqual(manifest.publish_order, expectedOrder)
      || !Array.isArray(manifest.packages) || manifest.packages.length !== packages.length) {
    throw new Error("JavaScript registry package-set manifest has an unexpected schema or release order.");
  }
  const manifestPackages = new Map();
  for (const [index, package_] of packages.entries()) {
    const packageEvidence = packageEvidenceByName.get(package_.package);
    const entry = manifest.packages[index];
    const expectedEvidenceNames = [
      package_.registryVersion, package_.registryView, package_.attestations, package_.auditSignatures,
    ].sort();
    if (!hasExactKeys(entry, ["id", "package", "version", "tarball", "evidence"])
        || !hasExactKeys(entry.tarball, ["name", "bytes", "sha256", "sha512", "integrity"])
        || entry.id !== package_.id || entry.package !== package_.package || entry.version !== dependency.version
        || !isDeepStrictEqual(entry.tarball, {
          name: package_.tarball,
          bytes: packageEvidence.bytes,
          sha256: packageEvidence.sha256,
          sha512: packageEvidence.sha512,
          integrity: packageEvidence.integrity,
        }) || !Array.isArray(entry.evidence) || entry.evidence.length !== 4
        || !isDeepStrictEqual(entry.evidence.map((item) => item?.name), expectedEvidenceNames)) {
      throw new Error(`JavaScript registry package-set manifest does not bind ${package_.package}.`);
    }
    const evidenceNames = new Set();
    for (const retained of entry.evidence) {
      const asset = assets.get(retained?.name);
      if (!hasExactKeys(retained, ["name", "bytes", "sha256"])
          || evidenceNames.has(retained.name) || asset === undefined
          || retained.bytes !== asset.bytes.byteLength || retained.sha256 !== digest(asset.bytes)) {
        throw new Error(`JavaScript registry manifest has invalid retained evidence for ${package_.package}.`);
      }
      evidenceNames.add(retained.name);
    }
    manifestPackages.set(package_.package, entry);
  }
  if (manifestPackages.size !== packages.length) {
    throw new Error("JavaScript registry package-set manifest contains duplicate package entries.");
  }

  validateJavascriptPublishInput(publishInput, packages, packageEvidenceByName, assets, dependency, tag);
  validateJavascriptContractEvidence(contractEvidence, compatibility, contractLock);
  validateJavascriptSupportingEvidence({
    reproducibility, releaseCandidate, tagEvidence, vulnerabilityEvidence,
  }, packages, dependency, tag, reviewedReproducibility);
  const expectedRepositoryURL = "https://github.com/Latchway/latchway-js";
  const sourceBinding = {
    repository: expectedRepositoryURL,
    commit: dependency.source_commit,
    workflow: WORKFLOW_PATH,
    ref: SOURCE_REF,
  };
  if (!hasExactKeys(post, [
    "schema_version", "kind", "version", "package_count", "publish_order", "source", "release_tag",
    "registry", "packages", "evidence_manifest",
  ]) || post.schema_version !== 3 || post.kind !== "latchway_npm_package_set_publication_evidence"
      || post.version !== dependency.version || post.package_count !== packages.length
      || !isDeepStrictEqual(post.publish_order, expectedOrder) || !isDeepStrictEqual(post.source, sourceBinding)
      || post.release_tag !== tag || post.registry !== NPM_REGISTRY_URL
      || !Array.isArray(post.packages) || post.packages.length !== packages.length
      || !isDeepStrictEqual(post.evidence_manifest, {
        file: "npm-registry-evidence-manifest.json",
        bytes: assets.get("npm-registry-evidence-manifest.json").bytes.byteLength,
        sha256: digest(assets.get("npm-registry-evidence-manifest.json").bytes),
      })) {
    throw new Error("JavaScript npm package-set evidence does not bind registry outputs and locked source.");
  }

  const publicationPackages = new Map();
  const retainedByPackage = new Map();
  for (const [index, package_] of packages.entries()) {
    const packageEvidence = packageEvidenceByName.get(package_.package);
    const manifestEntry = manifestPackages.get(package_.package);
    const publication = post.packages[index];
    const expectedRetainedNames = manifestEntry.evidence.map((entry) => entry.name).sort();
    if (!hasExactKeys(publication, [
      "id", "package", "version", "publication_mode", "tarball", "trusted_publisher",
      "registry_signature_verification", "clean_consumer", "retained_outputs",
    ]) || publication.id !== package_.id || publication.package !== package_.package
        || publication.version !== dependency.version
        || publication.publication_mode !== "published"
        || !isDeepStrictEqual(publication.tarball, {
          ...manifestEntry.tarball,
          registry_bytes_sha256: packageEvidence.sha256,
        }) || !isDeepStrictEqual(Object.keys(publication.retained_outputs ?? {}).sort(), expectedRetainedNames)) {
      throw new Error(`JavaScript publication evidence does not bind ${package_.package}.`);
    }
    for (const name of expectedRetainedNames) {
      if (!isDeepStrictEqual(publication.retained_outputs[name], {
        bytes: assets.get(name).bytes.byteLength,
        sha256: digest(assets.get(name).bytes),
      })) throw new Error(`JavaScript publication evidence does not bind ${name}.`);
    }
    if (!hasExactKeys(publication.trusted_publisher, [
      "provider", "provenance_predicate_type", "provenance_origin", "sigstore_bundle",
    ]) || !hasExactKeys(publication.trusted_publisher.sigstore_bundle, ["file", "bytes", "sha256"])
        || publication.trusted_publisher.provider !== "github"
        || publication.trusted_publisher.provenance_predicate_type !== PROVENANCE_TYPE
        || publication.trusted_publisher.sigstore_bundle.file !== package_.attestations
        || !isDeepStrictEqual(publication.trusted_publisher.sigstore_bundle, {
          file: package_.attestations,
          bytes: assets.get(package_.attestations).bytes.byteLength,
          sha256: digest(assets.get(package_.attestations).bytes),
        }) || !hasExactKeys(publication.registry_signature_verification, ["command", "output"])
        || publication.registry_signature_verification.command
          !== `npm audit signatures --json --registry=${NPM_REGISTRY_URL}`
        || !isDeepStrictEqual(publication.registry_signature_verification.output, {
          file: package_.auditSignatures,
          bytes: assets.get(package_.auditSignatures).bytes.byteLength,
          sha256: digest(assets.get(package_.auditSignatures).bytes),
        })) {
      throw new Error(`JavaScript trusted-publisher evidence is incomplete for ${package_.package}.`);
    }
    const expectedExternalPeers = externalPeerDependencies(packageEvidence.published_peer_dependencies, package_);
    validateCleanJavascriptConsumer(
      publication.clean_consumer, package_, dependency.version, expectedExternalPeers,
    );

    const registryMetadata = await jsonAsset(assets, package_.registryVersion);
    const npmView = await jsonAsset(assets, package_.registryView);
    const retainedAttestations = await jsonAsset(assets, package_.attestations);
    const retainedAudit = await jsonAsset(assets, package_.auditSignatures);
    const repositoryFromView = typeof npmView.repository === "object" ? npmView.repository?.url : npmView.repository;
    for (const value of [registryMetadata, npmView]) {
      if (value.name !== package_.package || value.version !== dependency.version
          || value.dist?.integrity !== packageEvidence.integrity || value.dist?.shasum !== packageEvidence.sha1
          || !Array.isArray(value.dist?.signatures) || value.dist.signatures.length === 0
          || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE) {
        throw new Error(`Retained npm metadata does not bind exact signed ${package_.package} coordinates.`);
      }
    }
    if (registryMetadata._npmUser?.trustedPublisher?.id !== "github"
        || normalizeRepository(repositoryFromView) !== expectedRepositoryURL.toLowerCase()) {
      throw new Error(`Retained npm metadata does not bind the trusted publisher for ${package_.package}.`);
    }
    if (retainedAudit === null || typeof retainedAudit !== "object" || Array.isArray(retainedAudit)
        || Object.hasOwn(retainedAudit, "error")) {
      throw new Error(`Retained npm signature audit failed for ${package_.package}.`);
    }
    if (!Array.isArray(retainedAttestations.attestations)) {
      throw new Error(`Retained npm Sigstore bundle is malformed for ${package_.package}.`);
    }
    const provenance = exactlyOne(retainedAttestations.attestations, PROVENANCE_TYPE);
    const publish = exactlyOne(retainedAttestations.attestations, PUBLISH_TYPE);
    const provenanceOrigin = verifyProvenanceStatement(decodeNpmStatement(provenance), {
      packageName: package_.package,
      packageVersion: dependency.version,
      sha512: packageEvidence.sha512,
      expectedRepositoryURL,
      expectedCommit: dependency.source_commit,
      expectedEvent: "repository_dispatch",
    });
    verifyNpmWorkflowCertificate(provenance, expectedRepositoryURL);
    verifyPublishStatement(decodeNpmStatement(publish), {
      packageName: package_.package,
      packageVersion: dependency.version,
      sha512: packageEvidence.sha512,
      registryURL: NPM_REGISTRY_URL,
    });
    if (!isDeepStrictEqual(publication.trusted_publisher.provenance_origin, provenanceOrigin)) {
      throw new Error(`JavaScript provenance differs from retained Sigstore evidence for ${package_.package}.`);
    }
    retainedByPackage.set(package_.package, { packageEvidence, provenanceOrigin, expectedExternalPeers });
    publicationPackages.set(package_.package, publication);
  }
  if (publicationPackages.size !== packages.length || retainedByPackage.size !== packages.length) {
    throw new Error("JavaScript publication evidence contains duplicate package entries.");
  }

  const manifestSHA = digest(assets.get("npm-registry-evidence-manifest.json").bytes);
  for (const name of adoptions) {
    const adoption = await jsonAsset(assets, name);
    const match = JAVASCRIPT_ADOPTION_PATTERN.exec(name);
    const package_ = packages.find((entry) => entry.id === match?.[1]);
    const manifestEntry = manifestPackages.get(package_?.package);
    const provenanceOrigin = retainedByPackage.get(package_?.package)?.provenanceOrigin;
    validateJavascriptAdoptionRecord({
      name,
      adoption,
      package_,
      manifestEntry,
      provenanceOrigin,
      sourceBinding,
      version: dependency.version,
      tag,
      manifestSHA,
    });
  }

  const registrySummary = [];
  for (const package_ of packages) {
    const retained = retainedByPackage.get(package_.package);
    const liveMetadataResult = await fetchBounded(
      `https://registry.npmjs.org/${encodeURIComponent(package_.package)}/${encodeURIComponent(dependency.version)}`,
      2 * 1024 * 1024,
      new Set(["https://registry.npmjs.org"]),
    );
    const liveMetadata = parseStrictJSONBytes(
      liveMetadataResult.bytes, `Live npm metadata for ${package_.package}`, 2 * 1024 * 1024,
    );
    if (!liveMetadataResult.bytes.equals(assets.get(package_.registryVersion).bytes)
        || liveMetadata.dist?.integrity !== retained.packageEvidence.integrity
        || liveMetadata.dist?.shasum !== retained.packageEvidence.sha1
        || liveMetadata._npmUser?.trustedPublisher?.id !== "github"
        || !Array.isArray(liveMetadata.dist?.signatures) || liveMetadata.dist.signatures.length === 0) {
      throw new Error(`Live JavaScript npm metadata no longer matches retained ${package_.package} evidence.`);
    }
    const liveAttestations = await fetchBounded(liveMetadata.dist?.attestations?.url, 10 * 1024 * 1024,
      new Set(["https://registry.npmjs.org"]));
    if (!liveAttestations.bytes.equals(assets.get(package_.attestations).bytes)) {
      throw new Error(`Live JavaScript npm Sigstore bundle differs for ${package_.package}.`);
    }
    const liveTarball = await fetchBounded(liveMetadata.dist.tarball, 20 * 1024 * 1024,
      new Set(["https://registry.npmjs.org"]));
    if (!liveTarball.bytes.equals(assets.get(package_.tarball).bytes)) {
      throw new Error(`Live JavaScript npm bytes differ for ${package_.package}.`);
    }
    await auditNpmSignatures(
      package_.package,
      dependency.version,
      retained.packageEvidence.integrity,
      `javascript-${package_.id}-audit`,
      package_.id === "client" ? undefined : dependency.version,
      retained.expectedExternalPeers,
    );
    registrySummary.push({
      id: package_.id,
      package: package_.package,
      version: dependency.version,
      integrity: retained.packageEvidence.integrity,
      tarball_sha256: retained.packageEvidence.sha256,
      provenance_run_id: retained.provenanceOrigin.run_id,
      provenance_run_attempt: retained.provenanceOrigin.run_attempt,
    });
  }
  const directClient = registrySummary[0];
  return dependencySummary(repository, tag, dependency.source_commit, releaseAttestation, assets, {
    registry: "npm",
    package_count: packages.length,
    publish_order: expectedOrder,
    packages: registrySummary,
    direct_dependency: {
      package: dependency.package,
      version: dependency.version,
      integrity: directClient.integrity,
      tarball_sha256: directClient.tarball_sha256,
    },
  });
}

function validateJavascriptContractEvidence(contractEvidence, releaseCompatibility, lock) {
  const expectedFixtures = Object.entries(releaseCompatibility.contract?.fixtures ?? {})
    .map(([name, sha256]) => ({ name, sha256 }));
  if (!hasExactKeys(contractEvidence, [
    "schema_version", "contract_version", "core_release", "core_commit", "bundle_sha256",
    "wire_protocol_version", "contract_lock_sha256", "fixtures",
  ]) || contractEvidence.schema_version !== 1
      || contractEvidence.contract_version !== releaseCompatibility.contract?.version
      || contractEvidence.core_release !== requireLockValue(lock, "core_release")
      || contractEvidence.core_commit !== releaseCompatibility.contract?.core_commit
      || contractEvidence.bundle_sha256 !== releaseCompatibility.contract?.bundle_sha256
      || contractEvidence.wire_protocol_version !== releaseCompatibility.contract?.wire_protocol
      || contractEvidence.contract_lock_sha256
        !== digest(readFileSync(fileURLToPath(new URL("../contract.lock", import.meta.url))))
      || !Array.isArray(contractEvidence.fixtures)
      || contractEvidence.fixtures.length !== expectedFixtures.length
      || contractEvidence.fixtures.some((entry) => !hasExactKeys(entry, ["name", "sha256"]))
      || !isDeepStrictEqual(contractEvidence.fixtures, expectedFixtures)) {
    throw new Error("JavaScript contract evidence does not match the React Native contract lock and fixtures.");
  }
}

function validatePackageSetConsumer(consumer, packages, { typescript, peerSource }) {
  const expectedPackages = packages.map((entry) => ({ name: entry.package, version: entry.version }));
  if (!hasExactKeys(consumer, ["package_count", "packages", "node_esm", "typescript", "peer_source"])
      || consumer.package_count !== packages.length || !isDeepStrictEqual(consumer.packages, expectedPackages)
      || consumer.node_esm !== true || consumer.typescript !== typescript || consumer.peer_source !== peerSource) {
    throw new Error("JavaScript package-set consumer evidence is incomplete or has an unexpected package order.");
  }
  for (const entry of consumer.packages) {
    if (!hasExactKeys(entry, ["name", "version"])) {
      throw new Error("JavaScript package-set consumer evidence contains an unexpected package entry.");
    }
  }
}

function npmArchiveDigest(bytes) {
  const sha512 = createHash("sha512").update(bytes).digest();
  return {
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: digest(bytes),
    sha512: sha512.toString("hex"),
    integrity: `sha512-${sha512.toString("base64")}`,
  };
}

function validateJavascriptPublishInput(publishInput, packages, packageEvidenceByName, assets, dependency, tag) {
  const expectedOrder = packages.map((entry) => entry.package);
  if (!hasExactKeys(publishInput, [
    "schema_version", "kind", "version", "source_commit", "release_tag", "package_count", "publish_order",
    "packages", "verified_job_evidence", "package_evidence", "checksums", "consumer",
  ]) || publishInput.schema_version !== 2 || publishInput.kind !== "latchway_npm_publish_input_evidence"
      || publishInput.version !== dependency.version || publishInput.source_commit !== dependency.source_commit
      || publishInput.release_tag !== tag || publishInput.package_count !== packages.length
      || !isDeepStrictEqual(publishInput.publish_order, expectedOrder)
      || !Array.isArray(publishInput.packages) || publishInput.packages.length !== packages.length
      || publishInput.verified_job_evidence !== true
      || !isDeepStrictEqual(publishInput.package_evidence, {
        file: "package-evidence.json", sha256: digest(assets.get("package-evidence.json").bytes),
      }) || !isDeepStrictEqual(publishInput.checksums, {
        file: "SHA256SUMS", sha256: digest(assets.get("SHA256SUMS").bytes),
      })) {
    throw new Error("JavaScript publish-input evidence does not bind the exact reviewed package set.");
  }
  for (const [index, package_] of packages.entries()) {
    const evidence = packageEvidenceByName.get(package_.package);
    const entry = publishInput.packages[index];
    if (!hasExactKeys(entry, [
      "id", "package", "version", "tarball", "bytes", "sha1", "sha256", "sha512", "integrity",
    ]) || !isDeepStrictEqual(entry, {
      id: package_.id,
      package: package_.package,
      version: dependency.version,
      tarball: package_.tarball,
      bytes: evidence.bytes,
      sha1: evidence.sha1,
      sha256: evidence.sha256,
      sha512: evidence.sha512,
      integrity: evidence.integrity,
    })) {
      throw new Error(`JavaScript publish-input evidence differs for ${package_.package}.`);
    }
  }
  validatePackageSetConsumer(publishInput.consumer, packages, { typescript: false, peerSource: "registry" });
}

function validateJavascriptSupportingEvidence({
  reproducibility, releaseCandidate, tagEvidence, vulnerabilityEvidence,
}, packages, dependency, tag, reviewedReproducibility) {
  const expectedOrder = packages.map((entry) => entry.package);
  const expectedGates = [
    "workflow-policy", "contract-lock", "release-policy", "lint", "typecheck", "clean-build",
    "unit-tests", "offline-release-tests", "examples", "exports", "web-browser-and-bundler-conformance",
    "build-reproducibility", "package-conformance",
  ];
  if (!hasExactKeys(reproducibility, ["schema_version", "identical", "package_count", "sha256", "files"])
      || reproducibility.schema_version !== 1 || reproducibility.identical !== true
      || reproducibility.package_count !== packages.length || !/^[0-9a-f]{64}$/u.test(reproducibility.sha256)
      || !Array.isArray(reproducibility.files) || reproducibility.files.length === 0
      || !isDeepStrictEqual(reproducibility.files, reviewedReproducibility.files)
      || reproducibility.sha256 !== reviewedReproducibility.sha256) {
    throw new Error("JavaScript reproducibility evidence does not cover all four release packages.");
  }
  for (const entry of reproducibility.files) {
    if (!hasExactKeys(entry, ["package", "path", "bytes", "sha256"])
        || !expectedOrder.includes(entry.package) || typeof entry.path !== "string"
        || !/^(?:packages\/(?:openai|vercel-ai|langchain)\/)?dist\/(?:[A-Za-z0-9@._+-]+\/)*[A-Za-z0-9@._+-]+$/u
          .test(entry.path)
        || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !/^[0-9a-f]{64}$/u.test(entry.sha256)) {
      throw new Error("JavaScript reproducibility evidence contains an invalid file entry.");
    }
  }
  if (!hasExactKeys(releaseCandidate, [
    "schema_version", "package_count", "packages", "version", "source_commit", "worktree_clean",
    "stable_version", "node", "pnpm", "gates",
  ]) || releaseCandidate.schema_version !== 2 || releaseCandidate.package_count !== packages.length
      || !isDeepStrictEqual(releaseCandidate.packages, expectedOrder)
      || releaseCandidate.version !== dependency.version || releaseCandidate.source_commit !== dependency.source_commit
      || releaseCandidate.worktree_clean !== true || releaseCandidate.stable_version !== true
      || releaseCandidate.node !== "v24.19.0" || releaseCandidate.pnpm !== "10.15.0"
      || !Array.isArray(releaseCandidate.gates)
      || !isDeepStrictEqual(releaseCandidate.gates.map((gate) => gate?.name), expectedGates)
      || releaseCandidate.gates.some((gate) => !hasExactKeys(gate, ["name", "status", "duration_ms"])
        || gate.status !== "passed" || !Number.isSafeInteger(gate.duration_ms) || gate.duration_ms < 0)) {
    throw new Error("JavaScript release-candidate evidence is incomplete for the four-package source commit.");
  }
  if (!hasExactKeys(tagEvidence, ["schema_version", "tag", "version", "commit", "annotated"])
      || tagEvidence.schema_version !== 1 || tagEvidence.tag !== tag || tagEvidence.version !== dependency.version
      || tagEvidence.commit !== dependency.source_commit || tagEvidence.annotated !== true) {
    throw new Error("JavaScript tag evidence does not bind the locked four-package source commit.");
  }
  if (!hasExactKeys(vulnerabilityEvidence, [
    "schema_version", "scanner", "source_commit", "inventory_sha256", "database_sha256", "package_count",
    "vulnerability_count", "blocking_vulnerability_count", "policy", "status",
  ]) || vulnerabilityEvidence.schema_version !== "latchway.dependency-vulnerability-scan.v1"
      || !hasExactKeys(vulnerabilityEvidence.scanner, ["name", "version", "commit", "mode"])
      || vulnerabilityEvidence.scanner.name !== "OSV-Scanner"
      || vulnerabilityEvidence.scanner.version !== "2.4.0"
      || vulnerabilityEvidence.scanner.commit !== "b56b5191101d5f27d4787d5583d8d01e9518a7af"
      || vulnerabilityEvidence.scanner.mode !== "offline"
      || vulnerabilityEvidence.source_commit !== dependency.source_commit
      || !/^[0-9a-f]{64}$/u.test(vulnerabilityEvidence.inventory_sha256)
      || !/^[0-9a-f]{64}$/u.test(vulnerabilityEvidence.database_sha256)
      || !Number.isSafeInteger(vulnerabilityEvidence.package_count) || vulnerabilityEvidence.package_count < 1
      || !Number.isSafeInteger(vulnerabilityEvidence.vulnerability_count)
      || vulnerabilityEvidence.vulnerability_count < 0
      || vulnerabilityEvidence.blocking_vulnerability_count !== 0
      || vulnerabilityEvidence.policy !== "block-critical-high-and-unknown-severity"
      || vulnerabilityEvidence.status !== "passed") {
    throw new Error("JavaScript dependency-vulnerability evidence is incomplete or not passing.");
  }
}

async function inspectJavascriptReproducibility(packages, sourceCommit) {
  const sourceRoot = resolve(fileURLToPath(new URL("../", import.meta.url)), "..", "latchway-js");
  const observedCommit = execFileSync("git", ["-C", sourceRoot, "rev-parse", "--verify", "HEAD"], {
    encoding: "utf8", maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).trim();
  if (observedCommit !== sourceCommit) {
    throw new Error("The locally built JavaScript source does not match the locked release commit.");
  }
  const hash = createHash("sha256");
  const files = [];
  const packedArchives = new Map();
  const publishedPeerDependencies = new Map();
  const releasePackageNames = new Set(packages.map((entry) => entry.package));
  let totalBytes = 0;
  for (const package_ of packages) {
    const packageDirectory = package_.id === "client" ? sourceRoot : join(sourceRoot, "packages", package_.id);
    const packedArchive = readBoundedFileSync(
      join(sourceRoot, ".artifacts", package_.tarball),
      `Locked-source pack for ${package_.package}`,
      MAXIMUM_JAVASCRIPT_ARCHIVE_BYTES,
    );
    packedArchives.set(package_.package, packedArchive);
    const sourceManifest = parseStrictJSONBytes(
      await readFile(join(packageDirectory, "package.json")),
      `Locked source manifest for ${package_.package}`,
      2 * 1024 * 1024,
    );
    if (sourceManifest.name !== package_.package || sourceManifest.version !== package_.version
        || (sourceManifest.peerDependencies !== undefined
          && (sourceManifest.peerDependencies === null
            || typeof sourceManifest.peerDependencies !== "object"
            || Array.isArray(sourceManifest.peerDependencies)))) {
      throw new Error(`The locked source manifest is malformed for ${package_.package}.`);
    }
    const publishedPeers = {};
    for (const [name, range] of Object.entries(sourceManifest.peerDependencies ?? {})) {
      if (typeof range !== "string" || typeof name !== "string" || name.length === 0) {
        throw new Error(`The locked source peer dependency is malformed for ${package_.package}.`);
      }
      if (!range.startsWith("workspace:")) {
        publishedPeers[name] = range;
        continue;
      }
      if (!releasePackageNames.has(name)) {
        throw new Error(`The locked source has an unsupported workspace peer for ${package_.package}.`);
      }
      const selector = range.slice("workspace:".length);
      if (selector === "^") publishedPeers[name] = `^${package_.version}`;
      else if (selector === "~") publishedPeers[name] = `~${package_.version}`;
      else if (selector === "*") publishedPeers[name] = package_.version;
      else throw new Error(`The locked source has an unsupported workspace selector for ${package_.package}.`);
    }
    publishedPeerDependencies.set(package_.package, publishedPeers);

    const packageRoot = join(packageDirectory, "dist");
    const entries = (await readdir(packageRoot, { recursive: true })).sort();
    if (entries.length === 0 || entries.length > 4096) {
      throw new Error(`The locally built ${package_.package} dist tree has an invalid entry count.`);
    }
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.length === 0 || entry.length > 512
          || entry.startsWith("/") || entry.includes("\\")
          || entry.split("/").some((part) => part === "" || part === "." || part === "..")) {
        throw new Error(`The locally built ${package_.package} dist tree contains an unsafe path.`);
      }
      const path = join(packageRoot, entry);
      const metadata = await lstat(path);
      if (metadata.isDirectory()) continue;
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size < 1 || metadata.size > 8 * 1024 * 1024) {
        throw new Error(`The locally built ${package_.package} dist tree contains an unsafe file.`);
      }
      const bytes = await readFile(path);
      if (bytes.byteLength !== metadata.size) {
        throw new Error(`The locally built ${package_.package} dist file changed while it was read.`);
      }
      totalBytes += bytes.byteLength;
      if (totalBytes > 64 * 1024 * 1024) {
        throw new Error("The locally built JavaScript dist closure exceeds the verification limit.");
      }
      const repositoryPath = package_.id === "client"
        ? `dist/${entry}`
        : `packages/${package_.id}/dist/${entry}`;
      hash.update(repositoryPath).update("\0").update(bytes).update("\0");
      files.push({
        package: package_.package,
        path: repositoryPath,
        bytes: bytes.byteLength,
        sha256: digest(bytes),
      });
    }
  }
  if (files.length === 0) throw new Error("The locally built JavaScript dist closure is empty.");
  return { files, sha256: hash.digest("hex"), packedArchives, publishedPeerDependencies };
}

async function verifyIOS() {
  const dependency = compatibility.ios;
  const repository = repositorySlug(dependency.repository, "Latchway/latchway-ios-sdk");
  const tag = `v${dependency.version}`;
  verifyReleaseTag(dependency, "iOS", tag);
  const release = githubRelease(repository, tag);
  requireImmutableRelease(release, tag);
  const archiveName = `latchway-ios-sdk-${dependency.version}.tar.gz`;
  const names = [
    archiveName,
    `${archiveName}.sha256`,
    `docs-bundle-${dependency.version}.tar.gz`,
    "cocoapods-published-podspec.json",
    "cocoapods-reviewed-podspec.json",
    "cocoapods-release-evidence.json",
    "cocoapods-release-evidence.SHA256SUMS",
  ];
  requireExactReleaseAssets(release, names);
  const assets = await downloadAssets(repository, release, names, "ios");
  const releaseAttestation = verifyImmutableReleaseAttestations(
    repository, tag, dependency.source_commit, assets,
  );
  for (const name of names) {
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
  validateCocoaPodsSourceBinding(proof.source, publishedSpec.source, dependency.repository, tag);
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
      || !isDeepStrictEqual(publishedSpec, reviewedSpec)) {
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
  const tagReference = verifyReleaseTag(dependency, "Android", tag);
  const release = githubRelease(repository, tag);
  requireImmutableRelease(release, tag);
  const archiveName = `latchway-android-${dependency.version}-maven-repository.zip`;
  const portalName = `latchway-android-${dependency.version}-central-portal.zip`;
  const required = androidReleaseAssetNames(dependency.version);
  requireExactReleaseAssets(release, required);
  const assets = await downloadAssets(repository, release, required, "android");
  const releaseAttestation = verifyImmutableReleaseAttestations(
    repository, tag, dependency.source_commit, assets,
  );
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
  const tagBinding = await jsonAsset(assets, "github-release-tag-binding.json");
  const reviewedRepository = inspectMavenRepositoryArchive(assets.get(archiveName).path);
  validateMavenRepositoryPathClosure(reviewedRepository.files.keys(), dependency.version);
  const expectedPrimaryPaths = new Set(expectedMavenPrimaryPaths(dependency.version));
  const reviewedPortal = inspectMavenPortalArchive(
    assets.get(portalName).path, reviewedRepository.files, expectedPrimaryPaths,
  );
  const expectedPURLs = expectedMavenPURLs(dependency.version);
  const intentSHA = digest(assets.get("maven-central-upload-intent.json").bytes);
  const recordSHA = digest(assets.get("maven-central-deployment.json").bytes);
  const statusSHA = digest(assets.get("maven-central-deployment-status.json").bytes);
  validateAndroidReleaseEvidence({
    version: dependency.version,
    sourceCommit: dependency.source_commit,
    tag,
    tagObject: tagReference.tagObject,
    archiveSHA256: digest(assets.get(archiveName).bytes),
    portalSHA256: digest(assets.get(portalName).bytes),
    repositoryManifestSHA256: reviewedRepository.manifestSHA256,
    repositoryFileCount: reviewedRepository.files.size,
    portalFileCount: reviewedPortal.size,
    publicKeySHA256: digest(assets.get("latchway-maven-signing-public-key.asc").bytes),
    expectedPURLs,
    intentSHA256: intentSHA,
    recordSHA256: recordSHA,
    statusSHA256: statusSHA,
    uploadIntent,
    deployment,
    deploymentStatus,
    proof,
    tagBinding,
  });
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
    ]) || !hasExactKeys(file.gpg_status, GPG_STATUS_RECORD_KEYS)
        || typeof file.path !== "string" || !/^[-A-Za-z0-9._/]+$/u.test(file.path) || seen.has(file.path)
        || !expectedPrimaryPaths.has(file.path)
        || !/^[0-9a-f]{64}$/u.test(file.sha256) || !/^[0-9a-f]{64}$/u.test(file.signature_sha256)
        || !Number.isInteger(file.bytes) || file.bytes < 1 || !Number.isInteger(file.signature_bytes)
        || file.signature_bytes < 1 || typeof file.signature_armored !== "string"
        || digest(Buffer.from(file.signature_armored, "ascii")) !== file.signature_sha256
        || file.checksums_byte_identical !== true || !Array.isArray(file.checksums)
        || file.checksums.length !== 4) {
      throw new Error("Maven Central evidence contains an invalid or duplicate signed file.");
    }
    validateRetainedGPGStatus(file.gpg_status, proof.signing_fingerprint);
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
    const reviewedSignature = reviewedPortal.get(`dev/latchway/${file.path}.asc`);
    if (file.signature_bytes !== signature.bytes.byteLength
        || !signature.bytes.equals(Buffer.from(file.signature_armored, "ascii"))
        || !Buffer.isBuffer(reviewedSignature) || !reviewedSignature.equals(signature.bytes)
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

function inspectMavenRepositoryArchive(archive) {
  const listing = execFileSync("unzip", ["-Z1", archive], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const rawNames = listing.split("\n").filter(Boolean);
  if (rawNames.length === 0 || rawNames.length > 10_000) {
    throw new Error("Reviewed Maven repository ZIP has an invalid entry count.");
  }
  const files = new Map();
  let expandedBytes = 0;
  for (const rawName of rawNames) {
    const name = rawName.replace(/^\.\//u, "");
    if (!/^dev\/latchway\/(?:[-A-Za-z0-9._]+\/)*[-A-Za-z0-9._]+$/u.test(name)
        || files.has(name) || name.includes("..")) {
      throw new Error(`Reviewed Maven repository ZIP contains an unsafe or duplicate path: ${name}.`);
    }
    const bytes = execFileSync("unzip", ["-p", archive, rawName], {
      encoding: "buffer", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    expandedBytes = accumulateMavenArchiveBytes(expandedBytes, bytes.byteLength, "repository");
    files.set(name, bytes);
  }
  const rows = [...files.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([path, bytes]) => ({ bytes: bytes.byteLength, path, sha256: digest(bytes) }));
  return {
    files,
    manifestSHA256: digest(Buffer.from(`${JSON.stringify(rows, null, 2)}\n`, "utf8")),
  };
}

function inspectMavenPortalArchive(archive, reviewedRepository, expectedPrimaryPaths) {
  const listing = execFileSync("unzip", ["-Z1", archive], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const rawNames = listing.split("\n").filter(Boolean);
  const expected = new Set([
    ...reviewedRepository.keys(),
    ...[...expectedPrimaryPaths].map((path) => `dev/latchway/${path}.asc`),
  ]);
  if (rawNames.length !== expected.size || rawNames.length > 10_000) {
    throw new Error("Reviewed Central Portal ZIP has an invalid entry count.");
  }
  const files = new Map();
  let expandedBytes = 0;
  for (const rawName of rawNames) {
    const name = rawName.replace(/^\.\//u, "");
    if (!expected.has(name) || files.has(name) || name.includes("..")) {
      throw new Error(`Reviewed Central Portal ZIP contains an unsafe, unexpected, or duplicate path: ${name}.`);
    }
    const bytes = execFileSync("unzip", ["-p", archive, rawName], {
      encoding: "buffer", maxBuffer: 20 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    expandedBytes = accumulateMavenArchiveBytes(expandedBytes, bytes.byteLength, "portal");
    const repositoryBytes = reviewedRepository.get(name);
    if (repositoryBytes !== undefined && !repositoryBytes.equals(bytes)) {
      throw new Error(`Reviewed Central Portal entry differs from the reviewed repository: ${name}.`);
    }
    files.set(name, bytes);
  }
  return files;
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
  const verified = validateGPGStatus(status.split("\n").filter(Boolean), retainedStatus.primary_fingerprint);
  if (verified.signingFingerprint !== retainedStatus.signing_fingerprint
      || verified.primaryFingerprint !== retainedStatus.primary_fingerprint
      || verified.publicKeyAlgorithm !== retainedStatus.public_key_algorithm
      || verified.hashAlgorithm !== retainedStatus.hash_algorithm) {
    throw new Error("Independent GnuPG verification differs from retained signature proof.");
  }
}

function requiredGitHubReadToken() {
  const token = process.env.GH_TOKEN;
  if (typeof token !== "string" || token.length === 0 || token.length > 4096 || /[\0\r\n]/u.test(token)) {
    throw new Error("GH_TOKEN must contain a valid read token for the locked GitHub repositories.");
  }
  return token;
}

function githubReadEnvironment() {
  return {
    ...process.env,
    GH_TOKEN: requiredGitHubReadToken(),
    GIT_TERMINAL_PROMPT: "0",
  };
}

function authenticatedGitEnvironment() {
  return {
    ...githubReadEnvironment(),
    GIT_ASKPASS: gitAskpass,
  };
}

function runGitHubCLI(arguments_, options) {
  if (authenticatedInputs !== undefined) {
    throw new Error("GitHub CLI access is forbidden while using authenticated offline dependency inputs.");
  }
  return execFileSync("gh", arguments_, { ...options, env: githubReadEnvironment() });
}

function githubRelease(repository, tag) {
  if (authenticatedInputs !== undefined) {
    const release = readAuthenticatedJSON(repository, "release.json", 4 * 1024 * 1024);
    if (!Array.isArray(release.assets)) throw new Error(`${repository} returned invalid release metadata.`);
    return release;
  }
  const output = runGitHubCLI(["api", "-H", "X-GitHub-Api-Version: 2026-03-10",
    `repos/${repository}/releases/tags/${encodeURIComponent(tag)}`], {
    encoding: "utf8", maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const release = parseStrictJSONBytes(
    Buffer.from(output, "utf8"), `${repository} release metadata`, 4 * 1024 * 1024,
  );
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

function verifyReleaseAttestation(repository, tag, sourceCommit, assets) {
  return captureGHVerification(
    ["release", "verify", tag, "--repo", repository, "--format", "json"],
    `${repository}@${tag} immutable release attestation`,
    { repository, tag, sourceCommit, assets },
  );
}

function verifyReleaseAsset(repository, tag, path, sourceCommit, assets) {
  return captureGHVerification(
    ["release", "verify-asset", tag, path, "--repo", repository, "--format", "json"],
    `${repository}@${tag} immutable release asset attestation`,
    { repository, tag, sourceCommit, assets },
  );
}

function captureGHVerification(arguments_, label, expected) {
  let bytes;
  if (authenticatedInputs === undefined) {
    bytes = runGitHubCLI(arguments_, {
      encoding: "buffer", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
  } else if (arguments_[0] === "release" && arguments_[1] === "verify") {
    bytes = readAuthenticatedBytes(expected.repository, "release-attestation.json", 16 * 1024 * 1024);
  } else if (arguments_[0] === "release" && arguments_[1] === "verify-asset") {
    const assetName = basename(arguments_[3]);
    bytes = readAuthenticatedBytes(
      expected.repository, join("asset-attestations", `${assetName}.json`), 16 * 1024 * 1024,
    );
  } else {
    throw new Error(`${label} requested an unsupported offline GitHub verification.`);
  }
  return validateReleaseAttestation(bytes, {
    repository: expected.repository,
    tag: expected.tag,
    expectedCommit: expected.sourceCommit,
    assets: expected.assets,
    label,
  });
}

async function downloadAssets(repository, release, names, directory) {
  const result = new Map();
  const root = join(temporary, directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const plan = names.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length !== 1) {
      throw new Error(`${repository} release asset ${name} is missing or ambiguous.`);
    }
    return {
      asset: matches[0],
      maximumBytes: validatePublishedDependencyAssetMetadata(matches[0], directory, name),
      name,
    };
  });
  for (const { asset: metadata, maximumBytes, name } of plan) {
    const bytes = authenticatedInputs === undefined
      ? runGitHubCLI(["api", "--method", "GET", "-H", "Accept: application/octet-stream",
        "-H", "X-GitHub-Api-Version: 2026-03-10",
        `repos/${repository}/releases/assets/${metadata.id}`], {
        encoding: "buffer", maxBuffer: maximumBytes + 1, stdio: ["ignore", "pipe", "pipe"],
      })
      : readAuthenticatedBytes(repository, join("assets", name), maximumBytes);
    if (bytes.byteLength === 0 || bytes.byteLength > maximumBytes || bytes.byteLength !== metadata.size) {
      throw new Error(`${repository} release asset ${name} has invalid downloaded bytes.`);
    }
    const observed = digest(bytes);
    if (metadata.digest !== undefined && metadata.digest !== null
        && metadata.digest !== "" && metadata.digest !== `sha256:${observed}`) {
      throw new Error(`${repository} release asset ${name} digest differs from downloaded bytes.`);
    }
    const path = join(root, name);
    await writeFile(path, bytes, { mode: 0o600 });
    result.set(name, { path, bytes, sha256: observed });
  }
  return result;
}

function verifyImmutableReleaseAttestations(repository, tag, sourceCommit, assets) {
  const expectedAssets = [...assets.entries()].map(([name, asset]) => ({
    name,
    sha256: asset.sha256,
  }));
  const releaseAttestation = verifyReleaseAttestation(
    repository, tag, sourceCommit, expectedAssets,
  );
  for (const [name, asset] of assets) {
    asset.immutableAttestation = verifyReleaseAsset(
      repository, tag, asset.path, sourceCommit, expectedAssets,
    );
    if (asset.immutableAttestation.asset_count !== expectedAssets.length) {
      throw new Error(`${repository} immutable release attestation omitted ${name}.`);
    }
  }
  return releaseAttestation;
}

function verifyGitHubAttestation(repository, path, sourceCommit) {
  if (authenticatedInputs !== undefined) {
    const asset = basename(path);
    const marker = readAuthenticatedJSON(
      repository, join("build-attestations", `${asset}.json`), 64 * 1024,
    );
    if (!hasExactKeys(marker, ["schema_version", "kind", "repository", "asset", "source_commit", "status"])
        || marker.schema_version !== 1 || marker.kind !== "latchway_authenticated_build_attestation"
        || marker.repository !== repository || marker.asset !== asset
        || marker.source_commit !== sourceCommit || marker.status !== "verified") {
      throw new Error(`${repository} build attestation marker for ${asset} is not bound to the locked source.`);
    }
    return;
  }
  runGitHubCLI(["attestation", "verify", path,
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
  const bytes = decodeBase64Strict(envelope.payload, "Retained npm attestation statement");
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    throw new Error("Retained npm attestation statement has an invalid size.");
  }
  return parseStrictJSONBytes(bytes, "Retained npm attestation statement", 256 * 1024);
}

function verifyNpmWorkflowCertificate(attestation, repositoryURL) {
  const encoded = attestation?.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof encoded !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("Retained npm provenance bundle is missing its signing certificate.");
  }
  const certificateBytes = decodeBase64Strict(encoded, "Retained npm provenance certificate");
  if (certificateBytes.byteLength > 64 * 1024) {
    throw new Error("Retained npm provenance certificate exceeds its size limit.");
  }
  const certificate = new X509Certificate(certificateBytes);
  if (certificate.subjectAltName !== `URI:${repositoryURL}/${WORKFLOW_PATH}@${SOURCE_REF}`) {
    throw new Error("Retained npm provenance certificate has an unexpected workflow identity.");
  }
}

async function jsonAsset(assets, name) {
  const bytes = assets.get(name)?.bytes;
  if (!Buffer.isBuffer(bytes) || bytes.byteLength > 10 * 1024 * 1024) throw new Error(`Invalid JSON asset ${name}.`);
  return parseStrictJSONBytes(bytes, `Release asset ${name}`, 10 * 1024 * 1024);
}

function verifyReleaseTag(dependency, label, explicitTag) {
  const tag = explicitTag ?? `v${dependency.version}`;
  let output;
  if (authenticatedInputs === undefined) {
    output = execFileSync("git", ["-c", "credential.helper=", "ls-remote", dependency.repository,
      `refs/tags/${tag}`, `refs/tags/${tag}^{}`], {
      encoding: "utf8", env: authenticatedGitEnvironment(), maxBuffer: 1024 * 1024,
    }).trim();
  } else {
    const repository = repositorySlug(dependency.repository, repositoryFromLabel(label));
    const reference = readAuthenticatedJSON(repository, "tag-ref.json", 1024 * 1024);
    const tagObject = readAuthenticatedJSON(repository, "tag-object.json", 1024 * 1024);
    if (reference?.ref !== `refs/tags/${tag}` || reference?.object?.type !== "tag"
        || reference.object.sha !== tagObject?.sha || tagObject?.tag !== tag
        || tagObject?.object?.type !== "commit") {
      throw new Error(`${label} release tag ${tag} has invalid authenticated API evidence.`);
    }
    output = `${reference.object.sha}\trefs/tags/${tag}\n${tagObject.object.sha}\trefs/tags/${tag}^{}`;
  }
  return requireAnnotatedTagRefs(output, { tag, expectedCommit: dependency.source_commit, label });
}

function authenticatedInputRoot() {
  const configured = process.env.LATCHWAY_AUTHENTICATED_DEPENDENCY_INPUTS;
  if (configured === undefined) return undefined;
  if (configured.length === 0 || configured.includes("\0") || configured.includes("\r") || configured.includes("\n")) {
    throw new Error("Invalid authenticated dependency input path.");
  }
  return resolve(configured);
}

function repositoryFromLabel(label) {
  if (label === "JavaScript") return "Latchway/latchway-js";
  if (label === "iOS") return "Latchway/latchway-ios-sdk";
  if (label === "Android") return "Latchway/latchway-android";
  if (label === "core") return "Latchway/latchway";
  throw new Error(`Unsupported authenticated dependency label ${label}.`);
}

function authenticatedRepositoryDirectory(repository) {
  const directories = new Map([
    ["Latchway/latchway-js", "javascript"],
    ["Latchway/latchway-ios-sdk", "ios"],
    ["Latchway/latchway-android", "android"],
    ["Latchway/latchway", "core"],
  ]);
  const directory = directories.get(repository);
  if (directory === undefined || authenticatedInputs === undefined) {
    throw new Error(`Unsupported authenticated dependency repository ${repository}.`);
  }
  return join(authenticatedInputs, directory);
}

function readAuthenticatedBytes(repository, relativePath, maximumBytes) {
  if (relativePath.startsWith("/") || relativePath.includes("..") || relativePath.includes("\0")) {
    throw new Error("Invalid authenticated dependency input name.");
  }
  const path = join(authenticatedRepositoryDirectory(repository), relativePath);
  return readBoundedFileSync(path, `Authenticated dependency input ${relativePath}`, maximumBytes);
}

function readAuthenticatedJSON(repository, relativePath, maximumBytes) {
  const bytes = readAuthenticatedBytes(repository, relativePath, maximumBytes);
  return parseStrictJSONBytes(bytes, `Authenticated dependency input ${relativePath}`, maximumBytes);
}

async function auditNpmSignatures(
  packageName, version, integrity, directory, matchingClientVersion, expectedExternalPeers,
) {
  const root = join(temporary, directory);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dependencies = { [packageName]: version };
  if (matchingClientVersion !== undefined) dependencies["@latchway/client"] = matchingClientVersion;
  for (const [name, peerVersion] of Object.entries(expectedExternalPeers)) {
    if (Object.hasOwn(dependencies, name)) {
      throw new Error(`${packageName} external peer dependency collides with the fixed package set.`);
    }
    dependencies[name] = peerVersion;
  }
  await writeFile(join(root, "package.json"), `${JSON.stringify({
    name: "latchway-dependency-signature-audit", version: "0.0.0", private: true,
    dependencies,
  }, null, 2)}\n`);
  const npmrc = join(root, ".npmrc");
  await writeFile(npmrc, "registry=https://registry.npmjs.org/\nfund=false\n", { mode: 0o600 });
  const environment = sanitizedNpmEnvironment(npmrc, join(root, ".npm-cache"));
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
  const lock = readBoundedStrictJSONFileSync(
    join(root, "package-lock.json"), `${packageName} npm signature-audit lock`, 4 * 1024 * 1024,
  );
  const installed = lock.packages?.[`node_modules/${packageName}`];
  if (installed?.version !== version || installed.integrity !== integrity) {
    throw new Error("npm signature audit installed a different dependency integrity.");
  }
  if (matchingClientVersion !== undefined
      && lock.packages?.["node_modules/@latchway/client"]?.version !== matchingClientVersion) {
    throw new Error(`${packageName} npm signature audit did not install the matching client version.`);
  }
  for (const [name, peerVersion] of Object.entries(expectedExternalPeers)) {
    if (lock.packages?.[`node_modules/${name}`]?.version !== peerVersion) {
      throw new Error(`${packageName} npm signature audit did not install exact external peer ${name}.`);
    }
  }
  execFileSync("npm", ["audit", "signatures", "--json", "--registry=https://registry.npmjs.org/"], {
    cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 4 * 1024 * 1024,
  });
}

function sanitizedNpmEnvironment(userconfig, cache) {
  const excluded = new Set(["GH_TOKEN", "GITHUB_TOKEN", "NODE_AUTH_TOKEN", "NPM_TOKEN",
    "npm_config__auth", "npm_config_auth", "npm_config__authToken", "NPM_CONFIG__AUTH",
    "NPM_CONFIG_AUTH"]);
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => {
      const normalized = name.toLowerCase();
      return !excluded.has(name) && !(normalized.startsWith("npm_config_") && normalized.includes("auth"));
    })),
    NPM_CONFIG_USERCONFIG: userconfig,
    NPM_CONFIG_GLOBALCONFIG: `${userconfig}.global`,
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
