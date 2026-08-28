import { execFileSync } from "node:child_process";

import {
  assertEqual,
  gitOutput,
  readJSON,
  readLock,
  readText,
  repositoryRoot,
  requireLockValue,
  requireMatch,
} from "./release-metadata.mjs";

const releaseTag = process.argv.slice(2).find((argument) => argument !== "--");
if (releaseTag === undefined) throw new Error("usage: pnpm release:preflight -- vMAJOR.MINOR.PATCH[-PRERELEASE]");
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(releaseTag)) {
  throw new Error("Release tag must be a canonical semantic version without build metadata.");
}

const packageJSON = await readJSON("package.json");
const compatibility = await readJSON("release-compatibility.json");
const contract = await readLock();
const version = releaseTag.slice(1);
assertEqual(packageJSON.version, version, "release tag/package version");
assertEqual(compatibility.react_native.version, version, "release compatibility/package version");
if (packageJSON.private === true || packageJSON.publishConfig?.access !== "public") {
  throw new Error("The release package must be explicitly public.");
}
assertEqual(packageJSON.publishConfig?.registry, "https://registry.npmjs.org/", "npm release registry");
if (packageJSON.publishConfig?.provenance !== true) throw new Error("npm provenance must be enabled.");
assertEqual(packageJSON.repository?.url,
  "git+https://github.com/Latchway/latchway-react-native-sdk.git",
  "npm provenance repository");

const coreRelease = requireLockValue(contract, "core_release");
if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/u.test(coreRelease)) {
  throw new Error("contract.lock must name the immutable published core release before SDK publication.");
}

const sourceVersion = await readText("src/version.ts");
assertEqual(requireMatch(sourceVersion, /SDK_VERSION = "([^"]+)"/u, "public SDK version"), version,
  "public SDK version");
const androidBuild = await readText("android/build.gradle.kts");
assertEqual(requireMatch(androidBuild, /^version\s*=\s*"([^"]+)"/mu, "Android bridge version"), version,
  "Android bridge version");

const changelog = await readText("CHANGELOG.md");
if (!new RegExp(`^## \\[${escapeExpression(version)}\\](?: - \\d{4}-\\d{2}-\\d{2})?$`, "mu").test(changelog)) {
  throw new Error(`CHANGELOG.md must contain a ${version} release section.`);
}

if (gitOutput(repositoryRoot, "status", "--short", "--untracked-files=all") !== "") {
  throw new Error("Release checkout must be clean.");
}
assertEqual(gitOutput(repositoryRoot, "rev-parse", `${releaseTag}^{commit}`),
  gitOutput(repositoryRoot, "rev-parse", "HEAD"), "release tag commit");
assertEqual(gitOutput(repositoryRoot, "cat-file", "-t", releaseTag), "tag", "release tag object type");

const tracked = gitOutput(repositoryRoot, "ls-files").split("\n");
const forbidden = /(^|\/)(?:\.env(?:\.[^/]*)?|Pods|DerivedData|\.gradle|\.artifacts|node_modules|build)(?:\/|$)|\.(?:jks|keystore|p8|p12|mobileprovision)$/u;
const forbiddenPath = tracked.find((path) => forbidden.test(path) && !/(^|\/)\.env\.example$/u.test(path));
if (forbiddenPath !== undefined) throw new Error(`Release tree contains forbidden local or secret file ${forbiddenPath}.`);

// The release verification job has already run the installed-dependency and
// source gates. Keep this final tag check independent of node_modules so the
// publish job verifies only the immutable checkout and downloaded archive.
execFileSync(process.execPath, [
  new URL("verify-compatibility.mjs", import.meta.url).pathname,
  "--metadata-only",
], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

function escapeExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
