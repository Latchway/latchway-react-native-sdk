import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";
import { TextDecoder } from "node:util";

export const RELEASE_PREDICATE_TYPE = "https://in-toto.io/attestation/release/v0.2";
export const STATEMENT_TYPE = "https://in-toto.io/Statement/v1";
export const MAXIMUM_ATTESTATION_JSON_BYTES = 16 * 1024 * 1024;

const repositoryPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const tagPattern = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const commitPattern = /^[0-9a-f]{40}$/u;
const digestPattern = /^[0-9a-f]{64}$/u;

export function validateReleaseAttestation(bytes, {
  repository,
  tag,
  expectedCommit,
  assets,
  label = "GitHub release attestation",
}) {
  if (!repositoryPattern.test(repository) || !tagPattern.test(tag) || !commitPattern.test(expectedCommit)) {
    throw new Error(`${label} received a noncanonical expected coordinate.`);
  }
  const expectedAssets = new Map();
  for (const asset of assets) {
    if (asset === null || typeof asset !== "object" || typeof asset.name !== "string"
        || asset.name.length === 0 || !digestPattern.test(asset.sha256) || expectedAssets.has(asset.name)) {
      throw new Error(`${label} received an invalid or duplicate expected asset.`);
    }
    expectedAssets.set(asset.name, asset.sha256);
  }
  if (expectedAssets.size === 0) throw new Error(`${label} requires at least one expected asset.`);

  const value = parseStrictJSONBytes(bytes, label, MAXIMUM_ATTESTATION_JSON_BYTES);
  if (!hasExactKeys(value, ["attestation", "verificationResult"])) {
    throw new Error(`${label} has an unexpected top-level schema.`);
  }
  if (!isNonemptyObject(value.attestation) || !isNonemptyObject(value.verificationResult)) {
    throw new Error(`${label} has no attestation or verification result.`);
  }
  const envelope = value.attestation.bundle?.dsseEnvelope;
  if (!isNonemptyObject(envelope)
      || envelope.payloadType !== "application/vnd.in-toto+json"
      || typeof envelope.payload !== "string" || envelope.payload.length === 0
      || !Array.isArray(envelope.signatures) || envelope.signatures.length === 0
      || envelope.signatures.some((signature) => !isNonemptyObject(signature))) {
    throw new Error(`${label} has an invalid signed DSSE envelope.`);
  }
  const statementBytes = decodeBase64Strict(envelope.payload, label);
  const statement = parseStrictJSONBytes(statementBytes, `${label} statement`, MAXIMUM_ATTESTATION_JSON_BYTES);
  if (!hasExactKeys(statement, ["_type", "subject", "predicateType", "predicate"])
      || statement._type !== STATEMENT_TYPE || statement.predicateType !== RELEASE_PREDICATE_TYPE
      || !isNonemptyObject(statement.predicate) || !Array.isArray(statement.subject)
      || statement.subject.length === 0) {
    throw new Error(`${label} statement has an unexpected schema.`);
  }

  const expectedPURL = `pkg:github/${repository}`.toLowerCase();
  const releaseDigests = [];
  const observedAssets = new Map();
  for (const subject of statement.subject) {
    if (!isNonemptyObject(subject) || !isNonemptyObject(subject.digest)
        || Object.entries(subject.digest).some(([algorithm, digest]) => (
          typeof algorithm !== "string" || typeof digest !== "string"
        ))) {
      throw new Error(`${label} contains an invalid subject.`);
    }
    if (hasExactKeys(subject, ["uri", "digest"])) {
      if (typeof subject.uri !== "string") throw new Error(`${label} contains an invalid release subject.`);
      const separator = subject.uri.lastIndexOf("@");
      if (separator < 1 || subject.uri.slice(0, separator).toLowerCase() !== expectedPURL
          || subject.uri.slice(separator + 1) !== tag || releaseDigests.length !== 0) {
        throw new Error(`${label} contains an invalid release subject.`);
      }
      releaseDigests.push(subject.digest);
    } else if (hasExactKeys(subject, ["name", "digest"])) {
      if (typeof subject.name !== "string" || subject.name.length === 0 || observedAssets.has(subject.name)) {
        throw new Error(`${label} contains an invalid or duplicate asset subject.`);
      }
      observedAssets.set(subject.name, subject.digest);
    } else {
      throw new Error(`${label} contains an unexpected subject schema.`);
    }
  }
  if (releaseDigests.length !== 1 || !isDeepEqual(releaseDigests[0], { sha1: expectedCommit })) {
    throw new Error(`${label} is not bound to the locked source commit.`);
  }
  if (!sameSet(observedAssets.keys(), expectedAssets.keys())) {
    throw new Error(`${label} does not contain the exact release asset set.`);
  }
  for (const [name, sha256] of expectedAssets) {
    if (!isDeepEqual(observedAssets.get(name), { sha256 })) {
      throw new Error(`${label} does not bind the exact bytes for ${name}.`);
    }
  }
  return {
    bytes: bytes.byteLength,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    source_commit: expectedCommit,
    asset_count: expectedAssets.size,
  };
}

export function parseStrictJSONBytes(bytes, label, maximumBytes) {
  if (!Buffer.isBuffer(bytes) || bytes.byteLength === 0 || bytes.byteLength > maximumBytes) {
    throw new Error(`${label} has an invalid JSON byte length.`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`${label} is not valid UTF-8.`);
  }
  scanJSON(text, label);
  return JSON.parse(text, (_key, value) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${label} contains a non-finite JSON number.`);
    }
    return value;
  });
}

export function readBoundedFileSync(path, label, maximumBytes) {
  if (typeof label !== "string" || label.length === 0
      || !Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw new Error("Bounded file reader received an invalid limit.");
  }
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size)
        || metadata.size < 1 || metadata.size > maximumBytes) {
      throw new Error(`${label} has an invalid file byte length.`);
    }
    const bytes = Buffer.alloc(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new Error(`${label} changed while it was read.`);
      offset += count;
    }
    if (readSync(descriptor, Buffer.alloc(1), 0, 1, offset) !== 0) {
      throw new Error(`${label} changed while it was read.`);
    }
    return bytes;
  } finally {
    closeSync(descriptor);
  }
}

export function readBoundedStrictJSONFileSync(path, label, maximumBytes) {
  return parseStrictJSONBytes(readBoundedFileSync(path, label, maximumBytes), label, maximumBytes);
}

function scanJSON(text, label) {
  let index = 0;
  const whitespace = new Set([" ", "\t", "\r", "\n"]);

  function fail() { throw new Error(`${label} is not strict JSON.`); }
  function skipWhitespace() { while (whitespace.has(text[index])) index += 1; }

  function parseString() {
    if (text[index] !== '"') fail();
    const start = index;
    index += 1;
    while (index < text.length) {
      const character = text[index];
      if (character === '"') {
        index += 1;
        return JSON.parse(text.slice(start, index));
      }
      if (character.charCodeAt(0) < 0x20) fail();
      if (character === "\\") {
        index += 1;
        const escape = text[index];
        if (escape === "u") {
          if (!/^[0-9a-fA-F]{4}$/u.test(text.slice(index + 1, index + 5))) fail();
          index += 5;
          continue;
        }
        if (!new Set(['"', "\\", "/", "b", "f", "n", "r", "t"]).has(escape)) fail();
      }
      index += 1;
    }
    fail();
  }

  function parseObject() {
    index += 1;
    skipWhitespace();
    const keys = new Set();
    if (text[index] === "}") { index += 1; return; }
    while (index < text.length) {
      const key = parseString();
      if (keys.has(key)) throw new Error(`${label} contains a duplicate JSON key.`);
      keys.add(key);
      skipWhitespace();
      if (text[index] !== ":") fail();
      index += 1;
      parseValue();
      skipWhitespace();
      if (text[index] === "}") { index += 1; return; }
      if (text[index] !== ",") fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseArray() {
    index += 1;
    skipWhitespace();
    if (text[index] === "]") { index += 1; return; }
    while (index < text.length) {
      parseValue();
      skipWhitespace();
      if (text[index] === "]") { index += 1; return; }
      if (text[index] !== ",") fail();
      index += 1;
      skipWhitespace();
    }
    fail();
  }

  function parseValue() {
    skipWhitespace();
    const character = text[index];
    if (character === "{") parseObject();
    else if (character === "[") parseArray();
    else if (character === '"') parseString();
    else if (text.startsWith("true", index)) index += 4;
    else if (text.startsWith("false", index)) index += 5;
    else if (text.startsWith("null", index)) index += 4;
    else {
      const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u.exec(text.slice(index));
      if (match === null) fail();
      index += match[0].length;
    }
  }

  parseValue();
  skipWhitespace();
  if (index !== text.length) fail();
}

export function decodeBase64Strict(encoded, label) {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error(`${label} has a malformed DSSE payload encoding.`);
  }
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.byteLength === 0 || bytes.toString("base64") !== encoded) {
    throw new Error(`${label} has a malformed DSSE payload encoding.`);
  }
  return bytes;
}

function hasExactKeys(value, keys) {
  return isNonemptyObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isNonemptyObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0;
}

function sameSet(left, right) {
  const leftValues = [...left].sort();
  const rightValues = [...right].sort();
  return JSON.stringify(leftValues) === JSON.stringify(rightValues);
}

function isDeepEqual(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
