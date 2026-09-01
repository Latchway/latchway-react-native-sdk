import { createHash } from "node:crypto";

import { parseStrictJSONBytes } from "./release-attestation.mjs";

export const PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
export const PUBLISH_TYPE = "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
export const WORKFLOW_PATH = ".github/workflows/release.yml";
export const SOURCE_REF = "refs/heads/main";

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertSafeRetainedOutput(bytes, label, maximumBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} has an invalid retained-output size.`);
  }
  const value = parseStrictJSONBytes(bytes, label, maximumBytes);
  const text = bytes.toString("utf8");
  for (const pattern of [
    /(?:^|\n)\/\/registry\.npmjs\.org\/:_authToken\s*=/iu,
    /\b(?:npm_[A-Za-z0-9_-]{20,}|github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,})\b/u,
    /\bBearer\s+[A-Za-z0-9._~+/-]{16,}/iu,
  ]) {
    if (pattern.test(text)) throw new Error(`${label} contains credential-like material and cannot be retained.`);
  }
  return value;
}

export function parseProvenanceOrigin(invocationID, expectedRepositoryURL) {
  if (typeof invocationID !== "string") throw new Error("The npm provenance invocation identifier is missing.");
  const prefix = `${expectedRepositoryURL}/actions/runs/`;
  if (!invocationID.startsWith(prefix)) throw new Error("The npm provenance invocation repository is unexpected.");
  const match = /^([1-9]\d*)\/attempts\/([1-9]\d*)$/u.exec(invocationID.slice(prefix.length));
  if (match === null) throw new Error("The npm provenance invocation identifier is malformed.");
  const runID = Number(match[1]);
  const runAttempt = Number(match[2]);
  if (!Number.isSafeInteger(runID) || !Number.isSafeInteger(runAttempt)) {
    throw new Error("The npm provenance invocation identifier is unbounded.");
  }
  return { invocation_id: invocationID, run_id: runID, run_attempt: runAttempt };
}

export function verifyProvenanceStatement(statement, {
  packageName, packageVersion, sha512, expectedRepositoryURL, expectedCommit, expectedEvent,
}) {
  verifySubject(statement, PROVENANCE_TYPE, "https://in-toto.io/Statement/v1", {
    packageName, packageVersion, sha512,
  });
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow;
  const resolved = statement.predicate?.buildDefinition?.resolvedDependencies;
  const github = statement.predicate?.buildDefinition?.internalParameters?.github;
  const runDetails = statement.predicate?.runDetails;
  const origin = parseProvenanceOrigin(runDetails?.metadata?.invocationId, expectedRepositoryURL);
  if (
    workflow?.repository !== expectedRepositoryURL
    || workflow?.path !== WORKFLOW_PATH
    || workflow?.ref !== SOURCE_REF
    || github?.event_name !== expectedEvent
    || !Array.isArray(resolved)
    || !resolved.some((dependency) => dependency?.uri === `git+${expectedRepositoryURL}@${expectedCommit}`
      || (dependency?.digest?.gitCommit === expectedCommit
        && (dependency?.uri === undefined || String(dependency.uri).includes(expectedRepositoryURL))))
    || runDetails?.builder?.id !== "https://github.com/actions/runner/github-hosted"
  ) throw new Error("The npm provenance statement does not bind the promoted commit, workflow, event, and run.");
  return origin;
}

export function requireCurrentPublicationOrigin(origin, { publishPerformed, currentRunID, currentRunAttempt }) {
  if (publishPerformed && (origin.run_id !== currentRunID || origin.run_attempt !== currentRunAttempt)) {
    throw new Error("A freshly published npm version must carry provenance from this exact workflow attempt.");
  }
}

export function normalizePublishPerformedForConsumerAttempt(
  publishPerformed,
  { producerRunID, producerRunAttempt, currentRunID, currentRunAttempt },
) {
  const coordinates = [producerRunID, producerRunAttempt, currentRunID, currentRunAttempt];
  if (typeof publishPerformed !== "boolean"
      || coordinates.some((value) => !Number.isSafeInteger(value) || value < 1)
      || producerRunID !== currentRunID || producerRunAttempt > currentRunAttempt) {
    throw new Error("The npm publication state is not bound to a valid producer workflow attempt.");
  }
  return producerRunAttempt === currentRunAttempt && publishPerformed;
}

export function verifyPublishStatement(statement, { packageName, packageVersion, sha512, registryURL }) {
  verifySubject(statement, PUBLISH_TYPE, "https://in-toto.io/Statement/v0.1", {
    packageName, packageVersion, sha512,
  });
  if (statement.predicate?.name !== packageName || statement.predicate?.version !== packageVersion
      || statement.predicate?.registry !== registryURL.replace(/\/$/u, "")) {
    throw new Error("The npm publish attestation does not bind the exact package and registry.");
  }
}

export function buildRegistryManifest({ packageName, packageVersion, tarball, evidence }) {
  const assets = evidence.map(({ name, bytes }) => ({
    name, bytes: bytes.byteLength, sha256: sha256(bytes),
  })).sort((left, right) => left.name.localeCompare(right.name));
  return {
    schema_version: 1,
    kind: "latchway_npm_registry_evidence_manifest",
    package: packageName,
    version: packageVersion,
    tarball,
    evidence: assets,
  };
}

export function buildAdoptionRecord({
  packageName, packageVersion, releaseTag, repositoryURL, sourceCommit, provenanceOrigin,
  tarball, manifestSHA256, currentRunID, currentRunAttempt, publishPerformed,
}) {
  const binding = {
    repository: repositoryURL, commit: sourceCommit, workflow: WORKFLOW_PATH, ref: SOURCE_REF,
  };
  return {
    schema_version: 1,
    kind: "latchway_npm_release_adoption",
    package: packageName,
    version: packageVersion,
    release_tag: releaseTag,
    tarball,
    source: binding,
    provenance: { ...binding, predicate_type: PROVENANCE_TYPE, ...provenanceOrigin },
    adoption: {
      ...binding,
      run_id: currentRunID,
      run_attempt: currentRunAttempt,
      mode: publishPerformed ? "published" : "adopted_existing",
    },
    registry_evidence_manifest: { file: "npm-registry-evidence-manifest.json", sha256: manifestSHA256 },
  };
}

function verifySubject(statement, predicateType, statementType, { packageName, packageVersion, sha512 }) {
  const [scope, unscopedName] = packageName.split("/");
  const expectedPURL = `pkg:npm/${encodeURIComponent(scope)}/${unscopedName}@${packageVersion}`;
  if (statement?._type !== statementType || statement.predicateType !== predicateType
      || !Array.isArray(statement.subject) || statement.subject.length !== 1
      || statement.subject[0]?.name !== expectedPURL || statement.subject[0]?.digest?.sha512 !== sha512) {
    throw new Error(`The ${predicateType} attestation subject does not match the verified npm archive.`);
  }
}
