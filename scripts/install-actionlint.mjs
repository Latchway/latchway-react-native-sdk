#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFile, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const VERSION = "1.7.12";
const ARCHIVE = `actionlint_${VERSION}_linux_amd64.tar.gz`;
const EXPECTED_SHA256 = "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8";
const MAXIMUM_ARCHIVE_BYTES = 8 * 1024 * 1024;
const MAXIMUM_COMMAND_MILLISECONDS = 20 * 1000;

if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("The CI actionlint installer supports only the pinned ubuntu-24.04 x64 runner.");
}
const runnerTemp = requiredAbsolutePath("RUNNER_TEMP");
const githubPath = requiredAbsolutePath("GITHUB_PATH");
const installDirectory = join(runnerTemp, `latchway-actionlint-${VERSION}`);
const archivePath = join(installDirectory, ARCHIVE);
const executable = join(installDirectory, "actionlint");
await rm(installDirectory, { recursive: true, force: true });
await mkdir(installDirectory, { recursive: true, mode: 0o700 });

const response = await fetch(
  `https://github.com/rhysd/actionlint/releases/download/v${VERSION}/${ARCHIVE}`,
  { redirect: "follow", signal: AbortSignal.timeout(120_000) },
);
if (!response.ok || response.body === null || !response.url.startsWith("https://")) {
  throw new Error(`Could not download pinned actionlint archive: HTTP ${response.status}.`);
}
const archive = await readBounded(response.body, MAXIMUM_ARCHIVE_BYTES);
const actualSHA256 = createHash("sha256").update(archive).digest("hex");
if (actualSHA256 !== EXPECTED_SHA256) {
  throw new Error(`Pinned actionlint archive digest mismatch: ${actualSHA256}.`);
}
await writeFile(archivePath, archive, { mode: 0o600 });
execFileSync("tar", ["-xzf", archivePath, "-C", installDirectory, "actionlint"], {
  maxBuffer: 2 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: MAXIMUM_COMMAND_MILLISECONDS,
});
await chmod(executable, 0o700);
await rm(archivePath, { force: true });
const installedVersion = execFileSync(executable, ["-version"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
  timeout: MAXIMUM_COMMAND_MILLISECONDS,
}).split(/\r?\n/u, 1)[0];
if (installedVersion !== VERSION) {
  throw new Error(`Installed actionlint version mismatch: ${installedVersion}.`);
}
await appendFile(githubPath, `${installDirectory}\n`, { encoding: "utf8" });
process.stdout.write(`Installed actionlint ${VERSION} with verified SHA-256.\n`);

function requiredAbsolutePath(name) {
  const value = process.env[name];
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${name} must be an absolute runner-provided path.`);
  }
  return value;
}

async function readBounded(stream, maximumBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximumBytes) {
      await reader.cancel();
      throw new Error("Pinned actionlint archive exceeded its maximum allowed size.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}
