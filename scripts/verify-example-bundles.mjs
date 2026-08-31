import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const exampleRoot = join(repositoryRoot, "example");
const reactNativeCLI = join(repositoryRoot, "node_modules", "react-native", "cli.js");
const outputRoot = await mkdtemp(join(tmpdir(), "latchway-rn-framework-bundles-"));

try {
  for (const platform of ["ios", "android"]) {
    await execute(platform, process.execPath, [
      reactNativeCLI,
      "bundle",
      "--platform", platform,
      "--dev", "false",
      "--entry-file", "index.js",
      "--bundle-output", join(outputRoot, `${platform}.jsbundle`),
    ]);
  }
} finally {
  await rm(outputRoot, { force: true, recursive: true });
}

function execute(platform, command, args) {
  return new Promise((resolveProcess, reject) => {
    const environment = { ...process.env, FORCE_COLOR: "0" };
    delete environment.NO_COLOR;
    const child = spawn(command, args, {
      cwd: exampleRoot,
      env: environment,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolveProcess();
        return;
      }
      reject(new Error(
        `React Native ${platform} bundle failed (${signal ?? `exit ${String(code)}`}).`,
      ));
    });
  });
}
