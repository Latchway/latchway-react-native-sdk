import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PROVENANCE_TYPE,
  assertSafeRetainedOutput,
  buildAdoptionRecord,
  buildRegistryManifest,
  normalizePublishPerformedForConsumerAttempt,
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
import { androidReleaseAssetNames } from "./android-release-evidence.mjs";
import {
  decodeBase64Strict,
  RELEASE_PREDICATE_TYPE,
  readBoundedStrictJSONFileSync,
  STATEMENT_TYPE,
  validateReleaseAttestation,
} from "./release-attestation.mjs";
import {
  externalPeerDependencies,
  inspectNpmArchive,
  MAXIMUM_JAVASCRIPT_ADOPTION_RECORDS,
  validateCleanJavascriptConsumer,
  validateJavascriptAdoptionClosure,
  validateJavascriptAdoptionRecord,
  validateNpmArchiveMatchesLockedPack,
} from "./javascript-release-contract.mjs";
import { validateCocoaPodsSourceBinding } from "./ios-release-evidence.mjs";
import {
  MAXIMUM_JAVASCRIPT_ADOPTION_BYTES,
  publishedDependencyAssetMaximumBytes,
  validatePublishedDependencyAssetMetadata,
} from "./published-dependency-assets.mjs";
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

test("publication state becomes adoption when only the consumer reruns", () => {
  assert.equal(normalizePublishPerformedForConsumerAttempt(true, {
    producerRunID: 41,
    producerRunAttempt: 1,
    currentRunID: 41,
    currentRunAttempt: 1,
  }), true);
  assert.equal(normalizePublishPerformedForConsumerAttempt(true, {
    producerRunID: 41,
    producerRunAttempt: 1,
    currentRunID: 41,
    currentRunAttempt: 2,
  }), false);
  assert.throws(() => normalizePublishPerformedForConsumerAttempt(true, {
    producerRunID: 41,
    producerRunAttempt: 2,
    currentRunID: 41,
    currentRunAttempt: 1,
  }), /producer workflow attempt/u);
  assert.throws(() => normalizePublishPerformedForConsumerAttempt(true, {
    producerRunID: 40,
    producerRunAttempt: 1,
    currentRunID: 41,
    currentRunAttempt: 2,
  }), /producer workflow attempt/u);
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
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from('{"ok":true,"ok":false}'), "test", 64),
    /duplicate JSON key/u,
  );
  assert.throws(
    () => assertSafeRetainedOutput(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xff, 0x7d]), "test", 64),
    /valid UTF-8/u,
  );
});

test("strict base64 decoding rejects noncanonical attestation encodings", () => {
  assert.deepEqual(decodeBase64Strict("e30=", "test"), Buffer.from("{}"));
  for (const encoded of ["e30", "e30===", "A", "e30=garbage"]) {
    assert.throws(() => decodeBase64Strict(encoded, "test"), /malformed DSSE payload encoding/u);
  }
});

test("production bounded JSON file reader rejects duplicate keys and pre-read oversize files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "latchway-rn-bounded-json-"));
  try {
    const valid = join(directory, "valid.json");
    const duplicate = join(directory, "duplicate.json");
    const oversized = join(directory, "oversized.json");
    await writeFile(valid, Buffer.from('{"ok":true}'.padEnd(64, " ")));
    await writeFile(duplicate, '{"ok":true,"ok":false}');
    await writeFile(oversized, Buffer.alloc(65, 0x20));
    assert.deepEqual(readBoundedStrictJSONFileSync(valid, "test lock", 64), { ok: true });
    assert.throws(
      () => readBoundedStrictJSONFileSync(duplicate, "test lock", 64),
      /duplicate JSON key/u,
    );
    assert.throws(
      () => readBoundedStrictJSONFileSync(oversized, "test lock", 64),
      /invalid file byte length/u,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production dependency asset metadata enforces positive safe IDs and name-specific byte ceilings", () => {
  const adoption = "npm-release-adoption-client-41-1.json";
  assert.equal(
    publishedDependencyAssetMaximumBytes("javascript", adoption),
    MAXIMUM_JAVASCRIPT_ADOPTION_BYTES,
  );
  const valid = {
    id: Number.MAX_SAFE_INTEGER,
    name: adoption,
    size: MAXIMUM_JAVASCRIPT_ADOPTION_BYTES,
    state: "uploaded",
    digest: `sha256:${"a".repeat(64)}`,
  };
  assert.equal(
    validatePublishedDependencyAssetMetadata(valid, "javascript", adoption),
    MAXIMUM_JAVASCRIPT_ADOPTION_BYTES,
  );
  for (const candidate of [
    { ...valid, id: 0 },
    { ...valid, id: Number.MAX_SAFE_INTEGER + 1 },
    { ...valid, size: MAXIMUM_JAVASCRIPT_ADOPTION_BYTES + 1 },
    { ...valid, digest: "sha256:invalid" },
  ]) assert.throws(
    () => validatePublishedDependencyAssetMetadata(candidate, "javascript", adoption),
    /invalid bounded metadata/u,
  );
  assert.equal(
    publishedDependencyAssetMaximumBytes("android", "latchway-android-1.0.0-central-portal.zip"),
    256 * 1024 * 1024,
  );
  assert.equal(
    publishedDependencyAssetMaximumBytes("ios", "latchway-ios-sdk-1.0.0.tar.gz.sha256"),
    64 * 1024,
  );
});

test("production dependency asset caps cover every fixed platform asset without a fallback", () => {
  const packageIDs = ["client", "openai", "vercel-ai", "langchain"];
  const javascript = [
    ...packageIDs.map((id) => `latchway-${id}-1.0.0.tgz`),
    "docs-bundle-1.0.0.tar.gz",
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
    ...packageIDs.flatMap((id) => [
      `npm-${id}-registry-version.json`,
      `npm-${id}-registry-view.json`,
      `npm-${id}-attestations.json`,
      `npm-${id}-audit-signatures.json`,
    ]),
    "npm-release-adoption-client-41-1.json",
  ];
  const ios = [
    "latchway-ios-sdk-1.0.0.tar.gz",
    "latchway-ios-sdk-1.0.0.tar.gz.sha256",
    "docs-bundle-1.0.0.tar.gz",
    "cocoapods-published-podspec.json",
    "cocoapods-reviewed-podspec.json",
    "cocoapods-release-evidence.json",
    "cocoapods-release-evidence.SHA256SUMS",
  ];
  for (const [kind, names] of [
    ["javascript", javascript],
    ["ios", ios],
    ["android", androidReleaseAssetNames("1.0.0")],
  ]) {
    for (const name of names) {
      const maximum = publishedDependencyAssetMaximumBytes(kind, name);
      assert.ok(Number.isSafeInteger(maximum) && maximum > 0, `${kind}/${name} has no finite cap`);
    }
  }
  assert.throws(
    () => publishedDependencyAssetMaximumBytes("javascript", "unreviewed.bin"),
    /unbounded asset/u,
  );
});

test("production CocoaPods source binding rejects proof, repository, tag, and schema substitutions", () => {
  const repository = "https://github.com/Latchway/latchway-ios-sdk.git";
  const source = { git: repository, tag: "v1.0.0" };
  assert.doesNotThrow(() => validateCocoaPodsSourceBinding(source, source, repository, "v1.0.0"));
  for (const [proof, published] of [
    [{ ...source, tag: "v2.0.0" }, source],
    [source, { ...source, git: "https://github.com/attacker/repo.git" }],
    [{ ...source, branch: "main" }, source],
  ]) assert.throws(
    () => validateCocoaPodsSourceBinding(proof, published, repository, "v1.0.0"),
    /does not match the bound published podspec/u,
  );
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
    `${repository}/actions/runs/9007199254740992/attempts/1`,
  ]) assert.throws(() => parseProvenanceOrigin(value, repository), /provenance/u);
});

test("production JavaScript archive verifier rejects dist bytes that differ from locked source output", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "latchway-rn-javascript-archive-"));
  try {
    const packageRoot = join(temporary, "package");
    await mkdir(join(packageRoot, "dist"), { recursive: true });
    const manifest = Buffer.from(`${JSON.stringify({
      name: "@latchway/client",
      version: "1.0.0",
    })}\n`);
    const lock = await readFile(new URL("../contract.lock", import.meta.url));
    const expectedDist = Buffer.from("export const trusted = true;\n");
    const package_ = {
      id: "client", package: "@latchway/client", version: "1.0.0",
    };
    const entries = ["package/contract.lock", "package/dist/index.js", "package/package.json"].sort();
    const evidence = {
      entries,
      unpacked_bytes: manifest.byteLength + lock.byteLength + expectedDist.byteLength,
      published_peer_dependencies: {},
    };
    const reproducibility = {
      publishedPeerDependencies: new Map([[package_.package, {}]]),
      files: [{
        package: package_.package,
        path: "dist/index.js",
        bytes: expectedDist.byteLength,
        sha256: sha256(expectedDist),
      }],
    };

    const createArchive = async (name, dist) => {
      await writeFile(join(packageRoot, "package.json"), manifest);
      await writeFile(join(packageRoot, "contract.lock"), lock);
      await writeFile(join(packageRoot, "dist", "index.js"), dist);
      const archive = join(temporary, name);
      execFileSync("tar", ["-czf", archive, "-C", temporary, ...entries]);
      return archive;
    };

    const valid = await createArchive("valid.tgz", expectedDist);
    inspectNpmArchive(valid, package_, evidence, reproducibility);
    const lockedSourcePack = await readFile(valid);
    validateNpmArchiveMatchesLockedPack(lockedSourcePack, lockedSourcePack, package_);
    assert.throws(
      () => inspectNpmArchive(valid, package_, {
        ...evidence,
        published_peer_dependencies: { openai: "7.8.1" },
      }, reproducibility),
      /peer dependencies differ from locked source/u,
    );

    const changedDist = Buffer.from(expectedDist);
    changedDist[changedDist.indexOf("true")] = "f".charCodeAt(0);
    const changed = await createArchive("changed.tgz", changedDist);
    assert.throws(
      () => inspectNpmArchive(changed, package_, evidence, reproducibility),
      /dist bytes differ from locked source output/u,
    );
    const changedArchive = await readFile(changed);
    assert.throws(
      () => validateNpmArchiveMatchesLockedPack(changedArchive, lockedSourcePack, package_),
      /not byte-identical to the locked-source pack/u,
    );

    const extraDist = Buffer.from("export const unreviewed = true;\n");
    const extraEntry = "package/dist/extra.js";
    await writeFile(join(packageRoot, "dist", "index.js"), expectedDist);
    await writeFile(join(packageRoot, "dist", "extra.js"), extraDist);
    const extraEntries = [...entries, extraEntry].sort();
    const extraArchive = join(temporary, "extra.tgz");
    execFileSync("tar", ["-czf", extraArchive, "-C", temporary, ...extraEntries]);
    assert.throws(
      () => inspectNpmArchive(extraArchive, package_, {
        ...evidence,
        entries: extraEntries,
        unpacked_bytes: evidence.unpacked_bytes + extraDist.byteLength,
      }, reproducibility),
      /dist bytes differ from locked source output/u,
    );
    const extraArchiveBytes = await readFile(extraArchive);
    assert.throws(
      () => validateNpmArchiveMatchesLockedPack(extraArchiveBytes, lockedSourcePack, package_),
      /not byte-identical to the locked-source pack/u,
    );

    const omittedEntries = entries.filter((entry) => entry !== "package/dist/index.js");
    const omittedArchive = join(temporary, "omitted.tgz");
    execFileSync("tar", ["-czf", omittedArchive, "-C", temporary, ...omittedEntries]);
    assert.throws(
      () => inspectNpmArchive(omittedArchive, package_, {
        ...evidence,
        entries: omittedEntries,
        unpacked_bytes: manifest.byteLength + lock.byteLength,
      }, reproducibility),
      /omits locked source output/u,
    );
    const omittedArchiveBytes = await readFile(omittedArchive);
    assert.throws(
      () => validateNpmArchiveMatchesLockedPack(omittedArchiveBytes, lockedSourcePack, package_),
      /not byte-identical to the locked-source pack/u,
    );

    const substitutedManifest = Buffer.from(`${JSON.stringify({
      name: "@latchway/client",
      version: "1.0.0",
      scripts: { preinstall: "node payload.js" },
      exports: { ".": "./payload.js" },
    })}\n`);
    const payload = Buffer.from('throw new Error("unreviewed lifecycle payload");\n');
    await writeFile(join(packageRoot, "package.json"), substitutedManifest);
    await writeFile(join(packageRoot, "payload.js"), payload);
    const substitutedEntries = [...entries, "package/payload.js"].sort();
    const substitutedArchive = join(temporary, "substituted.tgz");
    execFileSync("tar", ["-czf", substitutedArchive, "-C", temporary, ...substitutedEntries]);
    assert.doesNotThrow(() => inspectNpmArchive(substitutedArchive, package_, {
      ...evidence,
      entries: substitutedEntries,
      unpacked_bytes: expectedDist.byteLength + lock.byteLength
        + substitutedManifest.byteLength + payload.byteLength,
    }, reproducibility));
    const substitutedArchiveBytes = await readFile(substitutedArchive);
    assert.throws(
      () => validateNpmArchiveMatchesLockedPack(substitutedArchiveBytes, lockedSourcePack, package_),
      /not byte-identical to the locked-source pack/u,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("production JavaScript retry verifier binds mode, filename, exact schema, and manifest", () => {
  const sourceBinding = {
    repository: "https://github.com/Latchway/latchway-js",
    commit,
    workflow: ".github/workflows/release.yml",
    ref: "refs/heads/main",
  };
  const provenanceOrigin = {
    invocation_id: `${sourceBinding.repository}/actions/runs/41/attempts/1`,
    run_id: 41,
    run_attempt: 1,
  };
  const tarball = {
    name: "latchway-client-1.0.0.tgz",
    bytes: 123,
    sha256: "d".repeat(64),
    sha512: "e".repeat(128),
    integrity: `sha512-${Buffer.from("e".repeat(128), "hex").toString("base64")}`,
  };
  const manifestSHA = "f".repeat(64);
  const package_ = { id: "client", package: "@latchway/client" };
  const validate = (name, adoption) => validateJavascriptAdoptionRecord({
    name,
    adoption,
    package_,
    manifestEntry: { tarball },
    provenanceOrigin,
    sourceBinding,
    version: "1.0.0",
    tag: "v1.0.0",
    manifestSHA,
  });
  const published = buildAdoptionRecord({
    packageName: package_.package,
    packageVersion: "1.0.0",
    releaseTag: "v1.0.0",
    repositoryURL: sourceBinding.repository,
    sourceCommit: commit,
    provenanceOrigin,
    tarball,
    manifestSHA256: manifestSHA,
    currentRunID: 41,
    currentRunAttempt: 1,
    publishPerformed: true,
  });
  validate("npm-release-adoption-client-41-1.json", published);

  const adopted = structuredClone(published);
  adopted.adoption.run_id = 99;
  adopted.adoption.run_attempt = 2;
  adopted.adoption.mode = "adopted_existing";
  validate("npm-release-adoption-client-99-2.json", adopted);

  const falsePublication = structuredClone(adopted);
  falsePublication.adoption.mode = "published";
  assert.throws(
    () => validate("npm-release-adoption-client-99-2.json", falsePublication),
    /not bound to the locked source and provenance/u,
  );
  const extraKey = structuredClone(adopted);
  extraKey.unexpected = true;
  assert.throws(
    () => validate("npm-release-adoption-client-99-2.json", extraKey),
    /not bound to the locked source and provenance/u,
  );
  assert.throws(
    () => validate("npm-release-adoption-client-99-3.json", adopted),
    /not bound to the locked source and provenance/u,
  );
});

test("production JavaScript retry history requires complete four-package attempt groups", () => {
  const ids = ["client", "openai", "vercel-ai", "langchain"];
  const closure = ids.map((id) => `npm-release-adoption-${id}-41-1.json`);
  assert.doesNotThrow(() => validateJavascriptAdoptionClosure(closure, ids));
  assert.throws(
    () => validateJavascriptAdoptionClosure([
      closure[0],
      ...ids.slice(1).map((id) => `npm-release-adoption-${id}-42-1.json`),
    ], ids),
    /exact four-package closure/u,
  );
  assert.throws(
    () => validateJavascriptAdoptionClosure([...closure, closure[0]], ids),
    /unique non-empty package closure/u,
  );
  const maximum = Array.from({ length: MAXIMUM_JAVASCRIPT_ADOPTION_RECORDS / ids.length }, (_, index) => (
    ids.map((id) => `npm-release-adoption-${id}-${index + 1}-1.json`)
  )).flat();
  assert.doesNotThrow(() => validateJavascriptAdoptionClosure(maximum, ids));
  assert.throws(
    () => validateJavascriptAdoptionClosure([
      ...maximum,
      ...ids.map((id) => `npm-release-adoption-${id}-999-1.json`),
    ], ids),
    /unique non-empty package closure/u,
  );
});

test("production clean-consumer verifier requires the exact external peer closure", () => {
  const package_ = { id: "vercel-ai", package: "@latchway/vercel-ai" };
  const peers = externalPeerDependencies({
    "@ai-sdk/openai": "4.0.52",
    "@latchway/client": "^1.0.0",
    ai: "7.0.85",
  }, package_);
  const consumer = {
    isolated_directory: true,
    install_scripts: "disabled",
    exact_package_version: "1.0.0",
    matching_client_version: "1.0.0",
    external_peer_dependencies: peers,
    node_esm: true,
    registry_signatures: true,
  };
  validateCleanJavascriptConsumer(consumer, package_, "1.0.0", peers);
  assert.throws(
    () => validateCleanJavascriptConsumer({ ...consumer, external_peer_dependencies: {} }, package_, "1.0.0", peers),
    /clean-consumer evidence is incomplete/u,
  );
});

test("production inline dependency-release policy rejects malformed retry closures", async () => {
  const workflows = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/native-consumer.yml", import.meta.url), "utf8"),
  ]);
  const fixed = ["fixed.json"];
  const adoptionNames = ["client", "openai", "vercel-ai", "langchain"]
    .map((id) => `npm-release-adoption-${id}-41-1.json`);
  const valid = dependencyReleaseFixture([...fixed, ...adoptionNames]);
  for (const [index, workflow] of workflows.entries()) {
    assert.match(workflow, /\(\( expected_size <= 536870912 \)\)/u);
    assert.match(workflow, /\| head -c "\$\(\(expected_size \+ 1\)\)"/u);
    const policy = dependencyReleasePolicy(workflow);
    assert.doesNotThrow(() => executeDependencyReleasePolicy(policy, valid, fixed));
    assert.throws(() => executeDependencyReleasePolicy(
      policy, dependencyReleaseFixture([...fixed, ...adoptionNames.slice(0, -1)]), fixed,
    ));
    assert.throws(() => executeDependencyReleasePolicy(
      policy,
      dependencyReleaseFixture([
        ...fixed,
        adoptionNames[0],
        ...["openai", "vercel-ai", "langchain"]
          .map((id) => `npm-release-adoption-${id}-42-1.json`),
      ]),
      fixed,
    ));
    assert.throws(() => executeDependencyReleasePolicy(
      policy, dependencyReleaseFixture([...fixed, ...adoptionNames, "unexpected.json"]), fixed,
    ));
    assert.throws(() => executeDependencyReleasePolicy(
      policy, dependencyReleaseFixture([...fixed, adoptionNames[0], adoptionNames[0], ...adoptionNames.slice(1)]), fixed,
    ));

    const attestationFunction = bashFunction(workflow, "requires_build_attestation");
    assert.doesNotThrow(() => execFileSync("bash", ["-c", `${attestationFunction}\n`
      + "requires_build_attestation ios latchway-ios-sdk-1.0.0.tar.gz.sha256"]));
    assert.throws(() => execFileSync("bash", ["-c", `${attestationFunction}\n`
      + "requires_build_attestation unsupported unknown.bin"]));

    const retryFunction = bashFunction(workflow, "retry_to_file");
    await executeRetryToFilePolicy(retryFunction, `retry-${index}`, "bounded", 7);
    await assert.rejects(
      executeRetryToFilePolicy(retryFunction, `retry-oversized-${index}`, "oversized", 7),
    );
  }
});

test("attempt-qualified workflow artifacts are downloaded through producer job outputs", async () => {
  const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const native = await readFile(new URL("../.github/workflows/native-consumer.yml", import.meta.url), "utf8");
  for (const workflow of [release, native]) {
    const uploads = artifactActionNames(workflow, "upload");
    const downloads = artifactActionNames(workflow, "download");
    assert.ok(uploads.length > 0 && downloads.length > 0);
    assert.ok(uploads.every((name) => name.includes("${{ steps.")),
      "each in-run artifact must use the producing step's exact identity");
    assert.ok(downloads.every((name) => name.includes("${{ needs.")),
      "each in-run artifact download must use a direct producer job output");
  }

  const releaseBindings = [
    ["verify-promotion", "authorize-promotion", "needs.authorize-promotion.outputs.artifact_name"],
    ["verify", "locked-sources", "needs.locked-sources.outputs.javascript_artifact_name"],
    ["verify", "published-dependencies", "needs.published-dependencies.outputs.artifact_name"],
    ["android", "locked-sources", "needs.locked-sources.outputs.javascript_artifact_name"],
    ["ios", "locked-sources", "needs.locked-sources.outputs.javascript_artifact_name"],
    ["npm-publish", "verify", "needs.verify.outputs.release_artifact_name"],
    ["npm-publish", "trusted-npm-cli", "needs.trusted-npm-cli.outputs.artifact_name"],
    ["publish", "verify", "needs.verify.outputs.release_artifact_name"],
    ["publish", "trusted-npm-cli", "needs.trusted-npm-cli.outputs.artifact_name"],
    ["github-release", "publish", "needs.publish.outputs.github_release_artifact_name"],
  ];
  for (const [consumer, producer, reference] of releaseBindings) {
    const block = workflowJob(release, consumer);
    assert.match(block, new RegExp(`needs:[^\\n]*\\b${producer}\\b`, "u"), `${consumer} omits ${producer}`);
    assert.ok(block.includes(reference), `${consumer} does not use the stored ${producer} artifact name`);
  }
  const npmPublish = workflowJob(release, "npm-publish");
  assert.match(npmPublish, /producer_run_id: \$\{\{ steps\.registry\.outputs\.producer_run_id \}\}/u);
  assert.match(npmPublish, /producer_run_attempt: \$\{\{ steps\.registry\.outputs\.producer_run_attempt \}\}/u);
  const registryEvidence = workflowJob(release, "publish");
  assert.match(registryEvidence,
    /PUBLISH_PRODUCER_RUN_ID: \$\{\{ needs\.npm-publish\.outputs\.producer_run_id \}\}/u);
  assert.match(registryEvidence,
    /PUBLISH_PRODUCER_RUN_ATTEMPT: \$\{\{ needs\.npm-publish\.outputs\.producer_run_attempt \}\}/u);
  for (const consumer of ["android", "ios"]) {
    const block = workflowJob(native, consumer);
    assert.match(block, /needs: authenticate-inputs/u);
    assert.match(block, /needs\.authenticate-inputs\.outputs\.artifact_name/u);
  }
  for (const producer of [
    "authorize-promotion", "locked-sources", "published-dependencies", "verify", "trusted-npm-cli", "publish",
  ]) {
    const block = workflowJob(release, producer);
    assert.match(block, /outputs:\n/u, `${producer} does not export its artifact identity`);
    assert.match(block, /GITHUB_RUN_ATTEMPT/u, `${producer} does not bind its own attempt`);
  }
  const nativeProducer = workflowJob(native, "authenticate-inputs");
  assert.match(nativeProducer, /artifact_name: \$\{\{ steps\.seal\.outputs\.artifact_name \}\}/u);
  assert.match(nativeProducer, /GITHUB_RUN_ATTEMPT/u);
});

test("each dependency verifier consumes fresh deterministic locked-source JavaScript packs", async () => {
  const command = "node scripts/verify-published-dependencies.mjs --all";
  const release = await readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const releaseVerifier = workflowJob(release, "verify");
  assert.ok(releaseVerifier.indexOf("pnpm pack:check") >= 0);
  assert.ok(releaseVerifier.indexOf("pnpm pack:check") < releaseVerifier.indexOf(command));

  const native = await readFile(new URL("../.github/workflows/native-consumer.yml", import.meta.url), "utf8");
  for (const consumer of ["android", "ios"]) {
    const job = workflowJob(native, consumer);
    const pack = "pnpm --dir ../latchway-js pack:check";
    assert.ok(job.indexOf(pack) >= 0, `${consumer} omits the locked-source pack gate`);
    assert.ok(job.indexOf(pack) < job.indexOf(command), `${consumer} verifies before deterministic packing`);
  }
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
    "docs-bundle-$RELEASE_VERSION.tar.gz",
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
  const githubDraftJob = workflow.slice(
    workflow.indexOf("\n  github-draft:\n"),
    workflow.indexOf("\n  npm-publish:\n"),
  );
  assert.ok(
    githubDraftJob.includes('. == ("docs-bundle-" + $version + ".tar.gz")'),
    "draft reconciliation omits the documentation bundle",
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
  assert.match(documentation, /credential-helper-disabled anonymous HTTPS/u);
  assert.match(documentation, /fails closed without an\s+anonymous retry/u);
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
  assert.equal(source.match(/execFileSync\("git"/gu)?.length ?? 0, 2,
    "Git use must remain limited to one authenticated tag read and one local source-identity read");
  const remoteGitStart = source.indexOf('execFileSync("git", ["-c",');
  const gitRead = source.slice(remoteGitStart, source.indexOf("}).trim()", remoteGitStart));
  assert.match(gitRead, /\["-c", "credential\.helper=", "ls-remote"/u);
  assert.match(gitRead, /env: authenticatedGitEnvironment\(\)/u);
  const localGitStart = source.indexOf('execFileSync("git", ["-C", sourceRoot,');
  const localGitRead = source.slice(localGitStart, source.indexOf("}).trim()", localGitStart));
  assert.match(localGitRead, /\["-C", sourceRoot, "rev-parse", "--verify", "HEAD"\]/u);
  assert.doesNotMatch(localGitRead, /ls-remote|authenticatedGitEnvironment|https?:\/\//u);
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
  const javascriptContract = await readFile(
    new URL("javascript-release-contract.mjs", import.meta.url),
    "utf8",
  );
  const verifierSource = `${source}\n${javascriptContract}\n${androidContract}`;
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
    "JAVASCRIPT_RELEASE_PACKAGES",
    "The React Native JavaScript dependency must be the client entry",
    "fixed.length !== 31",
    "latchway_npm_package_set_evidence",
    "latchway_npm_registry_package_set_evidence_manifest",
    "latchway_npm_publish_input_evidence",
    "latchway_npm_package_set_publication_evidence",
    "npm-release-adoption-(client|openai|vercel-ai|langchain)",
    "validatePackageSetConsumer",
    "validateJavascriptContractEvidence",
    "JavaScript contract evidence does not match the React Native contract lock and fixtures",
    'digest(readFileSync(fileURLToPath(new URL("../contract.lock", import.meta.url))))',
    "inspectNpmArchive",
    "unpackedBytes !== evidence.unpacked_bytes",
    "manifest.peerDependencies ?? {}",
    "package/contract.lock",
    "exact React Native contract lock",
    "inspectJavascriptReproducibility",
    "The locally built JavaScript source does not match the locked release commit",
    "isDeepStrictEqual(reproducibility.files, reviewedReproducibility.files)",
    'hash.update(repositoryPath).update("\\0").update(bytes).update("\\0")',
    "matching_client_version",
    'publication.publication_mode !== "published"',
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
  for (const packageName of [
    "@latchway/client", "@latchway/openai", "@latchway/vercel-ai", "@latchway/langchain",
  ]) assert.ok(source.includes(packageName), `dependency verifier omits ${packageName}`);
  for (const workflow of [
    releaseWorkflow,
    await readFile(new URL("../.github/workflows/native-consumer.yml", import.meta.url), "utf8"),
  ]) {
    assert.doesNotMatch(workflow, /\b(?:all|any)\([^;\n]+ as \$[A-Za-z_][A-Za-z0-9_]*;/u,
      "jq all/any generators must bind variables inside the condition pipeline");
    const closureStart = workflow.indexOf("javascript_assets=(\n");
    const closureEnd = workflow.indexOf("\n          )", closureStart);
    assert.ok(closureStart >= 0 && closureEnd > closureStart, "JavaScript dependency asset closure is missing");
    const closure = workflow.slice(closureStart + "javascript_assets=(\n".length, closureEnd)
      .split("\n").map((line) => line.trim()).filter(Boolean);
    assert.equal(closure.length, 31, "JavaScript dependency closure must contain exactly 31 fixed assets");
    assert.equal(new Set(closure).size, closure.length, "JavaScript dependency closure contains duplicate assets");
    assert.deepEqual(closure, [
      '"latchway-client-$JAVASCRIPT_VERSION.tgz"',
      '"latchway-openai-$JAVASCRIPT_VERSION.tgz"',
      '"latchway-vercel-ai-$JAVASCRIPT_VERSION.tgz"',
      '"latchway-langchain-$JAVASCRIPT_VERSION.tgz"',
      '"docs-bundle-$JAVASCRIPT_VERSION.tar.gz"',
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
      "npm-client-registry-version.json",
      "npm-client-registry-view.json",
      "npm-client-attestations.json",
      "npm-client-audit-signatures.json",
      "npm-openai-registry-version.json",
      "npm-openai-registry-view.json",
      "npm-openai-attestations.json",
      "npm-openai-audit-signatures.json",
      "npm-vercel-ai-registry-version.json",
      "npm-vercel-ai-registry-view.json",
      "npm-vercel-ai-attestations.json",
      "npm-vercel-ai-audit-signatures.json",
      "npm-langchain-registry-version.json",
      "npm-langchain-registry-view.json",
      "npm-langchain-attestations.json",
      "npm-langchain-audit-signatures.json",
    ], "JavaScript dependency closure must match the verifier exactly");
    for (const marker of [
      "latchway-openai-$JAVASCRIPT_VERSION.tgz",
      "latchway-vercel-ai-$JAVASCRIPT_VERSION.tgz",
      "latchway-langchain-$JAVASCRIPT_VERSION.tgz",
      "npm-client-registry-version.json",
      "npm-openai-registry-view.json",
      "npm-vercel-ai-attestations.json",
      "npm-langchain-audit-signatures.json",
      "dependency-vulnerability-scan.json",
      "npm-release-adoption-(client|openai|vercel-ai|langchain)",
    ]) assert.ok(workflow.includes(marker), `dependency authentication workflow omits ${marker}`);
    for (const [name, expected] of [
      ["ios_assets", [
        '"latchway-ios-sdk-$IOS_VERSION.tar.gz"',
        '"latchway-ios-sdk-$IOS_VERSION.tar.gz.sha256"',
        '"docs-bundle-$IOS_VERSION.tar.gz"',
        "cocoapods-published-podspec.json",
        "cocoapods-reviewed-podspec.json",
        "cocoapods-release-evidence.json",
        "cocoapods-release-evidence.SHA256SUMS",
      ]],
      ["android_assets", [
        '"latchway-android-$ANDROID_VERSION-maven-repository.zip"',
        '"latchway-android-$ANDROID_VERSION-central-portal.zip"',
        '"docs-bundle-$ANDROID_VERSION.tar.gz"',
        "SHA256SUMS",
        "github-release-tag-binding.json",
        "latchway-maven-signing-public-key.asc",
        "maven-central-upload-intent.json",
        "maven-central-deployment.json",
        "maven-central-deployment-status.json",
        "maven-central-release-evidence.json",
      ]],
    ]) {
      const start = workflow.indexOf(`${name}=(\n`);
      const end = workflow.indexOf("\n          )", start);
      assert.ok(start >= 0 && end > start, `${name} dependency asset closure is missing`);
      const observed = workflow.slice(start + `${name}=(\n`.length, end)
        .split("\n").map((line) => line.trim()).filter(Boolean);
      assert.deepEqual(observed, expected, `${name} dependency closure must match the verifier exactly`);
    }
  }
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

function dependencyReleaseFixture(names) {
  return {
    tag_name: "v1.0.0",
    draft: false,
    immutable: true,
    assets: names.map((name, index) => ({ id: index + 1, name, size: 1, state: "uploaded" })),
  };
}

function dependencyReleasePolicy(workflow) {
  const anchor = 'jq --exit-status --arg tag "$tag" --arg kind "$kind" --argjson fixed "$fixed_json" \'';
  const start = workflow.indexOf(anchor);
  assert.ok(start >= 0, "dependency release policy jq invocation is missing");
  const programStart = start + anchor.length;
  const end = workflow.indexOf('\n            \' "$directory/release.json"', programStart);
  assert.ok(end > programStart, "dependency release policy jq program is incomplete");
  return workflow.slice(programStart, end);
}

function executeDependencyReleasePolicy(policy, release, fixed) {
  execFileSync("jq", [
    "--exit-status",
    "--arg", "tag", "v1.0.0",
    "--arg", "kind", "javascript",
    "--argjson", "fixed", JSON.stringify(fixed),
    policy,
  ], {
    input: JSON.stringify(release),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function bashFunction(workflow, name) {
  const start = workflow.indexOf(`${name}() {`);
  assert.ok(start >= 0, `${name} is missing from dependency workflow`);
  const end = workflow.indexOf("\n          }", start);
  assert.ok(end > start, `${name} is incomplete in dependency workflow`);
  return workflow.slice(start, end + "\n          }".length);
}

async function executeRetryToFilePolicy(functionSource, stem, payload, maximumBytes) {
  const temporary = await mkdtemp(join(tmpdir(), `latchway-rn-${stem}-`));
  try {
    const output = join(temporary, "captured.txt");
    execFileSync("bash", ["-c", `${functionSource}
seq() { printf '%s\\n' 180; }
sleep() { :; }
producer() { printf '%s' "$PAYLOAD"; }
retry_to_file "$OUTPUT" "$MAXIMUM_BYTES" producer
test "$(cat "$OUTPUT")" = "$PAYLOAD"
`], {
      env: {
        ...process.env,
        MAXIMUM_BYTES: String(maximumBytes),
        OUTPUT: output,
        PAYLOAD: payload,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

function workflowJob(workflow, name) {
  const anchor = `\n  ${name}:\n`;
  const start = workflow.indexOf(anchor);
  assert.ok(start >= 0, `workflow job ${name} is missing`);
  const remainder = workflow.slice(start + anchor.length);
  const next = /\n {2}[a-z0-9][a-z0-9_-]*:\n/u.exec(remainder);
  return next === null ? remainder : remainder.slice(0, next.index);
}

function artifactActionNames(workflow, operation) {
  const pattern = new RegExp(
    `uses: actions/${operation}-artifact@[^\\n]+\\n\\s+with:\\n\\s+name: ([^\\n]+)`,
    "gu",
  );
  return [...workflow.matchAll(pattern)].map((match) => match[1].trim());
}
