import { execFileSync } from "node:child_process";

import { assertEqual, readJSON, readLock, requireLockValue } from "./release-metadata.mjs";

const compatibility = await readJSON("release-compatibility.json");
const contractLock = await readLock();
const selected = new Set(process.argv.slice(2));
const verifyAll = selected.size === 0 || selected.has("--all");

if (verifyAll || selected.has("--javascript")) verifyJavaScript();
if (verifyAll || selected.has("--core-ref")) {
  verifyReleaseTag({
    repository: compatibility.contract.repository,
    source_commit: compatibility.contract.core_commit,
  }, "core", requireLockValue(contractLock, "core_release"));
}
if (verifyAll || selected.has("--native-refs")) {
  verifyReleaseTag(compatibility.ios, "iOS");
  verifyReleaseTag(compatibility.android, "Android");
}

function verifyJavaScript() {
  const specification = `${compatibility.javascript.package}@${compatibility.javascript.version}`;
  const result = JSON.parse(execFileSync(
    "npm",
    ["view", specification, "version", "gitHead", "repository.url", "--json"],
    { encoding: "utf8" },
  ));
  assertEqual(result.version, compatibility.javascript.version, "published JavaScript version");
  assertEqual(result.gitHead, compatibility.javascript.source_commit, "published JavaScript source commit");
  const repository = typeof result.repository === "object" ? result.repository?.url : result["repository.url"];
  if (repository !== undefined) {
    assertEqual(normalizeRepository(repository), normalizeRepository(compatibility.javascript.repository),
      "published JavaScript repository");
  }
}

function verifyReleaseTag(dependency, label, explicitTag) {
  const tag = explicitTag ?? `v${dependency.version}`;
  const output = execFileSync(
    "git",
    ["ls-remote", dependency.repository, `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: "utf8" },
  ).trim();
  if (output.length === 0) throw new Error(`${label} release tag ${tag} does not exist.`);
  const lines = output.split("\n").map((line) => line.split(/\s+/u));
  const peeled = lines.find(([, reference]) => reference === `refs/tags/${tag}^{}`)?.[0];
  const direct = lines.find(([, reference]) => reference === `refs/tags/${tag}`)?.[0];
  assertEqual(peeled ?? direct, dependency.source_commit, `${label} release tag commit`);
}

function normalizeRepository(repository) {
  return repository.replace(/^git\+/u, "").replace(/\.git$/u, "").toLowerCase();
}
