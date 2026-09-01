import { isDeepStrictEqual } from "node:util";

export function validateCocoaPodsSourceBinding(proofSource, publishedSource, repository, tag) {
  const keys = ["git", "tag"];
  if (!hasExactKeys(proofSource, keys) || !hasExactKeys(publishedSource, keys)
      || publishedSource.git !== repository || publishedSource.tag !== tag
      || !isDeepStrictEqual(proofSource, publishedSource)) {
    throw new Error("CocoaPods evidence source does not match the bound published podspec and release tag.");
  }
}

function hasExactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && isDeepStrictEqual(Object.keys(value).sort(), [...keys].sort());
}
