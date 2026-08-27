import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const expected = {
  contract: "0.1.0",
  commit: "5c98dc4d656d8140e0b4af90f42ea6d884f0d60a",
  bundle: "1228820f87744334ec8091b9ebbe737500016daa844175bd1ad64fd0095d1afd",
  protocol: 1,
};
const fixtureHashes = new Map([
  ["attestation-binding-v1.json", "1e68bbf1bcd62848e41c33275670a32591cc04ab1692e749c3e21bf270624994"],
  ["dpop-v1.json", "f4c633ac1769d1e277bf0ac9a19810ded82689a4a7fa94737e68e59d7a73a649"],
  ["protocol-version.json", "a58dec0e192e29b3182c070ba9ac1d7c0f8dba724563936999011375e7012099"],
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
