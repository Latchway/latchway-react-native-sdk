import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { readJSON, readLock, requireLockValue } from "./release-metadata.mjs";

const compatibility = await readJSON("release-compatibility.json");
const lock = await readLock();
const expected = compatibility.contract;
const fixtureHashes = new Map(Object.entries(expected.fixtures));
const requiredFixtureNames = [
  "attestation-binding-v1.json",
  "component-attestation-binding-v2.json",
  "dpop-v1.json",
  "installation-family-v2.json",
  "protocol-version.json",
];

if (JSON.stringify([...fixtureHashes.keys()].sort()) !== JSON.stringify(requiredFixtureNames)) {
  throw new Error("release-compatibility.json does not pin the exact canonical fixture set.");
}

for (const [field, value] of [
  ["contract_version", expected.version],
  ["core_commit", expected.core_commit],
  ["bundle_sha256", expected.bundle_sha256],
  ["wire_protocol", String(expected.wire_protocol)],
]) {
  if (requireLockValue(lock, field) !== value) throw new Error(`contract.lock has an unexpected ${field}.`);
}

for (const [name, expectedHash] of fixtureHashes) {
  const bytes = await readFile(new URL(`../test/fixtures/contract/${name}`, import.meta.url));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedHash) throw new Error(`${name} does not match the pinned core contract.`);
}
const protocol = JSON.parse(
  await readFile(new URL("../test/fixtures/contract/protocol-version.json", import.meta.url), "utf8"),
);
if (protocol.contract_version !== expected.version || protocol.wire_protocol.current !== expected.wire_protocol) {
  throw new Error("The vendored protocol manifest is incompatible with contract.lock.");
}
if (!protocol.bundle?.required_entries?.includes("component-attestation-binding.schema.json")) {
  throw new Error("The vendored protocol manifest omits the component attestation binding schema.");
}
if (
  protocol.component_attestation_binding?.version !== 2 ||
  protocol.component_attestation_binding?.purpose !== "component_attestation_step_up" ||
  protocol.component_attestation_binding?.canonicalization !== "RFC 8785 JCS" ||
  protocol.component_attestation_binding?.hash !== "SHA-256"
) {
  throw new Error("The vendored protocol manifest has an invalid component attestation binding contract.");
}
