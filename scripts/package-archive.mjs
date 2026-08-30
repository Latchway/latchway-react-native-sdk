import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdtemp,
  open,
  readdir,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { isDeepStrictEqual } from "node:util";
import { createGunzip } from "node:zlib";

const MAXIMUM_ARCHIVE_BYTES = 20 * 1024 * 1024;
const MAXIMUM_ENTRY_COUNT = 2_048;
const MAXIMUM_FILE_BYTES = 10 * 1024 * 1024;
const MAXIMUM_UNPACKED_BYTES = 50 * 1024 * 1024;
const TAR_BLOCK_BYTES = 512;
const MAXIMUM_EXPANDED_TAR_BYTES = MAXIMUM_UNPACKED_BYTES +
  (((MAXIMUM_ENTRY_COUNT * 2) + 2) * TAR_BLOCK_BYTES);
const TAR_MAGIC = Buffer.from("ustar\0", "ascii");
const TAR_VERSION = Buffer.from("00", "ascii");
const TAR_TEXT_DECODER = new TextDecoder("utf-8", { fatal: true });
const CONTROLLED_SOURCE_PREPACK = "pnpm build";
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.|$)|\.npmrc$|\.yarnrc(?:\.yml)?$|credentials?(?:\.|$)|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|secrets?(?:\.|$))|\.(?:key|p12|pfx|pem)$/iu;
const SECRET_CONTENT = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9_-]{32,})\b/u,
  /\bsk-[A-Za-z0-9]{20,}\b/u,
  /\/\/registry\.npmjs\.org\/:_authToken\s*=\s*(?!\$\{)[^\s$][^\s]*/u,
];
const UNSAFE_LIFECYCLE_SCRIPTS = new Set([
  "dependencies",
  "install",
  "postdependencies",
  "postinstall",
  "postpack",
  "postprepare",
  "postpublish",
  "predependencies",
  "preinstall",
  "prepack",
  "preprepare",
  "prepare",
  "prepublish",
  "prepublishOnly",
  "publish",
]);

// Open the producer path exactly once and retain an owned, bounded byte
// snapshot. Every later parser, extractor, digest, and final artifact write
// must consume this Buffer instead of reopening the producer-controlled path.
export async function readPackageArchiveSnapshot(archivePath) {
  if (typeof constants.O_NOFOLLOW !== "number" || constants.O_NOFOLLOW === 0) {
    throw new Error("This release host cannot open npm archives without following symbolic links.");
  }
  let handle;
  try {
    handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    throw new Error("The npm archive must be an accessible non-symbolic regular file.", { cause: error });
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !Number.isSafeInteger(metadata.size) || metadata.size === 0 ||
        metadata.size > MAXIMUM_ARCHIVE_BYTES) {
      throw new Error("The npm archive must be a non-empty regular file no larger than 20 MiB.");
    }
    const snapshot = Buffer.allocUnsafe(metadata.size);
    let offset = 0;
    while (offset < snapshot.byteLength) {
      const { bytesRead } = await handle.read(
        snapshot,
        offset,
        snapshot.byteLength - offset,
        offset,
      );
      if (bytesRead === 0) {
        throw new Error("The npm archive changed or was truncated while its private snapshot was captured.");
      }
      offset += bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    const { bytesRead: extraBytes } = await handle.read(extra, 0, 1, snapshot.byteLength);
    if (extraBytes !== 0) {
      throw new Error("The npm archive changed or exceeded 20 MiB while its private snapshot was captured.");
    }
    return snapshot;
  } finally {
    await handle.close();
  }
}

export async function expectedPackEntries(rootPath, manifest) {
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    throw new Error("package.json must define a non-empty publication file allowlist.");
  }
  const root = resolve(rootPath);
  const entries = new Set();
  let sourceBytes = 0;
  const includeFile = (relativePath, size) => {
    if (!Number.isSafeInteger(size) || size < 0 || size > MAXIMUM_FILE_BYTES) {
      throw new Error(`Release input exceeds 10 MiB: ${relativePath}.`);
    }
    const archiveEntry = `package/${relativePath}`;
    if (entries.has(archiveEntry)) return;
    entries.add(archiveEntry);
    sourceBytes += size;
    if (sourceBytes > MAXIMUM_UNPACKED_BYTES) {
      throw new Error("The publication allowlist exceeds 50 MiB.");
    }
  };
  const packageManifestPath = resolve(root, "package.json");
  assertWithinRoot(root, packageManifestPath);
  const packageManifestMetadata = await lstat(packageManifestPath);
  if (packageManifestMetadata.isSymbolicLink() || !packageManifestMetadata.isFile()) {
    throw new Error("Release input package.json must be a regular file.");
  }
  includeFile("package.json", packageManifestMetadata.size);
  for (const value of manifest.files) {
    const relativePath = publicationPath(value);
    const absolutePath = resolve(root, ...relativePath.split("/"));
    assertWithinRoot(root, absolutePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Release input may not be a symbolic link: ${relativePath}.`);
    }
    if (metadata.isFile()) {
      includeFile(relativePath, metadata.size);
      continue;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Release input must be a regular file or directory: ${relativePath}.`);
    }
    const nested = await regularFiles(root, relativePath);
    if (nested.length === 0) throw new Error(`Release directory is empty: ${relativePath}.`);
    for (const file of nested) includeFile(file.path, file.size);
  }
  if (entries.size > MAXIMUM_ENTRY_COUNT) throw new Error("The publication allowlist contains too many files.");
  return [...entries].sort();
}

export async function inspectPackageArchive(
  archive,
  { expectedEntries, expectedManifest, rootPath },
) {
  const archiveSnapshot = Buffer.isBuffer(archive)
    ? archive
    : await readPackageArchiveSnapshot(archive);
  if (archiveSnapshot.byteLength === 0 || archiveSnapshot.byteLength > MAXIMUM_ARCHIVE_BYTES) {
    throw new Error("The npm archive must be a non-empty regular file no larger than 20 MiB.");
  }

  const headerInspection = await inspectTarHeaders(archiveSnapshot, expectedEntries);
  const entries = headerInspection.entries;

  const extraction = await mkdtemp(join(tmpdir(), "latchway-react-native-package-"));
  try {
    execFileSync("tar", ["-xzf", "-", "-C", extraction], {
      input: archiveSnapshot,
      maxBuffer: 2 * 1024 * 1024,
      stdio: ["pipe", "pipe", "pipe"],
    });
    await assertExtractedTreeIsRegular(join(extraction, "package"));
    const packagedManifest = JSON.parse(await readFile(join(extraction, "package", "package.json"), "utf8"));
    assertPackagedManifest(packagedManifest, expectedManifest);

    for (const protectedFile of ["contract.lock", "release-compatibility.json"]) {
      const [source, packaged] = await Promise.all([
        readFile(join(rootPath, protectedFile)),
        readFile(join(extraction, "package", protectedFile)),
      ]);
      if (!source.equals(packaged)) {
        throw new Error(`The archive ${protectedFile} differs from the reviewed source file.`);
      }
    }

    let unpackedBytes = 0;
    const files = new Map();
    for (const entry of entries) {
      if (SECRET_FILE.test(entry)) throw new Error(`The package archive contains a credential-like file: ${entry}.`);
      const bytes = await readFile(join(extraction, ...entry.split("/")));
      if (bytes.byteLength !== headerInspection.sizes.get(entry)) {
        throw new Error(`The extracted archive entry size differs from its validated header: ${entry}.`);
      }
      unpackedBytes += bytes.byteLength;
      if (unpackedBytes > MAXIMUM_UNPACKED_BYTES) {
        throw new Error("The unpacked npm archive exceeds 50 MiB.");
      }
      const contents = bytes.toString("utf8");
      if (SECRET_CONTENT.some((pattern) => pattern.test(contents))) {
        throw new Error(`The package archive contains credential-like content in ${entry}.`);
      }
      files.set(entry, bytes);
    }
    if (unpackedBytes !== headerInspection.unpackedBytes) {
      throw new Error("The extracted archive size differs from its validated headers.");
    }
    return { entries: [...entries].sort(), files, manifest: packagedManifest, unpackedBytes };
  } finally {
    await rm(extraction, { recursive: true, force: true });
  }
}

export function assertSafeArchiveEntry(entry) {
  if (typeof entry !== "string" || entry.length > 512 || !entry.startsWith("package/") ||
      entry.endsWith("/") || entry.includes("\\") || hasControlCharacter(entry)) {
    throw new Error(`Unsafe npm archive entry: ${entry}.`);
  }
  const segments = entry.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe npm archive path: ${entry}.`);
  }
}

export function assertExactArchiveEntries(actual, expected) {
  const normalizedActual = [...actual].sort();
  const normalizedExpected = [...expected].sort();
  if (!isDeepStrictEqual(normalizedActual, normalizedExpected)) {
    throw new Error("The npm archive does not exactly match the reviewed publication allowlist.");
  }
}

export function assertPackagedManifest(actual, expected) {
  for (const field of [
    "name",
    "version",
    "description",
    "license",
    "type",
    "main",
    "module",
    "types",
    "react-native",
    "sideEffects",
    "engines",
    "files",
    "exports",
    "dependencies",
    "peerDependencies",
    "devDependencies",
    "codegenConfig",
    "repository",
    "bugs",
    "homepage",
    "publishConfig",
    "keywords",
  ]) {
    if (!isDeepStrictEqual(actual[field], expected[field])) {
      throw new Error(`The packaged manifest has an unexpected ${field}.`);
    }
  }
  if (actual.private === true || actual.publishConfig?.access !== "public" ||
      actual.publishConfig?.registry !== "https://registry.npmjs.org/" || actual.publishConfig?.provenance !== true) {
    throw new Error("The packaged manifest is not configured for public provenance-enabled npm publication.");
  }
  if (expected.scripts === null || typeof expected.scripts !== "object" || Array.isArray(expected.scripts) ||
      expected.scripts.prepack !== CONTROLLED_SOURCE_PREPACK) {
    throw new Error(`The reviewed source manifest must define the controlled ${CONTROLLED_SOURCE_PREPACK} prepack build.`);
  }
  if (actual.scripts === null || typeof actual.scripts !== "object" || Array.isArray(actual.scripts)) {
    throw new Error("The packaged manifest must retain the exact approved non-lifecycle scripts.");
  }
  for (const name of UNSAFE_LIFECYCLE_SCRIPTS) {
    if (Object.hasOwn(actual.scripts, name)) {
      throw new Error(`The package archive may not contain the ${name} lifecycle script.`);
    }
  }
  const approvedPackagedScripts = { ...expected.scripts };
  delete approvedPackagedScripts.prepack;
  if (!isDeepStrictEqual(actual.scripts, approvedPackagedScripts)) {
    throw new Error("The packaged manifest scripts differ from the exact reviewed publication map.");
  }
  for (const field of ["bundledDependencies", "bundleDependencies", "bin"]) {
    if (Object.hasOwn(actual, field)) throw new Error(`The packaged manifest may not define ${field}.`);
  }
}

function publicationPath(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value.startsWith("/") ||
      value.includes("\\") || hasControlCharacter(value) || /[*?[\]{}]/u.test(value)) {
    throw new Error(`Unsafe package publication path: ${String(value)}.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new Error(`Unsafe package publication path: ${value}.`);
  }
  return segments.join("/");
}

async function regularFiles(root, relativeDirectory) {
  const result = [];
  const directory = resolve(root, ...relativeDirectory.split("/"));
  assertWithinRoot(root, directory);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    const absolutePath = resolve(root, ...relativePath.split("/"));
    assertWithinRoot(root, absolutePath);
    const metadata = await lstat(absolutePath);
    if (metadata.isSymbolicLink()) throw new Error(`Release input may not be a symbolic link: ${relativePath}.`);
    if (metadata.isDirectory()) result.push(...await regularFiles(root, relativePath));
    else if (metadata.isFile()) result.push({ path: relativePath, size: metadata.size });
    else throw new Error(`Release input must be a regular file: ${relativePath}.`);
    if (result.length > MAXIMUM_ENTRY_COUNT) throw new Error("The publication allowlist contains too many files.");
  }
  return result.sort((left, right) => left.path.localeCompare(right.path));
}

async function inspectTarHeaders(archiveSnapshot, expectedEntries) {
  if (!Array.isArray(expectedEntries) || expectedEntries.length === 0 ||
      expectedEntries.length > MAXIMUM_ENTRY_COUNT || new Set(expectedEntries).size !== expectedEntries.length) {
    throw new Error("The reviewed publication allowlist is invalid or duplicated.");
  }

  const entries = [];
  const sizes = new Map();
  const header = Buffer.alloc(TAR_BLOCK_BYTES);
  let headerOffset = 0;
  let bodyRemaining = 0;
  let paddingRemaining = 0;
  let zeroBlocks = 0;
  let complete = false;
  let expandedBytes = 0;
  let unpackedBytes = 0;
  let validationError;

  const consume = (chunk) => {
    expandedBytes += chunk.byteLength;
    if (expandedBytes > MAXIMUM_EXPANDED_TAR_BYTES) {
      throw new TarHeaderError("The expanded npm tar stream exceeds the bounded pre-extraction limit.");
    }
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (complete) {
        assertZeroBytes(chunk, offset, chunk.byteLength, "The npm tar stream has data after its end markers.");
        return;
      }
      if (bodyRemaining > 0) {
        const consumed = Math.min(bodyRemaining, chunk.byteLength - offset);
        bodyRemaining -= consumed;
        offset += consumed;
        continue;
      }
      if (paddingRemaining > 0) {
        const consumed = Math.min(paddingRemaining, chunk.byteLength - offset);
        assertZeroBytes(chunk, offset, offset + consumed, "The npm tar entry has non-zero padding.");
        paddingRemaining -= consumed;
        offset += consumed;
        continue;
      }

      const consumed = Math.min(TAR_BLOCK_BYTES - headerOffset, chunk.byteLength - offset);
      chunk.copy(header, headerOffset, offset, offset + consumed);
      headerOffset += consumed;
      offset += consumed;
      if (headerOffset !== TAR_BLOCK_BYTES) continue;
      headerOffset = 0;

      if (isZeroBlock(header)) {
        zeroBlocks += 1;
        if (zeroBlocks === 2) complete = true;
        continue;
      }
      if (zeroBlocks !== 0) {
        throw new TarHeaderError("The npm tar stream has an invalid end marker sequence.");
      }

      const parsed = parseTarHeader(header);
      try {
        assertSafeArchiveEntry(parsed.name);
      } catch (error) {
        throw new TarHeaderError(error instanceof Error ? error.message : "Unsafe npm archive entry.");
      }
      if (sizes.has(parsed.name)) throw new TarHeaderError("The npm archive has duplicate entries.");
      if (entries.length === MAXIMUM_ENTRY_COUNT) {
        throw new TarHeaderError("The npm archive contains too many entries.");
      }
      if (parsed.size > MAXIMUM_FILE_BYTES) {
        throw new TarHeaderError(`The npm archive entry exceeds 10 MiB before extraction: ${parsed.name}.`);
      }
      entries.push(parsed.name);
      sizes.set(parsed.name, parsed.size);
      unpackedBytes += parsed.size;
      if (unpackedBytes > MAXIMUM_UNPACKED_BYTES) {
        throw new TarHeaderError("The npm archive declares more than 50 MiB before extraction.");
      }
      bodyRemaining = parsed.size;
      paddingRemaining = (TAR_BLOCK_BYTES - (parsed.size % TAR_BLOCK_BYTES)) % TAR_BLOCK_BYTES;
    }
  };

  try {
    await pipeline(
      Readable.from([archiveSnapshot]),
      createGunzip(),
      async (source) => {
        for await (const chunk of source) {
          try {
            consume(chunk);
          } catch (error) {
            if (error instanceof TarHeaderError) validationError = error;
            throw error;
          }
        }
      },
    );
  } catch (error) {
    if (validationError !== undefined) throw validationError;
    if (error instanceof TarHeaderError) throw error;
    throw new Error("The npm archive is not a valid bounded gzip tar stream.", { cause: error });
  }
  if (!complete || headerOffset !== 0 || bodyRemaining !== 0 || paddingRemaining !== 0 ||
      expandedBytes % TAR_BLOCK_BYTES !== 0) {
    throw new Error("The npm tar stream is truncated or missing its end markers.");
  }
  if (entries.length === 0) throw new Error("The npm archive contains no files.");
  assertExactArchiveEntries(entries, expectedEntries);
  return { entries, sizes, unpackedBytes };
}

function parseTarHeader(header) {
  if (!header.subarray(257, 263).equals(TAR_MAGIC) || !header.subarray(263, 265).equals(TAR_VERSION)) {
    throw new TarHeaderError("The npm archive must use canonical POSIX ustar headers.");
  }
  const expectedChecksum = parseTarOctal(header.subarray(148, 156), "checksum");
  let observedChecksum = 0;
  for (let index = 0; index < header.byteLength; index += 1) {
    observedChecksum += index >= 148 && index < 156 ? 0x20 : header[index];
  }
  if (expectedChecksum !== observedChecksum) throw new TarHeaderError("The npm tar header checksum is invalid.");
  const type = header[156];
  if (type !== 0 && type !== 0x30) {
    throw new TarHeaderError("The npm archive may contain only regular files before extraction.");
  }
  const name = tarText(header.subarray(0, 100), "name");
  const prefix = tarText(header.subarray(345, 500), "prefix", true);
  return {
    name: prefix.length === 0 ? name : `${prefix}/${name}`,
    size: parseTarOctal(header.subarray(124, 136), "size"),
  };
}

function parseTarOctal(field, label) {
  if ((field[0] & 0x80) !== 0) {
    throw new TarHeaderError(`The npm tar ${label} must use bounded octal encoding.`);
  }
  const terminator = field.indexOf(0);
  const content = terminator === -1 ? field : field.subarray(0, terminator);
  if (terminator !== -1 && [...field.subarray(terminator + 1)].some((byte) => byte !== 0 && byte !== 0x20)) {
    throw new TarHeaderError(`The npm tar ${label} has invalid trailing bytes.`);
  }
  const text = content.toString("ascii").trim();
  if (text.length === 0) return 0;
  if (!/^[0-7]+$/u.test(text)) throw new TarHeaderError(`The npm tar ${label} is not octal.`);
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value) || value < 0) throw new TarHeaderError(`The npm tar ${label} is out of range.`);
  return value;
}

function tarText(field, label, allowEmpty = false) {
  const terminator = field.indexOf(0);
  const content = terminator === -1 ? field : field.subarray(0, terminator);
  if (terminator !== -1 && [...field.subarray(terminator + 1)].some((byte) => byte !== 0)) {
    throw new TarHeaderError(`The npm tar ${label} has invalid trailing bytes.`);
  }
  let value;
  try {
    value = TAR_TEXT_DECODER.decode(content);
  } catch {
    throw new TarHeaderError(`The npm tar ${label} is not valid UTF-8.`);
  }
  if (!allowEmpty && value.length === 0) throw new TarHeaderError(`The npm tar ${label} is empty.`);
  return value;
}

function isZeroBlock(block) {
  return block.every((byte) => byte === 0);
}

function assertZeroBytes(buffer, start, end, message) {
  for (let index = start; index < end; index += 1) {
    if (buffer[index] !== 0) throw new TarHeaderError(message);
  }
}

class TarHeaderError extends Error {}

async function assertExtractedTreeIsRegular(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) throw new Error("The extracted npm archive contains a symbolic link.");
    if (metadata.isDirectory()) await assertExtractedTreeIsRegular(path);
    else if (!metadata.isFile()) throw new Error("The extracted npm archive contains a non-regular file.");
  }
}

function assertWithinRoot(root, path) {
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new Error("Release input escapes the repository root.");
}

function hasControlCharacter(value) {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
