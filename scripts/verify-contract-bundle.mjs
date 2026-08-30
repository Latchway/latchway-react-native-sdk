import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

import {
  assertEqual,
  readJSON,
  readLock,
  repositoryRoot,
  requireLockValue,
  sha256,
} from "./release-metadata.mjs";

const suppliedPath = process.argv.slice(2).find((argument) => argument !== "--") ??
  process.env.LATCHWAY_CONTRACT_BUNDLE;
if (suppliedPath === undefined) {
  throw new Error("usage: pnpm verify:bundle -- /path/to/latchway-contract-<version>.tar.gz");
}
const archive = resolve(suppliedPath);
const lock = await readLock();
const compatibility = await readJSON("release-compatibility.json");
const version = requireLockValue(lock, "contract_version");
const expectedArchiveName = `latchway-contract-${version}.tar.gz`;
assertEqual(basename(archive), expectedArchiveName, "contract bundle file name");
assertEqual(sha256(await readFile(archive)), requireLockValue(lock, "bundle_sha256"),
  "contract bundle SHA-256");

const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" })
  .split("\n")
  .filter((entry) => entry.length > 0);
if (new Set(listing).size !== listing.length) throw new Error("Contract bundle contains duplicate paths.");
for (const entry of listing) {
  if (entry.startsWith("/") || entry.split("/").includes("..")) {
    throw new Error(`Contract bundle contains unsafe path ${entry}.`);
  }
}
for (const required of [
  "SHA256SUMS",
  "admin.openapi.yaml",
  "attestation-binding.schema.json",
  "component-attestation-binding.schema.json",
  "client.openapi.yaml",
  "config.schema.json",
  "error-codes.yaml",
  "protocol-version.json",
  "test-vectors/attestation-binding/v1.json",
  "test-vectors/attestation-binding/vector.schema.json",
  "test-vectors/component-attestation-binding/v2.json",
  "test-vectors/component-attestation-binding/vector.schema.json",
  "test-vectors/dpop/v1.json",
  "test-vectors/dpop/vector.schema.json",
  "test-vectors/installation-family/v2.json",
  "test-vectors/installation-family/vector.schema.json",
]) {
  if (!listing.includes(required)) throw new Error(`Contract bundle is missing ${required}.`);
}

const temporary = await mkdtemp(join(tmpdir(), "latchway-rn-contract-"));
try {
  execFileSync("tar", ["-xzf", archive, "-C", temporary]);
  const checksums = parseChecksums(await readFile(join(temporary, "SHA256SUMS"), "utf8"));
  const bundledFiles = listing.filter((entry) => entry !== "SHA256SUMS" && !entry.endsWith("/"));
  assertEqual(checksums.size, bundledFiles.length, "contract bundle checksum entry count");
  for (const entry of bundledFiles) {
    const expectedHash = checksums.get(entry);
    if (expectedHash === undefined) throw new Error(`SHA256SUMS omits ${entry}.`);
    assertEqual(sha256(await readFile(join(temporary, entry))), expectedHash,
      `contract bundle member ${entry}`);
  }

  const protocol = JSON.parse(await readFile(join(temporary, "protocol-version.json"), "utf8"));
  assertEqual(protocol.contract_version, compatibility.contract.version, "bundle contract version");
  assertEqual(protocol.wire_protocol?.current, compatibility.contract.wire_protocol, "bundle wire protocol");
  assertEqual(protocol.bundle?.file_name, expectedArchiveName, "protocol bundle file name");
  for (const requiredEntry of protocol.bundle?.required_entries ?? []) {
    const present = listing.includes(requiredEntry) || listing.some((entry) => entry.startsWith(`${requiredEntry}/`));
    if (!present) throw new Error(`Contract bundle omits manifest-required entry ${requiredEntry}.`);
  }
  if (!protocol.sdk_kinds?.includes("react-native")) {
    throw new Error("Contract bundle does not declare the React Native SDK kind.");
  }

  for (const [bundled, vendored] of [
    ["protocol-version.json", "test/fixtures/contract/protocol-version.json"],
    ["test-vectors/attestation-binding/v1.json", "test/fixtures/contract/attestation-binding-v1.json"],
    [
      "test-vectors/component-attestation-binding/v2.json",
      "test/fixtures/contract/component-attestation-binding-v2.json",
    ],
    ["test-vectors/dpop/v1.json", "test/fixtures/contract/dpop-v1.json"],
    ["test-vectors/installation-family/v2.json", "test/fixtures/contract/installation-family-v2.json"],
  ]) {
    const bundleBytes = await readFile(join(temporary, bundled));
    const fixtureBytes = await readFile(new URL(vendored, repositoryRoot));
    assertEqual(sha256(fixtureBytes), sha256(bundleBytes), `vendored fixture ${vendored}`);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

function parseChecksums(contents) {
  const result = new Map();
  for (const line of contents.trim().split("\n")) {
    const match = /^([0-9a-f]{64}) {2}([^\r\n]+)$/u.exec(line);
    if (match === null) throw new Error("Contract bundle SHA256SUMS is malformed.");
    if (result.has(match[2])) throw new Error(`SHA256SUMS repeats ${match[2]}.`);
    result.set(match[2], match[1]);
  }
  return result;
}
