import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { assertEqual, readJSON } from "./release-metadata.mjs";

const archiveArgument = process.argv.slice(2).find((argument) => argument !== "--" && !argument.startsWith("--"));
if (archiveArgument === undefined) {
  throw new Error("usage: node scripts/publish-or-verify.mjs /path/to/package.tgz [--dry-run]");
}
const archive = resolve(archiveArgument);
const dryRun = process.argv.includes("--dry-run");
const compatibility = await readJSON("release-compatibility.json");
const manifest = JSON.parse(execFileSync("tar", ["-xOzf", archive, "package/package.json"], { encoding: "utf8" }));
assertEqual(manifest.name, compatibility.react_native.package, "release archive package name");
assertEqual(manifest.version, compatibility.react_native.version, "release archive package version");

const npmVersion = execFileSync("npm", ["--version"], { encoding: "utf8" }).trim();
if (compareVersions(npmVersion, "11.5.1") < 0) {
  throw new Error(`npm ${npmVersion} cannot use trusted publishing; npm 11.5.1 or newer is required.`);
}

const archiveBytes = await readFile(archive);
const localIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
const specification = `${manifest.name}@${manifest.version}`;
const publishedIntegrity = lookupPublishedIntegrity(specification);
if (publishedIntegrity !== undefined) {
  assertEqual(publishedIntegrity, localIntegrity, "published npm archive integrity");
  process.stdout.write(`${specification} is already published with the verified archive; nothing to do.\n`);
} else if (dryRun) {
  process.stdout.write(`Would publish ${specification} with integrity ${localIntegrity}.\n`);
} else {
  const distributionTag = manifest.version.includes("-") ? "next" : "latest";
  execFileSync("npm", ["publish", archive, "--access", "public", "--provenance", "--tag", distributionTag], {
    stdio: "inherit",
  });
}

function lookupPublishedIntegrity(specification) {
  try {
    const output = execFileSync("npm", ["view", specification, "dist.integrity", "--json"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output.length === 0) throw new Error(`npm returned no integrity for existing package ${specification}.`);
    const integrity = JSON.parse(output);
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-")) {
      throw new Error(`npm returned an invalid integrity for ${specification}.`);
    }
    return integrity;
  } catch (error) {
    const stderr = error instanceof Error && "stderr" in error ? String(error.stderr) : "";
    if (/E404|404 Not Found/u.test(stderr)) return undefined;
    throw error;
  }
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}
