import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const expected = {
  contract: "0.1.0",
  commit: "0a03d9369c0ebcf793f00bac6b002d1caaea6b8e",
  bundle: "74fc7ada8d835d46b25f763a703b79003cdc8243d6f4b2509645e5a82367ab12",
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
