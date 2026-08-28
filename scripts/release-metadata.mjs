import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

export const repositoryRoot = new URL("../", import.meta.url);

export async function readJSON(relativePath, root = repositoryRoot) {
  return JSON.parse(await readFile(new URL(relativePath, root), "utf8"));
}

export async function readLock(relativePath = "contract.lock", root = repositoryRoot) {
  const contents = await readFile(new URL(relativePath, root), "utf8");
  const values = new Map();
  for (const line of contents.split("\n")) {
    const match = /^([a-z0-9_]+):\s*(?:"([^"]*)"|([^#\s]+))\s*(?:#.*)?$/u.exec(line);
    if (match === null) continue;
    values.set(match[1], match[2] ?? match[3]);
  }
  return values;
}

export async function readText(relativePath, root = repositoryRoot) {
  return readFile(new URL(relativePath, root), "utf8");
}

export function requireLockValue(lock, field) {
  const value = lock.get(field);
  if (value === undefined || value.length === 0) throw new Error(`contract.lock is missing ${field}.`);
  return value;
}

export function requireMatch(contents, expression, description) {
  const match = expression.exec(contents);
  const value = match?.[1];
  if (value === undefined || value.length === 0) throw new Error(`Could not read ${description}.`);
  return value;
}

export function gitOutput(root, ...arguments_) {
  return execFileSync("git", ["-C", fileURLToPath(root), ...arguments_], { encoding: "utf8" }).trim();
}

export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export function assertEqual(actual, expected, description) {
  if (actual !== expected) {
    throw new Error(`${description} mismatch: expected ${String(expected)}, received ${String(actual)}.`);
  }
}
