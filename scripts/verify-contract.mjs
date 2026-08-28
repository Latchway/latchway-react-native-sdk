import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const expected = {
  contract: "0.3.0",
  commit: "05f88b41813c210a23a459519abd3f7a9c3e45fa",
  bundle: "ea265cfa750df8faeeaeac7bc60c04c4d907384205b5bf4d78a22a79dfc4d24c",
  protocol: 1,
};
const fixtureHashes = new Map([
  ["attestation-binding-v1.json", "7e832f75a15604776b52f3e57f7520b2bb518e4e51b481b992d373e7e3d1e56b"],
  ["dpop-v1.json", "130bb97d7dec579e5987b89592e4324650e28c2f17d7545fbd5cfb4a3fe5888e"],
  ["protocol-version.json", "83599fc06a7adbbfa3ba0e392756db430b97fa23c3340f3868effcbb31a4ae58"],
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
