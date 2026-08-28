import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const expected = {
  contract: "0.2.0",
  commit: "68fa1ba28a80cd3fb1e50dffdefc7de935da9f4c",
  bundle: "a4b320906d1bb02712451224c2111d3a673b4df24631c2f1de01ca5dfbfd0059",
  protocol: 1,
};
const fixtureHashes = new Map([
  ["attestation-binding-v1.json", "01889405a63c0bdb571fd69f62347972fc165218b52217395007562c4f2b5854"],
  ["dpop-v1.json", "9577fd442cec32517089d1a731d79095a240536c89ac5c98edddabb2d4c39fd2"],
  ["protocol-version.json", "582ee44393ba466e0080e8ba61dc278e1eaedb3ee653065af8ecc0215f15ebfc"],
]);

const lock = await readFile(new URL("../contract.lock", import.meta.url), "utf8");
for (const [field, value] of [
  ["contract_version", expected.contract],
  ["core_commit", expected.commit],
  ["bundle_sha256", `"${expected.bundle}"`],
  ["wire_protocol", String(expected.protocol)],
]) {
  if (!lock.split("\n").includes(`${field}: ${value}`)) {
    throw new Error(`contract.lock has an unexpected ${field}.`);
  }
}

for (const [name, expectedHash] of fixtureHashes) {
  const bytes = await readFile(new URL(`../test/fixtures/contract/${name}`, import.meta.url));
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expectedHash) throw new Error(`${name} does not match the pinned core contract.`);
}
const protocol = JSON.parse(
  await readFile(new URL("../test/fixtures/contract/protocol-version.json", import.meta.url), "utf8"),
);
if (protocol.contract_version !== expected.contract || protocol.wire_protocol.current !== expected.protocol) {
  throw new Error("The vendored protocol manifest is incompatible with contract.lock.");
}
