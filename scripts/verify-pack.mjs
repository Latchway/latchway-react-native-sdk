import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

const root = new URL("..", import.meta.url);
const artifacts = new URL("../.artifacts/", import.meta.url);
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });
const packageManager = process.env.npm_execpath;
if (packageManager === undefined) throw new Error("Run package verification through pnpm.");
const firstDirectory = new URL("package-a/", artifacts);
const secondDirectory = new URL("package-b/", artifacts);
await Promise.all([mkdir(firstDirectory, { recursive: true }), mkdir(secondDirectory, { recursive: true })]);
const firstArchive = await pack(firstDirectory);
const secondArchive = await pack(secondDirectory);
const firstHash = digest(await readFile(firstArchive));
const secondHash = digest(await readFile(secondArchive));
if (firstHash !== secondHash) throw new Error("Two clean npm packs produced different archives.");
const archiveName = firstArchive.pathname.split("/").at(-1);
if (archiveName === undefined) throw new Error("Could not resolve npm archive name.");
const archive = new URL(archiveName, artifacts).pathname;
await copyFile(firstArchive, archive);
await writeFile(new URL(`${archiveName}.sha256`, artifacts), `${firstHash}  ${archiveName}\n`);
const archiveBytes = await readFile(archive);
const listing = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
const entries = listing.split("\n").filter((entry) => entry !== "");
for (const required of [
  "package/package.json",
  "package/contract.lock",
  "package/release-compatibility.json",
  "package/react-native.config.cjs",
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
const compatibility = JSON.parse(
  execFileSync("tar", ["-xOzf", archive, "package/release-compatibility.json"], { encoding: "utf8" }),
);
if (manifest.name !== compatibility.react_native.package || manifest.version !== compatibility.react_native.version) {
  throw new Error("Packed package identity disagrees with the release compatibility lock.");
}
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
await writeFile(
  new URL("package-evidence.json", artifacts),
  `${JSON.stringify({
    schema_version: 1,
    package: manifest.name,
    version: manifest.version,
    tarball: archiveName,
    bytes: archiveBytes.byteLength,
    sha256: firstHash,
    sha512: createHash("sha512").update(archiveBytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`,
    double_pack_byte_identical: true,
    archive_allowlist_verified: true,
    entries,
  }, null, 2)}\n`,
  { mode: 0o600 },
);

async function pack(destination) {
  const packArguments = ["pack", "--pack-destination", destination.pathname];
  if (/\.[cm]?js$/u.test(packageManager)) {
    execFileSync(process.execPath, [packageManager, ...packArguments], { cwd: root, stdio: "inherit" });
  } else {
    execFileSync(packageManager, packArguments, { cwd: root, stdio: "inherit" });
  }
  const archives = (await readdir(destination)).filter((name) => name.endsWith(".tgz"));
  if (archives.length !== 1) throw new Error("Expected exactly one npm package archive.");
  return new URL(archives[0], destination);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
