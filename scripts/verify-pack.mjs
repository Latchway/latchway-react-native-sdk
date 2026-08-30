import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  expectedPackEntries,
  inspectPackageArchive,
  readPackageArchiveSnapshot,
} from "./package-archive.mjs";

const root = new URL("..", import.meta.url);
const rootPath = fileURLToPath(root);
const artifacts = new URL("../.artifacts/", import.meta.url);

export async function finalizePackageArchiveSnapshots({
  archivePath,
  expectedEntries,
  expectedManifest,
  firstSnapshot,
  rootPath: reviewedRoot,
  secondSnapshot,
}) {
  if (!Buffer.isBuffer(firstSnapshot) || !Buffer.isBuffer(secondSnapshot)) {
    throw new Error("Package finalization requires two private archive byte snapshots.");
  }
  const inspection = await inspectPackageArchive(firstSnapshot, {
    expectedEntries,
    expectedManifest,
    rootPath: reviewedRoot,
  });
  await inspectPackageArchive(secondSnapshot, {
    expectedEntries,
    expectedManifest,
    rootPath: reviewedRoot,
  });
  if (!firstSnapshot.equals(secondSnapshot)) {
    throw new Error("Two clean npm packs produced different archives.");
  }
  const sha256 = digest(firstSnapshot);
  const sha512 = createHash("sha512").update(firstSnapshot).digest("hex");
  const integrity = `sha512-${createHash("sha512").update(firstSnapshot).digest("base64")}`;
  await writeFile(archivePath, firstSnapshot, { flag: "wx", mode: 0o600 });
  return {
    archiveBytes: firstSnapshot,
    inspection,
    integrity,
    sha256,
    sha512,
  };
}

async function main() {
  await rm(artifacts, { recursive: true, force: true });
  await mkdir(artifacts, { recursive: true });
  const packageManager = process.env.npm_execpath;
  if (packageManager === undefined) throw new Error("Run package verification through pnpm.");
  const firstDirectory = new URL("package-a/", artifacts);
  const secondDirectory = new URL("package-b/", artifacts);
  await Promise.all([mkdir(firstDirectory, { recursive: true }), mkdir(secondDirectory, { recursive: true })]);

  const firstArchive = await pack(firstDirectory, packageManager);
  const firstSnapshot = await readPackageArchiveSnapshot(fileURLToPath(firstArchive));
  const sourceManifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const expectedEntries = await expectedPackEntries(rootPath, sourceManifest);
  const secondArchive = await pack(secondDirectory, packageManager);
  const secondSnapshot = await readPackageArchiveSnapshot(fileURLToPath(secondArchive));
  const archiveName = basename(fileURLToPath(firstArchive));
  if (archiveName.length === 0) throw new Error("Could not resolve npm archive name.");
  const archive = new URL(archiveName, artifacts);
  const finalized = await finalizePackageArchiveSnapshots({
    archivePath: archive,
    expectedEntries,
    expectedManifest: sourceManifest,
    firstSnapshot,
    rootPath,
    secondSnapshot,
  });
  const { archiveBytes, inspection, integrity, sha256, sha512 } = finalized;
  await writeFile(new URL(`${archiveName}.sha256`, artifacts), `${sha256}  ${archiveName}\n`, { mode: 0o600 });

  const manifest = inspection.manifest;
  const compatibilityBytes = requiredInspectedFile(inspection, "package/release-compatibility.json");
  const compatibility = JSON.parse(compatibilityBytes.toString("utf8"));
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
    const content = requiredInspectedFile(inspection, nativeFile).toString("utf8");
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
      sha256,
      sha512,
      integrity,
      double_pack_byte_identical: true,
      archive_allowlist_verified: true,
      archive_regular_files_only: true,
      credential_scan: "passed",
      unpacked_bytes: inspection.unpackedBytes,
      entries: inspection.entries,
    }, null, 2)}\n`,
    { mode: 0o600 },
  );
}

async function pack(destination, packageManager) {
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

function requiredInspectedFile(inspection, name) {
  const bytes = inspection.files.get(name);
  if (!Buffer.isBuffer(bytes)) throw new Error(`Inspected npm archive is missing ${name}.`);
  return bytes;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
