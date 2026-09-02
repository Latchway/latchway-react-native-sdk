import { createHash, X509Certificate } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { decodeBase64Strict, parseStrictJSONBytes } from "./release-attestation.mjs";
import {
  LATCHWAY_SCOPE_REGISTRY_KEY,
  NPM_REGISTRY_URL,
  isolatedRegistryEnvironment,
  npmRegistryArguments,
  writeRegistryNpmrcs,
} from "./npm-registry-isolation.mjs";

import {
  PROVENANCE_TYPE,
  PUBLISH_TYPE,
  SOURCE_REF,
  WORKFLOW_PATH,
  assertSafeRetainedOutput,
  buildAdoptionRecord,
  buildRegistryManifest,
  normalizePublishPerformedForConsumerAttempt,
  requireCurrentPublicationOrigin,
  sha256,
  verifyProvenanceStatement,
  verifyPublishStatement,
} from "./npm-release-evidence.mjs";

const REGISTRY_URL = NPM_REGISTRY_URL;
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const trustedNpmCLI = process.env.LATCHWAY_NPM_CLI;
if (typeof trustedNpmCLI !== "string" || !isAbsolute(trustedNpmCLI)
    || basename(trustedNpmCLI) !== "npm-cli.js") {
  throw new Error("LATCHWAY_NPM_CLI must identify the authenticated absolute npm CLI handoff.");
}
const archiveArgument = process.argv.slice(2).find((argument) => argument !== "--" && !argument.startsWith("--"));
if (archiveArgument === undefined) throw new Error("usage: node scripts/verify-published.mjs /path/to/package.tgz");
const localArchive = resolve(archiveArgument);
const evidenceDirectory = dirname(localArchive);
const manifest = parseStrictJSONBytes(
  await readFile(join(ROOT, "package.json")), "React Native package manifest", 2 * 1024 * 1024,
);
const packageEvidence = parseStrictJSONBytes(
  await readFile(join(evidenceDirectory, "package-evidence.json")), "React Native package evidence", 2 * 1024 * 1024,
);
const localBytes = await readFile(localArchive);
const localSHA1 = createHash("sha1").update(localBytes).digest("hex");
if (basename(localArchive) !== packageEvidence.tarball || sha256(localBytes) !== packageEvidence.sha256) {
  throw new Error("The local npm archive does not match reviewed package evidence.");
}

const expectedCommit = requiredEnvironment("EXPECTED_SOURCE_COMMIT", /^[0-9a-f]{40}$/u);
const workflowCommit = requiredEnvironment("GITHUB_SHA", /^[0-9a-f]{40}$/u);
const expectedReleaseTag = requiredEnvironment(
  "EXPECTED_RELEASE_TAG",
  /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u,
);
const expectedRepository = requiredEnvironment(
  "GITHUB_REPOSITORY", /^Latchway\/latchway-react-native-sdk$/u,
);
const expectedRef = requiredEnvironment("GITHUB_REF", /^refs\/heads\/main$/u);
const expectedEvent = requiredEnvironment("GITHUB_EVENT_NAME", /^(?:repository_dispatch|workflow_dispatch)$/u);
const expectedWorkflowPath = process.env.EXPECTED_WORKFLOW_PATH ?? WORKFLOW_PATH;
if (![WORKFLOW_PATH, ".github/workflows/single-maintainer-release.yml"].includes(expectedWorkflowPath)
    || (expectedEvent === "repository_dispatch" && expectedWorkflowPath !== WORKFLOW_PATH)
    || (expectedEvent === "workflow_dispatch"
      && expectedWorkflowPath !== ".github/workflows/single-maintainer-release.yml")) {
  throw new Error("The publication workflow path and event are not an approved release pair.");
}
const currentRunID = Number(requiredEnvironment("GITHUB_RUN_ID", /^[1-9]\d*$/u));
const currentRunAttempt = Number(requiredEnvironment("GITHUB_RUN_ATTEMPT", /^[1-9]\d*$/u));
const producerRunID = Number(requiredEnvironment("PUBLISH_PRODUCER_RUN_ID", /^[1-9]\d*$/u));
const producerRunAttempt = Number(requiredEnvironment("PUBLISH_PRODUCER_RUN_ATTEMPT", /^[1-9]\d*$/u));
const publishPerformed = normalizePublishPerformedForConsumerAttempt(
  requiredEnvironment("PUBLISH_PERFORMED", /^(?:true|false)$/u) === "true",
  { producerRunID, producerRunAttempt, currentRunID, currentRunAttempt },
);
if (workflowCommit !== expectedCommit || expectedReleaseTag !== `v${manifest.version}` || expectedRef !== SOURCE_REF) {
  throw new Error("The publication workflow does not match the promoted source coordinate.");
}

const expectedRepositoryURL = `https://github.com/${expectedRepository}`;
const published = await waitForPublishedMetadata();
const metadata = published.value;
assertPublishedMetadata(metadata);
const npmViewBytes = runNpmCaptured([
  "view", `${manifest.name}@${manifest.version}`, "--json", "--include-attestations",
], ROOT, 2 * 1024 * 1024, "npm view");
const npmView = assertSafeRetainedOutput(npmViewBytes, "npm view output", 2 * 1024 * 1024);
assertNpmView(npmView);

const tarballResult = await fetchBounded(metadata.dist.tarball, 20 * 1024 * 1024, "application/octet-stream");
if (tarballResult.response.status !== 200 || !localBytes.equals(tarballResult.bytes)) {
  throw new Error("The npm registry tarball is not byte-identical to the reviewed React Native archive.");
}
const registryEntries = execFileSync("tar", ["-tzf", localArchive], {
  encoding: "utf8", maxBuffer: 2 * 1024 * 1024,
}).split("\n").filter(Boolean);
if (JSON.stringify(registryEntries) !== JSON.stringify(packageEvidence.entries)) {
  throw new Error("The npm registry archive entry list differs from package evidence.");
}

const attestationResult = await fetchBounded(metadata.dist.attestations.url, 5 * 1024 * 1024, "application/json");
if (attestationResult.response.status !== 200) {
  throw new Error(`npm attestation retrieval failed with HTTP ${attestationResult.response.status}.`);
}
const attestationDocument = assertSafeRetainedOutput(
  attestationResult.bytes, "npm Sigstore attestation output", 5 * 1024 * 1024,
);
const attestations = attestationDocument.attestations;
if (!Array.isArray(attestations)) throw new Error("The npm attestation response is malformed.");
const provenance = exactlyOne(attestations, PROVENANCE_TYPE);
const publish = exactlyOne(attestations, PUBLISH_TYPE);
const provenanceOrigin = verifyProvenanceStatement(decodeStatement(provenance), {
  packageName: manifest.name,
  packageVersion: manifest.version,
  sha512: packageEvidence.sha512,
  expectedRepositoryURL,
  expectedCommit,
  expectedEvent,
  expectedWorkflowPath,
});
verifyWorkflowCertificate(provenance, expectedRepositoryURL, expectedWorkflowPath);
requireCurrentPublicationOrigin(provenanceOrigin, { publishPerformed, currentRunID, currentRunAttempt });
verifyPublishStatement(decodeStatement(publish), {
  packageName: manifest.name,
  packageVersion: manifest.version,
  sha512: packageEvidence.sha512,
  registryURL: REGISTRY_URL,
});

const auditBytes = await auditRegistrySignatures();
const audit = assertSafeRetainedOutput(auditBytes, "npm audit signatures output", 2 * 1024 * 1024);
if (audit === null || typeof audit !== "object" || Object.hasOwn(audit, "error")) {
  throw new Error("npm audit signatures returned an invalid verification result.");
}
const retained = [
  { name: "npm-registry-version.json", bytes: published.bytes },
  { name: "npm-registry-view.json", bytes: npmViewBytes },
  { name: "npm-attestations.json", bytes: attestationResult.bytes },
  { name: "npm-audit-signatures.json", bytes: auditBytes },
];
for (const asset of retained) {
  assertSafeRetainedOutput(asset.bytes, asset.name, asset.name === "npm-attestations.json" ? 5 * 1024 * 1024 : 2 * 1024 * 1024);
  await writeFile(join(evidenceDirectory, asset.name), asset.bytes, { mode: 0o600 });
}
const registryManifest = buildRegistryManifest({
  packageName: manifest.name,
  packageVersion: manifest.version,
  tarball: {
    name: packageEvidence.tarball,
    bytes: localBytes.byteLength,
    sha256: packageEvidence.sha256,
    sha512: packageEvidence.sha512,
    integrity: packageEvidence.integrity,
  },
  evidence: retained,
});
const registryManifestBytes = jsonBytes(registryManifest);
await writeFile(join(evidenceDirectory, "npm-registry-evidence-manifest.json"), registryManifestBytes, { mode: 0o600 });
const evidenceReferences = Object.fromEntries(retained.map((asset) => [asset.name, {
  bytes: asset.bytes.byteLength, sha256: sha256(asset.bytes),
}]));
const publicationEvidence = {
  schema_version: 2,
  kind: "latchway_npm_publication_evidence",
  package: manifest.name,
  version: manifest.version,
  source: { repository: expectedRepositoryURL, commit: expectedCommit, workflow: expectedWorkflowPath, ref: SOURCE_REF },
  release_tag: expectedReleaseTag,
  registry: REGISTRY_URL,
  tarball: {
    name: packageEvidence.tarball,
    bytes: localBytes.byteLength,
    sha256: packageEvidence.sha256,
    sha512: packageEvidence.sha512,
    integrity: packageEvidence.integrity,
    registry_bytes_sha256: sha256(tarballResult.bytes),
  },
  trusted_publisher: {
    provider: "github",
    provenance_predicate_type: PROVENANCE_TYPE,
    provenance_origin: provenanceOrigin,
    sigstore_bundle: { file: "npm-attestations.json", ...evidenceReferences["npm-attestations.json"] },
  },
  registry_signature_verification: {
    command: `npm audit signatures --json --registry=${REGISTRY_URL} `
      + `--${LATCHWAY_SCOPE_REGISTRY_KEY}=${REGISTRY_URL}`,
    output: { file: "npm-audit-signatures.json", ...evidenceReferences["npm-audit-signatures.json"] },
  },
  retained_outputs: evidenceReferences,
  evidence_manifest: {
    file: "npm-registry-evidence-manifest.json",
    bytes: registryManifestBytes.byteLength,
    sha256: sha256(registryManifestBytes),
  },
};
const publicationBytes = jsonBytes(publicationEvidence);
await writeFile(join(evidenceDirectory, "post-publish-evidence.json"), publicationBytes, { mode: 0o600 });
const adoption = buildAdoptionRecord({
  packageName: manifest.name,
  packageVersion: manifest.version,
  releaseTag: expectedReleaseTag,
  repositoryURL: expectedRepositoryURL,
  sourceCommit: expectedCommit,
  provenanceOrigin,
  tarball: registryManifest.tarball,
  manifestSHA256: sha256(registryManifestBytes),
  currentRunID,
  currentRunAttempt,
  publishPerformed,
  workflowPath: expectedWorkflowPath,
});
const adoptionName = `npm-release-adoption-${currentRunID}-${currentRunAttempt}.json`;
const adoptionBytes = jsonBytes(adoption);
await writeFile(join(evidenceDirectory, adoptionName), adoptionBytes, { mode: 0o600 });
if (typeof process.env.GITHUB_OUTPUT === "string") {
  await appendFile(process.env.GITHUB_OUTPUT, `adoption_asset=${adoptionName}\n`, { mode: 0o600 });
}
process.stdout.write(`${JSON.stringify({
  ...publicationEvidence,
  adoption: { file: adoptionName, bytes: adoptionBytes.byteLength, sha256: sha256(adoptionBytes) },
}, null, 2)}\n`);

async function waitForPublishedMetadata() {
  const url = `${REGISTRY_URL}${encodeURIComponent(manifest.name)}/${encodeURIComponent(manifest.version)}`;
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const result = await fetchBounded(url, 2 * 1024 * 1024, "application/json");
    if (result.response.status === 200) {
      const value = assertSafeRetainedOutput(result.bytes, "npm registry version output", 2 * 1024 * 1024);
      if (value.name !== manifest.name || value.version !== manifest.version
          || value.dist?.integrity !== packageEvidence.integrity || value.dist?.shasum !== localSHA1) {
        throw new Error("The published npm version does not match the reviewed release archive.");
      }
      if (value.dist?.attestations?.provenance?.predicateType === PROVENANCE_TYPE) return { value, bytes: result.bytes };
    } else if (result.response.status !== 404) {
      throw new Error(`npm publication verification failed with HTTP ${result.response.status}.`);
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5_000));
  }
  throw new Error("The exact npm version and provenance did not become visible within two minutes.");
}

function assertPublishedMetadata(value) {
  if (value.name !== manifest.name || value.version !== manifest.version
      || !isDeepStrictEqual(value.exports, manifest.exports) || !isDeepStrictEqual(value.repository, manifest.repository)
      || value._nodeVersion !== "24.19.0" || value.dist?.integrity !== packageEvidence.integrity
      || value.dist?.shasum !== localSHA1 || !Array.isArray(value.dist?.signatures) || value.dist.signatures.length === 0
      || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE
      || value._npmUser?.trustedPublisher?.id !== "github") {
    throw new Error("The npm version metadata is missing exact exports, integrity, signature, or trusted-publisher state.");
  }
}

function assertNpmView(value) {
  const repository = typeof value.repository === "object" ? value.repository?.url : value.repository;
  if (value.name !== manifest.name || value.version !== manifest.version
      || value.dist?.integrity !== packageEvidence.integrity || value.dist?.shasum !== localSHA1
      || !Array.isArray(value.dist?.signatures) || value.dist.signatures.length === 0
      || value.dist?.attestations?.provenance?.predicateType !== PROVENANCE_TYPE
      || normalizeRepository(repository) !== normalizeRepository(manifest.repository.url)) {
    throw new Error("npm view did not return the exact signed, attested package coordinate.");
  }
}

function exactlyOne(attestations, predicateType) {
  const matches = attestations.filter((entry) => entry?.predicateType === predicateType);
  if (matches.length !== 1) throw new Error(`Expected exactly one npm attestation for ${predicateType}.`);
  return matches[0];
}

function decodeStatement(attestation) {
  const envelope = attestation?.bundle?.dsseEnvelope;
  if (envelope?.payloadType !== "application/vnd.in-toto+json" || !Array.isArray(envelope.signatures)
      || envelope.signatures.length === 0 || typeof envelope.payload !== "string"
      || !/^[A-Za-z0-9+/]+={0,2}$/u.test(envelope.payload)) {
    throw new Error("The npm Sigstore DSSE envelope is malformed.");
  }
  const bytes = decodeBase64Strict(envelope.payload, "npm attestation statement");
  if (bytes.byteLength === 0 || bytes.byteLength > 256 * 1024) {
    throw new Error("The npm attestation statement has an invalid size.");
  }
  return parseStrictJSONBytes(bytes, "npm attestation statement", 256 * 1024);
}

function verifyWorkflowCertificate(attestation, repositoryURL, workflowPath) {
  const encoded = attestation?.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof encoded !== "string") throw new Error("The provenance bundle is missing its signing certificate.");
  const certificateBytes = decodeBase64Strict(encoded, "npm provenance certificate");
  if (certificateBytes.byteLength > 64 * 1024) {
    throw new Error("The npm provenance certificate exceeds its size limit.");
  }
  const certificate = new X509Certificate(certificateBytes);
  if (certificate.subjectAltName !== `URI:${repositoryURL}/${workflowPath}@${SOURCE_REF}`) {
    throw new Error("The provenance signing certificate has an unexpected workflow identity.");
  }
}

async function auditRegistrySignatures() {
  const consumer = await mkdtemp(join(tmpdir(), "latchway-rn-signature-audit-"));
  try {
    const npmrc = join(consumer, ".npmrc");
    const globalconfig = join(consumer, ".global.npmrc");
    writeRegistryNpmrcs(npmrc, globalconfig, ["fund=false"]);
    await writeFile(join(consumer, "package.json"), `${JSON.stringify({
      name: "latchway-react-native-signature-audit", version: "0.0.0", private: true,
      dependencies: { [manifest.name]: manifest.version },
    }, null, 2)}\n`);
    runNpmCaptured(["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact"],
      consumer, 4 * 1024 * 1024, "npm install", npmrc);
    const lock = parseStrictJSONBytes(
      await readFile(join(consumer, "package-lock.json")), "npm consumer lock", 4 * 1024 * 1024,
    );
    if (lock.packages?.[`node_modules/${manifest.name}`]?.integrity !== packageEvidence.integrity) {
      throw new Error("The registry consumer lock does not contain the exact published integrity.");
    }
    return runNpmCaptured(["audit", "signatures", "--json"],
      consumer, 2 * 1024 * 1024, "npm audit signatures", npmrc);
  } finally {
    await rm(consumer, { recursive: true, force: true });
  }
}

function runNpmCaptured(arguments_, cwd, maximumBytes, operation, userconfig) {
  const ownedConfigurationRoot = userconfig === undefined
    ? mkdtempSync(join(tmpdir(), "latchway-rn-read-npm-"))
    : undefined;
  const controlledUserconfig = userconfig ?? join(ownedConfigurationRoot, "user.npmrc");
  const controlledGlobalconfig = userconfig === undefined
    ? join(ownedConfigurationRoot, "global.npmrc")
    : join(dirname(userconfig), ".global.npmrc");
  writeRegistryNpmrcs(controlledUserconfig, controlledGlobalconfig, ["fund=false"]);
  const environment = isolatedRegistryEnvironment(process.env, {
    cache: join(dirname(controlledUserconfig), `.npm-cache-${process.pid}`),
    excludedNames: ["NODE_AUTH_TOKEN", "NPM_TOKEN"],
    globalconfig: controlledGlobalconfig,
    userconfig: controlledUserconfig,
  });
  arguments_ = npmRegistryArguments(arguments_);
  let result;
  try {
    result = spawnSync(process.execPath, [trustedNpmCLI, ...arguments_], {
      cwd, env: environment, encoding: "buffer", maxBuffer: maximumBytes, stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    if (ownedConfigurationRoot !== undefined) {
      rmSync(ownedConfigurationRoot, { recursive: true, force: true });
    }
  }
  if (result.error !== undefined || result.status !== 0 || !Buffer.isBuffer(result.stdout)) {
    throw new Error(`${operation} failed during published-package verification.`);
  }
  if (result.stdout.byteLength === 0 || result.stdout.byteLength > maximumBytes) {
    throw new Error(`${operation} returned an invalid amount of retained output.`);
  }
  return result.stdout;
}

async function fetchBounded(rawURL, maximumBytes, accept) {
  const url = new URL(rawURL);
  if (url.protocol !== "https:" || url.origin !== REGISTRY_URL.slice(0, -1)
      || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "") {
    throw new Error("Publication verification may fetch only canonical npm registry URLs.");
  }
  const response = await fetch(url, {
    headers: { accept }, redirect: "error", signal: AbortSignal.timeout(20_000),
  });
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maximumBytes) throw new Error("npm response exceeds its size limit.");
  if (response.body === null) throw new Error("npm returned no response body.");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new Error("npm response exceeds its size limit.");
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, size);
  return { response, bytes };
}

function normalizeRepository(repository) {
  return String(repository ?? "").replace(/^git\+/u, "").replace(/\.git$/u, "").toLowerCase();
}

function jsonBytes(value) { return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"); }

function requiredEnvironment(name, pattern) {
  const value = process.env[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new Error(`Missing or invalid ${name}.`);
  return value;
}
