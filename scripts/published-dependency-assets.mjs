const KIB = 1024;
const MIB = 1024 * KIB;

export const MAXIMUM_JAVASCRIPT_ADOPTION_BYTES = 256 * KIB;

export function publishedDependencyAssetMaximumBytes(kind, name) {
  if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) {
    throw new Error("Published dependency release asset has an invalid name.");
  }
  if (kind === "javascript") {
    if (/^npm-release-adoption-(?:client|openai|vercel-ai|langchain)-[1-9]\d*-[1-9]\d*\.json$/u.test(name)) {
      return MAXIMUM_JAVASCRIPT_ADOPTION_BYTES;
    }
    if (/^latchway-(?:client|openai|vercel-ai|langchain)-.+\.tgz$/u.test(name)) return 20 * MIB;
    if (/^docs-bundle-.+\.tar\.gz$/u.test(name)) return 64 * MIB;
    if (name === "SHA256SUMS") return 64 * KIB;
    if (/^npm-(?:client|openai|vercel-ai|langchain)-attestations\.json$/u.test(name)) return 10 * MIB;
    if (name.endsWith(".json")) return 10 * MIB;
  } else if (kind === "ios") {
    if (/^latchway-ios-sdk-.+\.tar\.gz$/u.test(name)) return 256 * MIB;
    if (/^latchway-ios-sdk-.+\.tar\.gz\.sha256$/u.test(name)) return 64 * KIB;
    if (/^docs-bundle-.+\.tar\.gz$/u.test(name)) return 64 * MIB;
    if (name === "cocoapods-release-evidence.SHA256SUMS") return 64 * KIB;
    if (name.endsWith(".json")) return 10 * MIB;
  } else if (kind === "android") {
    if (/^latchway-android-.+-(?:maven-repository|central-portal)\.zip$/u.test(name)) return 256 * MIB;
    if (/^docs-bundle-.+\.tar\.gz$/u.test(name)) return 64 * MIB;
    if (name === "pinned-core-conformance.tar.gz") return 128 * MIB;
    if (name === "SHA256SUMS") return 64 * KIB;
    if (name === "latchway-maven-signing-public-key.asc") return MIB;
    if (name.endsWith(".json")) return 10 * MIB;
  }
  throw new Error(`Published ${kind} dependency release contains an unbounded asset ${name}.`);
}

export function validatePublishedDependencyAssetMetadata(asset, kind, name) {
  const maximumBytes = publishedDependencyAssetMaximumBytes(kind, name);
  if (asset === null || typeof asset !== "object" || Array.isArray(asset)
      || asset.name !== name || !Number.isSafeInteger(asset.id) || asset.id < 1
      || asset.state !== "uploaded" || !Number.isSafeInteger(asset.size)
      || asset.size < 1 || asset.size > maximumBytes
      || (asset.digest !== undefined && asset.digest !== null && asset.digest !== ""
        && (typeof asset.digest !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)))) {
    throw new Error(`Published dependency release asset ${name} has invalid bounded metadata.`);
  }
  return maximumBytes;
}
