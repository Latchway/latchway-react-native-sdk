import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("CI lock exposes exact published Android toolchain package versions", () => {
  const output = execFileSync(process.execPath, ["scripts/ci-lock-output.mjs"], {
    cwd: root,
    encoding: "utf8",
  });
  const values = new Map(output.trim().split("\n").map((line) => line.split("=", 2)));
  assert.equal(values.get("android_compile_sdk"), "37");
  assert.equal(values.get("android_sdk_platform_version"), "37.0");
  assert.equal(values.get("android_build_tools_version"), "36.0.0");
  assert.equal(values.get("android_ndk_version"), "27.1.12297006");
});

test("Android workflows install packages from the immutable compatibility lock", async () => {
  for (const path of [
    ".github/workflows/locked-sources.yml",
    ".github/workflows/native-consumer.yml",
    ".github/workflows/release.yml",
  ]) {
    const workflow = await readFile(new URL(path, root), "utf8");
    assert.match(workflow, /android_sdk_platform_version/u, path);
    assert.match(workflow, /android_build_tools_version/u, path);
    assert.match(workflow, /android_ndk_version/u, path);
    assert.doesNotMatch(workflow, /platforms;android-\$\{\{ steps\.lock\.outputs\.android_compile_sdk \}\}/u, path);
  }
});

test("standalone source verification freezes every contract-bundle source", async () => {
  const verifier = await readFile(new URL("scripts/verify-compatibility.mjs", root), "utf8");
  for (const path of [
    "api",
    "compatibility/frameworks.yaml",
    "compatibility/frameworks.schema.json",
  ]) {
    assert.ok(verifier.includes(`    "${path}",`), path);
  }
  assert.match(verifier, /"--",\s*\.\.\.frozenContractPaths,/u);
});
