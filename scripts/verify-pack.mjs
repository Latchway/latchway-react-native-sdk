import { execFileSync } from "node:child_process";
import { mkdir, readdir, rm } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const artifacts = new URL("../.artifacts/", import.meta.url);
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const packageManager = process.env.npm_execpath;
if (packageManager === undefined) throw new Error("Run package verification through pnpm.");
const packArguments = ["pack", "--pack-destination", ".artifacts"];
if (/\.[cm]?js$/u.test(packageManager)) {
  execFileSync(process.execPath, [packageManager, ...packArguments], { cwd: root, stdio: "inherit" });
} else {
  execFileSync(packageManager, packArguments, { cwd: root, stdio: "inherit" });
}
const archives = (await readdir(artifacts)).filter((name) => name.endsWith(".tgz"));
if (archives.length !== 1) throw new Error("Expected exactly one npm package archive.");
const archive = new URL(archives[0], artifacts).pathname;
const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
const entries = listing.split("\n");
for (const required of [
  "package/package.json",
  "package/contract.lock",
  "package/lib/index.js",
  "package/lib/index.d.ts",
  "package/src/native/NativeLatchway.ts",
  "package/ios/RCTNativeLatchway.mm",
  "package/android/build.gradle.kts",
  "package/docs/security.md",
  "package/LICENSE",
]) {
  if (!entries.includes(required)) throw new Error(`Package archive is missing ${required}.`);
}
if (entries.some((entry) => entry.startsWith("package/test/") || entry.startsWith("package/example/"))) {
  throw new Error("Package archive contains tests or the development example.");
}
if (entries.some((entry) => entry.includes("/.gradle/") || entry.includes("/build/") ||
    entry.includes("/node_modules/") || entry.includes("/.artifacts/"))) {
  throw new Error("Package archive contains local build or dependency state.");
}
const manifest = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }));
const dependencyValues = Object.values({
  ...manifest.dependencies,
  ...manifest.optionalDependencies,
  ...manifest.peerDependencies,
});
if (dependencyValues.some((value) => typeof value === "string" && /^(?:file|link|workspace):|SNAPSHOT/u.test(value))) {
  throw new Error("Published package metadata contains a local dependency override or snapshot coordinate.");
}
for (const nativeFile of ["package/android/build.gradle.kts", "package/LatchwayReactNative.podspec"]) {
  const content = execFileSync("tar", ["-xOzf", archive, nativeFile], { encoding: "utf8" });
  if (/0\.1\.0-SNAPSHOT|(?:file|link):\.\./u.test(content)) {
    throw new Error(`${nativeFile} contains a local dependency override or snapshot coordinate.`);
  }
}
