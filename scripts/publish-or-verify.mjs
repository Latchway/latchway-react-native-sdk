import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, readFile } from "node:fs/promises";
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
const published = lookupPublished(specification);
let publishPerformed = false;
if (published !== undefined) {
  assertEqual(published.integrity, localIntegrity, "published npm archive integrity");
  const tarballURL = new URL(published.tarball);
  if (tarballURL.origin !== "https://registry.npmjs.org" || tarballURL.username !== ""
      || tarballURL.password !== "" || tarballURL.search !== "" || tarballURL.hash !== "") {
    throw new Error("npm returned a non-canonical tarball URL for the existing version.");
  }
  const publishedBytes = await fetchBoundedTarball(tarballURL, 20 * 1024 * 1024);
  if (!publishedBytes.equals(archiveBytes)) {
    throw new Error("The existing npm version is not byte-identical to the reviewed archive.");
  }
  process.stdout.write(`${specification} is already published with the verified archive; nothing to do.\n`);
} else if (dryRun) {
  process.stdout.write(`Would publish ${specification} with integrity ${localIntegrity}.\n`);
} else {
  if (process.env.RELEASE_STATE === "immutable") {
    throw new Error("An immutable GitHub release cannot be paired with a missing npm version.");
  }
  const distributionTag = manifest.version.includes("-") ? "next" : "latest";
  execFileSync("npm", ["publish", archive, "--access", "public", "--provenance", "--tag", distributionTag,
    "--registry=https://registry.npmjs.org/"], {
    stdio: "inherit",
  });
  publishPerformed = true;
}
if (typeof process.env.GITHUB_OUTPUT === "string") {
  await appendFile(process.env.GITHUB_OUTPUT, `publish_performed=${String(publishPerformed)}\n`, { mode: 0o600 });
}

function lookupPublished(specification) {
  try {
    const output = execFileSync("npm", ["view", specification, "dist.integrity", "dist.tarball", "--json",
      "--registry=https://registry.npmjs.org/"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (output.length === 0) throw new Error(`npm returned no metadata for existing package ${specification}.`);
    const value = JSON.parse(output);
    const integrity = value["dist.integrity"] ?? value.dist?.integrity;
    const tarball = value["dist.tarball"] ?? value.dist?.tarball;
    if (typeof integrity !== "string" || !integrity.startsWith("sha512-") || typeof tarball !== "string") {
      throw new Error(`npm returned invalid distribution metadata for ${specification}.`);
    }
    return { integrity, tarball };
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

async function fetchBoundedTarball(url, maximumBytes) {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(20_000) });
  if (response.status !== 200 || response.body === null) {
    throw new Error(`npm registry tarball retrieval failed with HTTP ${response.status}.`);
  }
  const advertised = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertised) && advertised > maximumBytes) {
    throw new Error("The existing npm registry tarball exceeds the release size bound.");
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maximumBytes) throw new Error("The existing npm registry tarball exceeds the release size bound.");
    chunks.push(Buffer.from(chunk));
  }
  if (size === 0) throw new Error("The existing npm registry tarball is empty.");
  return Buffer.concat(chunks, size);
}
