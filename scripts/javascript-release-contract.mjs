import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import {
  PROVENANCE_TYPE,
  parseProvenanceOrigin,
} from "./npm-release-evidence.mjs";
import { parseStrictJSONBytes } from "./release-attestation.mjs";

export const JAVASCRIPT_ADOPTION_PATTERN =
  /^npm-release-adoption-(client|openai|vercel-ai|langchain)-([1-9]\d*)-([1-9]\d*)\.json$/u;
export const MAXIMUM_JAVASCRIPT_ADOPTION_RECORDS = 256;
export const MAXIMUM_JAVASCRIPT_ARCHIVE_BYTES = 20 * 1024 * 1024;

export function validateJavascriptAdoptionClosure(names, packageIDs) {
  if (!Array.isArray(names) || !Array.isArray(packageIDs)
      || names.length === 0 || names.length > MAXIMUM_JAVASCRIPT_ADOPTION_RECORDS
      || names.some((name) => typeof name !== "string") || new Set(names).size !== names.length
      || packageIDs.length === 0 || new Set(packageIDs).size !== packageIDs.length) {
    throw new Error("JavaScript adoption history is not a unique non-empty package closure.");
  }
  const expectedIDs = [...packageIDs].sort();
  const groups = new Map();
  for (const name of names) {
    const match = JAVASCRIPT_ADOPTION_PATTERN.exec(name);
    if (match === null || !packageIDs.includes(match[1])) {
      throw new Error(`JavaScript adoption history contains an unexpected record ${name}.`);
    }
    const attempt = `${match[2]}:${match[3]}`;
    const observed = groups.get(attempt) ?? [];
    observed.push(match[1]);
    groups.set(attempt, observed);
  }
  if ([...groups.values()].some((ids) => !isDeepStrictEqual(ids.sort(), expectedIDs))) {
    throw new Error("Every JavaScript adoption attempt must contain the exact four-package closure.");
  }
}

export function inspectNpmArchive(path, package_, evidence, reviewedReproducibility) {
  const reviewedPeerDependencies = reviewedReproducibility.publishedPeerDependencies?.get(package_.package);
  if (reviewedPeerDependencies === undefined
      || !isDeepStrictEqual(evidence.published_peer_dependencies, reviewedPeerDependencies)) {
    throw new Error(`Reviewed ${package_.package} peer dependencies differ from locked source.`);
  }
  const listing = execFileSync("tar", ["-tzf", path], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).split("\n").filter(Boolean).sort();
  if (listing.length === 0 || listing.length > 512 || new Set(listing).size !== listing.length
      || !isDeepStrictEqual(listing, evidence.entries)) {
    throw new Error(`Reviewed ${package_.package} archive entries differ from package-set evidence.`);
  }
  for (const entry of listing) {
    if (!/^package\/(?:[A-Za-z0-9@._+-]+\/)*[A-Za-z0-9@._+-]+$/u.test(entry)
        || entry.includes("..") || entry.includes("\\") || entry.length > 512) {
      throw new Error(`Reviewed ${package_.package} archive contains an unsafe entry.`);
    }
  }
  const verbose = execFileSync("tar", ["-tvzf", path], {
    encoding: "utf8", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }).split("\n").filter(Boolean);
  if (verbose.length !== listing.length || verbose.some((line) => line[0] !== "-")) {
    throw new Error(`Reviewed ${package_.package} archive is not an exact regular-file closure.`);
  }

  const sourcePrefix = package_.id === "client" ? "dist/" : `packages/${package_.id}/dist/`;
  const reviewedDist = new Map();
  for (const row of reviewedReproducibility.files.filter((entry) => entry.package === package_.package)) {
    if (!hasExactKeys(row, ["package", "path", "bytes", "sha256"])
        || typeof row.path !== "string" || !row.path.startsWith(sourcePrefix)
        || !Number.isSafeInteger(row.bytes) || row.bytes < 1 || row.bytes > 8 * 1024 * 1024
        || !/^[0-9a-f]{64}$/u.test(row.sha256)) {
      throw new Error(`Reviewed source output is malformed for ${package_.package}.`);
    }
    const relative = row.path.slice(sourcePrefix.length);
    if (!/^(?:[A-Za-z0-9@._+-]+\/)*[A-Za-z0-9@._+-]+$/u.test(relative)) {
      throw new Error(`Reviewed source output has an unsafe path for ${package_.package}.`);
    }
    const archiveEntry = `package/dist/${relative}`;
    if (reviewedDist.has(archiveEntry)) {
      throw new Error(`Reviewed source output contains a duplicate path for ${package_.package}.`);
    }
    reviewedDist.set(archiveEntry, row);
  }
  if (reviewedDist.size === 0) {
    throw new Error(`Reviewed source output is empty for ${package_.package}.`);
  }

  let unpackedBytes = 0;
  const observedDist = new Set();
  for (const entry of listing) {
    const bytes = execFileSync("tar", ["-xOzf", path, entry], {
      encoding: "buffer", maxBuffer: 8 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    unpackedBytes += bytes.byteLength;
    if (unpackedBytes > 25 * 1024 * 1024) {
      throw new Error(`Reviewed ${package_.package} archive exceeds the unpacked size limit.`);
    }
    if (entry.startsWith("package/dist/")) {
      const expected = reviewedDist.get(entry);
      if (expected === undefined || bytes.byteLength !== expected.bytes || digest(bytes) !== expected.sha256) {
        throw new Error(`Reviewed ${package_.package} archive dist bytes differ from locked source output.`);
      }
      observedDist.add(entry);
    }
  }
  if (unpackedBytes !== evidence.unpacked_bytes) {
    throw new Error(`Reviewed ${package_.package} archive size differs from package-set evidence.`);
  }
  if (observedDist.size !== reviewedDist.size
      || [...reviewedDist.keys()].some((entry) => !observedDist.has(entry))) {
    throw new Error(`Reviewed ${package_.package} archive omits locked source output.`);
  }

  let manifest;
  try {
    const bytes = execFileSync("tar", ["-xOzf", path, "package/package.json"], {
      encoding: "buffer", maxBuffer: 2 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    manifest = parseStrictJSONBytes(bytes, `Reviewed ${package_.package} package manifest`, 2 * 1024 * 1024);
  } catch {
    throw new Error(`Reviewed ${package_.package} archive has no valid package manifest.`);
  }
  if (manifest.name !== package_.package || manifest.version !== package_.version) {
    throw new Error(`Reviewed archive coordinates differ for ${package_.package}.`);
  }
  if (!isDeepStrictEqual(manifest.peerDependencies ?? {}, evidence.published_peer_dependencies)
      || (package_.id !== "client"
        && manifest.peerDependencies?.["@latchway/client"] !== `^${package_.version}`)) {
    throw new Error(`Reviewed archive peer dependencies differ for ${package_.package}.`);
  }
  if (package_.id === "client") {
    const packagedLock = execFileSync("tar", ["-xOzf", path, "package/contract.lock"], {
      encoding: "buffer", maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "pipe"],
    });
    const reviewedLock = readFileSync(fileURLToPath(new URL("../contract.lock", import.meta.url)));
    if (!packagedLock.equals(reviewedLock)) {
      throw new Error("Reviewed @latchway/client archive does not contain the exact React Native contract lock.");
    }
  }
}

export function validateNpmArchiveMatchesLockedPack(reviewedArchive, lockedSourceArchive, package_) {
  if (!Buffer.isBuffer(reviewedArchive) || !Buffer.isBuffer(lockedSourceArchive)
      || reviewedArchive.byteLength < 1 || reviewedArchive.byteLength > MAXIMUM_JAVASCRIPT_ARCHIVE_BYTES
      || lockedSourceArchive.byteLength < 1 || lockedSourceArchive.byteLength > MAXIMUM_JAVASCRIPT_ARCHIVE_BYTES
      || !reviewedArchive.equals(lockedSourceArchive)) {
    throw new Error(`Reviewed ${package_.package} archive is not byte-identical to the locked-source pack.`);
  }
}

export function externalPeerDependencies(peerDependencies, package_) {
  if (peerDependencies === null || typeof peerDependencies !== "object" || Array.isArray(peerDependencies)) {
    throw new Error(`Reviewed archive peer dependencies are malformed for ${package_.package}.`);
  }
  const result = {};
  for (const [name, version] of Object.entries(peerDependencies)) {
    if (name === "@latchway/client") continue;
    if (typeof name !== "string" || name.length === 0
        || typeof version !== "string"
        || !/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u.test(version)) {
      throw new Error(`Reviewed external peer dependency is not exact for ${package_.package}.`);
    }
    result[name] = version;
  }
  return result;
}

export function validateCleanJavascriptConsumer(consumer, package_, version, expectedExternalPeers) {
  if (!hasExactKeys(consumer, [
    "isolated_directory", "install_scripts", "exact_package_version", "matching_client_version",
    "external_peer_dependencies", "node_esm", "registry_signatures",
  ]) || consumer.isolated_directory !== true || consumer.install_scripts !== "disabled"
      || consumer.exact_package_version !== version
      || consumer.matching_client_version !== (package_.id === "client" ? null : version)
      || !isDeepStrictEqual(consumer.external_peer_dependencies, expectedExternalPeers)
      || consumer.node_esm !== true || consumer.registry_signatures !== true) {
    throw new Error(`JavaScript clean-consumer evidence is incomplete for ${package_.package}.`);
  }
}

export function validateJavascriptAdoptionRecord({
  name,
  adoption,
  package_,
  manifestEntry,
  provenanceOrigin,
  sourceBinding,
  version,
  tag,
  manifestSHA,
}) {
  const match = JAVASCRIPT_ADOPTION_PATTERN.exec(name);
  const adoptedOrigin = parseProvenanceOrigin(adoption.provenance?.invocation_id, sourceBinding.repository);
  const mode = adoption.adoption?.mode;
  const provenanceIsAdoptionAttempt = adoption.provenance?.run_id === adoption.adoption?.run_id
    && adoption.provenance?.run_attempt === adoption.adoption?.run_attempt;
  if (!hasExactKeys(adoption, [
    "schema_version", "kind", "package", "version", "release_tag", "tarball", "source", "provenance",
    "adoption", "registry_evidence_manifest",
  ]) || !hasExactKeys(adoption.provenance, [
    "repository", "commit", "workflow", "ref", "predicate_type", "invocation_id", "run_id", "run_attempt",
  ]) || !hasExactKeys(adoption.adoption, [
    "repository", "commit", "workflow", "ref", "run_id", "run_attempt", "mode",
  ]) || !hasExactKeys(adoption.registry_evidence_manifest, ["file", "sha256"])
      || adoption.schema_version !== 1 || adoption.kind !== "latchway_npm_release_adoption"
      || match === null || match[1] !== package_.id || adoption.package !== package_.package
      || adoption.version !== version || adoption.release_tag !== tag
      || !isDeepStrictEqual(adoption.tarball, manifestEntry.tarball)
      || !isDeepStrictEqual(adoption.source, sourceBinding)
      || adoption.provenance?.repository !== sourceBinding.repository
      || adoption.provenance?.commit !== sourceBinding.commit
      || adoption.provenance?.workflow !== sourceBinding.workflow
      || adoption.provenance?.ref !== sourceBinding.ref
      || adoption.provenance?.predicate_type !== PROVENANCE_TYPE
      || !isDeepStrictEqual(adoptedOrigin, provenanceOrigin)
      || !Number.isSafeInteger(adoption.provenance?.run_id) || adoption.provenance.run_id < 1
      || !Number.isSafeInteger(adoption.provenance?.run_attempt) || adoption.provenance.run_attempt < 1
      || adoption.provenance.run_id !== adoptedOrigin.run_id
      || adoption.provenance.run_attempt !== adoptedOrigin.run_attempt
      || !Number.isSafeInteger(adoption.adoption?.run_id) || adoption.adoption.run_id < 1
      || !Number.isSafeInteger(adoption.adoption?.run_attempt) || adoption.adoption.run_attempt < 1
      || String(adoption.adoption.run_id) !== match[2]
      || String(adoption.adoption.run_attempt) !== match[3]
      || adoption.adoption?.repository !== sourceBinding.repository
      || adoption.adoption?.commit !== sourceBinding.commit
      || adoption.adoption?.workflow !== sourceBinding.workflow
      || adoption.adoption?.ref !== sourceBinding.ref
      || !new Set(["published", "adopted_existing"]).has(mode)
      || (mode === "published") !== provenanceIsAdoptionAttempt
      || adoption.registry_evidence_manifest.file !== "npm-registry-evidence-manifest.json"
      || adoption.registry_evidence_manifest.sha256 !== manifestSHA) {
    throw new Error(`JavaScript adoption record ${name} is not bound to the locked source and provenance.`);
  }
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}

function digest(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
