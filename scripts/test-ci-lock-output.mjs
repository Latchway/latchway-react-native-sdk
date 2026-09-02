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

test("ordinary pull-request CI materializes the exact locked JavaScript sibling", async () => {
  const workflow = await readFile(new URL(".github/workflows/ci.yml", root), "utf8");
  const pinnedJob = workflow.indexOf("\n  pinned-core-conformance:\n");
  assert.notEqual(pinnedJob, -1);
  const jobs = [workflow.slice(0, pinnedJob), workflow.slice(pinnedJob)];
  for (const job of jobs) {
    for (const marker of [
      ".javascript.source_commit",
      "Resolve the exact locked JavaScript SDK revision",
      "Fetch only the public exact locked JavaScript SDK revision without credentials",
      "Build the exact locked JavaScript SDK source",
      "test -z \"${GH_TOKEN:-}\"",
      "GIT_TERMINAL_PROMPT=0 git -C ../latchway-js fetch --depth=1 --no-tags origin \"$JAVASCRIPT_COMMIT\"",
      "test \"$(git -C ../latchway-js rev-parse --verify HEAD)\" = \"$JAVASCRIPT_COMMIT\"",
      "pnpm --dir ../latchway-js install --frozen-lockfile --ignore-scripts",
      "pnpm --dir ../latchway-js build",
    ]) {
      assert.ok(job.includes(marker), marker);
    }
    assert.ok(
      job.indexOf("Build the exact locked JavaScript SDK source") <
        job.indexOf("Install the exact", job.indexOf("Build the exact locked JavaScript SDK source")),
      "the locked JavaScript build must precede the React Native package install",
    );
  }
});

test("scheduled framework compatibility materializes the exact locked JavaScript sibling", async () => {
  const workflow = await readFile(
    new URL(".github/workflows/framework-compatibility.yml", root),
    "utf8",
  );
  for (const marker of [
    ".javascript.source_commit",
    "Resolve the exact locked JavaScript SDK revision",
    "Fetch only the public exact locked JavaScript SDK revision without credentials",
    "Build the exact locked JavaScript SDK source",
    'test -z "${GH_TOKEN:-}"',
    'GIT_TERMINAL_PROMPT=0 git -C ../latchway-js fetch --depth=1 --no-tags origin "$JAVASCRIPT_COMMIT"',
    'test "$(git -C ../latchway-js rev-parse --verify HEAD)" = "$JAVASCRIPT_COMMIT"',
    "pnpm --dir ../latchway-js install --frozen-lockfile --ignore-scripts",
    "pnpm --dir ../latchway-js build",
    "pnpm add --workspace-root --save-dev",
  ]) {
    assert.ok(workflow.includes(marker), marker);
  }
  assert.ok(
    workflow.indexOf("Build the exact locked JavaScript SDK source") <
      workflow.indexOf("Install the exact registry profile"),
    "the locked JavaScript build must precede every React Native profile install",
  );
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
