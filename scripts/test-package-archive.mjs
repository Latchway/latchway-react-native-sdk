import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, open, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import {
  assertExactArchiveEntries,
  assertPackagedManifest,
  assertSafeArchiveEntry,
  expectedPackEntries,
  inspectPackageArchive,
  readPackageArchiveSnapshot,
} from "./package-archive.mjs";
import { finalizePackageArchiveSnapshots } from "./verify-pack.mjs";

test("publication inputs expand to an exact regular-file allowlist", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-input-"));
  try {
    await mkdir(join(root, "lib"));
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "README.md"), "read me\n");
    await writeFile(join(root, "lib", "index.js"), "export {};\n");
    assert.deepEqual(await expectedPackEntries(root, { files: ["lib", "README.md"] }), [
      "package/README.md",
      "package/lib/index.js",
      "package/package.json",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication inputs reject symbolic links", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-link-"));
  try {
    await mkdir(join(root, "lib"));
    await writeFile(join(root, "package.json"), "{}\n");
    await writeFile(join(root, "outside.js"), "export {};\n");
    await symlink(join(root, "outside.js"), join(root, "lib", "linked.js"));
    await assert.rejects(expectedPackEntries(root, { files: ["lib"] }), /symbolic link/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("publication inputs enforce per-file and aggregate size bounds before packing", async () => {
  const oversizedRoot = await mkdtemp(join(tmpdir(), "latchway-rn-pack-source-file-"));
  try {
    await writeFile(join(oversizedRoot, "package.json"), "{}\n");
    await sparseFile(join(oversizedRoot, "README.md"), (10 * 1024 * 1024) + 1);
    await assert.rejects(
      expectedPackEntries(oversizedRoot, { files: ["README.md"] }),
      /Release input exceeds 10 MiB/u,
    );
  } finally {
    await rm(oversizedRoot, { recursive: true, force: true });
  }

  const aggregateRoot = await mkdtemp(join(tmpdir(), "latchway-rn-pack-source-total-"));
  try {
    await writeFile(join(aggregateRoot, "package.json"), "{}\n");
    await mkdir(join(aggregateRoot, "files"));
    for (let index = 0; index < 6; index += 1) {
      await sparseFile(join(aggregateRoot, "files", `${index}.bin`), 9 * 1024 * 1024);
    }
    await assert.rejects(
      expectedPackEntries(aggregateRoot, { files: ["files"] }),
      /publication allowlist exceeds 50 MiB/u,
    );
  } finally {
    await rm(aggregateRoot, { recursive: true, force: true });
  }
});

test("archive paths and exact closure fail closed", () => {
  for (const entry of [
    "../package.json",
    "package/../secret",
    "package\\secret",
    "package/",
    "package//file",
    "package/line\nbreak",
  ]) {
    assert.throws(() => assertSafeArchiveEntry(entry), /Unsafe npm archive/u);
  }
  assert.doesNotThrow(() => assertSafeArchiveEntry("package/lib/index.js"));
  assert.throws(
    () => assertExactArchiveEntries(["package/package.json", "package/lib/extra.js"], ["package/package.json"]),
    /exactly match/u,
  );
});

test("packaged manifests reject lifecycle hooks and publishing drift", () => {
  const expected = releaseManifest();
  const actual = packagedManifest(expected);
  assert.doesNotThrow(() => assertPackagedManifest(actual, expected));
  assert.equal(actual.scripts.prepack, undefined);
  for (const name of [
    "preinstall",
    "install",
    "postinstall",
    "preprepare",
    "prepare",
    "postprepare",
    "predependencies",
    "dependencies",
    "postdependencies",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
    "publish",
    "postpublish",
  ]) {
    assert.throws(
      () => assertPackagedManifest({
        ...actual,
        scripts: { ...actual.scripts, [name]: "node exploit.mjs" },
      }, expected),
      new RegExp(`${name} lifecycle script`, "u"),
    );
  }
  assert.throws(
    () => assertPackagedManifest({
      ...actual,
      scripts: { ...actual.scripts, precheck: "node exploit.mjs" },
    }, expected),
    /scripts differ from the exact reviewed publication map/u,
  );
  assert.throws(
    () => assertPackagedManifest({ ...expected, dependencies: { unsafe: "file:../unsafe" } }, expected),
    /dependencies/u,
  );
});

test("the real source manifest permits exactly the controlled prepack removal", async () => {
  const source = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(source.scripts.prepack, "pnpm build");
  const packaged = packagedManifest(source);
  assert.doesNotThrow(() => assertPackagedManifest(packaged, source));
  assert.throws(
    () => assertPackagedManifest({ ...packaged, scripts: { ...packaged.scripts, prepack: "pnpm build" } }, source),
    /prepack lifecycle script/u,
  );
  const missingScript = structuredClone(packaged);
  delete missingScript.scripts.check;
  assert.throws(
    () => assertPackagedManifest(missingScript, source),
    /scripts differ from the exact reviewed publication map/u,
  );
});

test("archive inspection rejects credential-like content in an allowed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-secret-"));
  try {
    const manifest = releaseManifest();
    await writeFile(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(root, "README.md"), `token=github_pat_${"a".repeat(30)}\n`);
    await writeFile(join(root, "contract.lock"), "contract\n");
    await writeFile(join(root, "release-compatibility.json"), "{}\n");
    const stage = join(root, "stage", "package");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "package.json"), `${JSON.stringify(packagedManifest(manifest))}\n`);
    for (const name of ["README.md", "contract.lock", "release-compatibility.json"]) {
      const contents = await readFile(join(root, name));
      await writeFile(join(stage, name), contents);
    }
    const archive = join(root, "package.tgz");
    execFileSync("tar", [
      "--format", "ustar", "-czf", archive, "-C", join(root, "stage"),
      "package/package.json", "package/README.md", "package/contract.lock", "package/release-compatibility.json",
    ]);
    const expectedEntries = await expectedPackEntries(root, manifest);
    await assert.rejects(
      inspectPackageArchive(archive, { expectedEntries, expectedManifest: manifest, rootPath: root }),
      /credential-like content/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("private snapshots survive deterministic replacement of both producer archive paths", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-snapshot-swap-"));
  try {
    const manifest = releaseManifest();
    await writeFile(join(root, "package.json"), `${JSON.stringify(manifest)}\n`);
    await writeFile(join(root, "README.md"), "reviewed release bytes\n");
    await writeFile(join(root, "contract.lock"), "contract\n");
    await writeFile(join(root, "release-compatibility.json"), "{}\n");
    const stage = join(root, "stage", "package");
    await mkdir(stage, { recursive: true });
    await writeFile(join(stage, "package.json"), `${JSON.stringify(packagedManifest(manifest))}\n`);
    for (const name of ["README.md", "contract.lock", "release-compatibility.json"]) {
      await copyFile(join(root, name), join(stage, name));
    }
    const firstArchive = join(root, "package-a.tgz");
    const secondArchive = join(root, "package-b.tgz");
    execFileSync("tar", [
      "--format", "ustar", "-czf", firstArchive, "-C", join(root, "stage"),
      "package/package.json", "package/README.md", "package/contract.lock",
      "package/release-compatibility.json",
    ]);
    await copyFile(firstArchive, secondArchive);
    const reviewedBytes = await readFile(firstArchive);
    const firstSnapshot = await readPackageArchiveSnapshot(firstArchive);
    const secondSnapshot = await readPackageArchiveSnapshot(secondArchive);

    const firstReplacement = Buffer.from("unreviewed first archive\n", "utf8");
    const secondReplacement = Buffer.from("unreviewed second archive\n", "utf8");
    await rm(firstArchive);
    await rm(secondArchive);
    await writeFile(firstArchive, firstReplacement);
    await writeFile(secondArchive, secondReplacement);

    const finalArchive = join(root, "final.tgz");
    const expectedEntries = await expectedPackEntries(root, manifest);
    const finalized = await finalizePackageArchiveSnapshots({
      archivePath: finalArchive,
      expectedEntries,
      expectedManifest: manifest,
      firstSnapshot,
      rootPath: root,
      secondSnapshot,
    });
    const finalBytes = await readFile(finalArchive);
    const reviewedSHA256 = createHash("sha256").update(reviewedBytes).digest("hex");
    assert.deepEqual(finalBytes, reviewedBytes);
    assert.deepEqual(finalized.archiveBytes, reviewedBytes);
    assert.equal(finalized.sha256, reviewedSHA256);
    assert.equal(finalized.integrity, `sha512-${createHash("sha512").update(reviewedBytes).digest("base64")}`);
    assert.notDeepEqual(finalBytes, await readFile(firstArchive));
    assert.notDeepEqual(finalBytes, await readFile(secondArchive));
    assert.deepEqual(finalized.inspection.entries, expectedEntries);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive inspection rejects an oversized declared file before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-header-limit-"));
  try {
    const entry = "package/README.md";
    const archive = join(root, "oversized-header.tgz");
    const header = tarHeader(entry, (10 * 1024 * 1024) + 1);
    await writeFile(archive, gzipSync(Buffer.concat([header, Buffer.alloc(1024)]), { level: 9 }));
    await assert.rejects(
      inspectPackageArchive(archive, {
        expectedEntries: [entry],
        expectedManifest: releaseManifest(),
        rootPath: root,
      }),
      /entry exceeds 10 MiB before extraction/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive inspection rejects an oversized declared total before extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-header-total-"));
  try {
    const archive = join(root, "oversized-total.tgz");
    const size = 9 * 1024 * 1024;
    const entries = Array.from({ length: 6 }, (_, index) => `package/${index}.bin`);
    const chunks = [];
    for (const entry of entries.slice(0, 5)) chunks.push(tarHeader(entry, size), Buffer.alloc(size));
    chunks.push(tarHeader(entries[5], size));
    await writeFile(archive, gzipSync(Buffer.concat(chunks), { level: 9 }));
    await assert.rejects(
      inspectPackageArchive(archive, {
        expectedEntries: entries,
        expectedManifest: releaseManifest(),
        rootPath: root,
      }),
      /declares more than 50 MiB before extraction/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("archive inspection bounds gzip expansion before invoking tar extraction", async () => {
  const root = await mkdtemp(join(tmpdir(), "latchway-rn-pack-compressed-bomb-"));
  try {
    const archive = join(root, "compressed-bomb.tgz");
    await writeFile(archive, gzipSync(Buffer.alloc(54 * 1024 * 1024), { level: 9 }));
    await assert.rejects(
      inspectPackageArchive(archive, {
        expectedEntries: ["package/package.json"],
        expectedManifest: releaseManifest(),
        rootPath: root,
      }),
      /expanded npm tar stream exceeds the bounded pre-extraction limit/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function sparseFile(path, size) {
  const file = await open(path, "w", 0o600);
  try {
    await file.truncate(size);
  } finally {
    await file.close();
  }
}

function tarHeader(name, size) {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeTarOctal(header, 100, 8, 0o644);
  writeTarOctal(header, 108, 8, 0);
  writeTarOctal(header, 116, 8, 0);
  writeTarOctal(header, 124, 12, size);
  writeTarOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = [...header].reduce((total, byte) => total + byte, 0).toString(8).padStart(6, "0");
  header.write(checksum, 148, 6, "ascii");
  header[154] = 0;
  header[155] = 0x20;
  return header;
}

function writeTarOctal(buffer, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  if (encoded.length !== length - 1) throw new Error("Test tar value exceeds its field.");
  buffer.write(encoded, offset, length - 1, "ascii");
  buffer[offset + length - 1] = 0x20;
}

function releaseManifest() {
  return {
    name: "@latchway/react-native",
    version: "1.0.0",
    description: "test",
    license: "Apache-2.0",
    type: "module",
    main: "./lib/index.js",
    module: "./lib/index.js",
    types: "./lib/index.d.ts",
    "react-native": "./src/index.ts",
    sideEffects: false,
    files: ["README.md", "contract.lock", "release-compatibility.json"],
    scripts: {
      check: "node check.mjs",
      prepack: "pnpm build",
    },
    publishConfig: {
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
    },
  };
}

function packagedManifest(source) {
  const result = structuredClone(source);
  delete result.scripts.prepack;
  return result;
}
