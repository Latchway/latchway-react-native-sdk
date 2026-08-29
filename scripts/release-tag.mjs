const objectID = /^[0-9a-f]{40}$/u;
const tagName = /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function requireAnnotatedTagRefs(output, { tag, expectedCommit, label }) {
  if (typeof output !== "string" || output.length === 0 || output.includes("\0")
      || !tagName.test(tag) || !objectID.test(expectedCommit)
      || typeof label !== "string" || label.length === 0) {
    throw new Error("Public dependency tag verification received invalid input.");
  }
  const lines = output.trim().split("\n").map((line) => line.split(/\s+/u));
  if (lines.length !== 2 || lines.some((line) => line.length !== 2 || !objectID.test(line[0]))) {
    throw new Error(`${label} release tag ${tag} returned malformed or ambiguous refs.`);
  }
  const peeled = lines.find(([, reference]) => reference === `refs/tags/${tag}^{}`)?.[0];
  const direct = lines.find(([, reference]) => reference === `refs/tags/${tag}`)?.[0];
  if (direct === undefined || peeled === undefined || direct === peeled) {
    throw new Error(`${label} release tag ${tag} is not an annotated tag object.`);
  }
  if (peeled !== expectedCommit) throw new Error(`${label} release tag commit mismatch.`);
  return { commit: peeled, tagObject: direct };
}
