const fingerprintPattern = /^[0-9A-F]{40}$/u;
const statusTagPattern = /^[A-Z][A-Z0-9_]*$/u;
const approvedPublicKeyAlgorithms = new Set(["1", "3", "19", "22", "27"]);
const requiredHashAlgorithm = "10";
const allowedTags = new Set([
  "NEWSIG",
  "KEY_CONSIDERED",
  "SIG_ID",
  "GOODSIG",
  "VALIDSIG",
  "TRUST_UNDEFINED",
  "TRUST_NEVER",
  "TRUST_MARGINAL",
  "TRUST_FULLY",
  "TRUST_ULTIMATE",
  "VERIFICATION_COMPLIANCE_MODE",
]);
const invalidTags = new Set([
  "BADSIG",
  "ERRSIG",
  "EXPSIG",
  "EXPKEYSIG",
  "REVKEYSIG",
  "NO_PUBKEY",
  "NODATA",
  "BADARMOR",
  "FAILURE",
  "ERROR",
  "INV_SGNR",
  "DECRYPTION_FAILED",
  "KEYEXPIRED",
  "SIGEXPIRED",
  "KEYREVOKED",
]);

export function validateGPGStatus(statusLines, expectedPrimaryFingerprint) {
  if (!fingerprintPattern.test(expectedPrimaryFingerprint)) {
    throw new Error("Expected Maven primary signing fingerprint is invalid.");
  }
  if (!Array.isArray(statusLines) || statusLines.length === 0 || statusLines.length > 64) {
    throw new Error("GnuPG status output has an invalid line count.");
  }
  const byTag = new Map();
  for (const line of statusLines) {
    if (typeof line !== "string" || line.length === 0 || line.length > 2048
        || !line.startsWith("[GNUPG:] ")
        || [...line].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
      throw new Error("GnuPG emitted a malformed or non-status line.");
    }
    const fields = line.slice("[GNUPG:] ".length).split(" ");
    if (fields.length === 0 || fields.some((field) => field.length === 0)) {
      throw new Error("GnuPG emitted malformed status fields.");
    }
    const [tag, ...arguments_] = fields;
    if (!statusTagPattern.test(tag)) throw new Error("GnuPG emitted a malformed status tag.");
    if (invalidTags.has(tag)) throw new Error(`GnuPG rejected the signature with ${tag}.`);
    if (!allowedTags.has(tag)) throw new Error(`GnuPG emitted unreviewed status ${tag}.`);
    const entries = byTag.get(tag) ?? [];
    entries.push(arguments_);
    byTag.set(tag, entries);
  }

  requireCount(byTag, "NEWSIG", 1);
  requireCount(byTag, "GOODSIG", 1);
  requireCount(byTag, "VALIDSIG", 1);
  requireCount(byTag, "SIG_ID", 1);
  if (!byTag.has("KEY_CONSIDERED")) throw new Error("GnuPG did not bind the signature to the reviewed key.");

  const valid = byTag.get("VALIDSIG")[0];
  if (!new Set([9, 10]).has(valid.length)) throw new Error("GnuPG VALIDSIG field count is invalid.");
  const signingFingerprint = valid[0];
  const primaryFingerprint = valid.length === 10 ? valid[9] : signingFingerprint;
  if (!fingerprintPattern.test(signingFingerprint) || !fingerprintPattern.test(primaryFingerprint)
      || primaryFingerprint !== expectedPrimaryFingerprint) {
    throw new Error("GnuPG signature does not descend from the pinned primary key.");
  }
  const [signatureVersion, reserved, publicKeyAlgorithm, hashAlgorithm, signatureClass] = valid.slice(4, 9);
  if (!new Set(["4", "5", "6"]).has(signatureVersion) || reserved !== "0"
      || !approvedPublicKeyAlgorithms.has(publicKeyAlgorithm) || hashAlgorithm !== requiredHashAlgorithm
      || signatureClass !== "00") {
    throw new Error("GnuPG VALIDSIG uses an unapproved algorithm, digest, or signature class.");
  }

  const goodsig = byTag.get("GOODSIG")[0];
  if (goodsig.length < 2 || !/^(?:[0-9A-F]{16}|[0-9A-F]{40})$/u.test(goodsig[0])
      || !(goodsig[0] === signingFingerprint
        || (goodsig[0].length === 16 && signingFingerprint.endsWith(goodsig[0])))) {
    throw new Error("GnuPG GOODSIG does not match the validated signing fingerprint.");
  }
  for (const considered of byTag.get("KEY_CONSIDERED")) {
    if (considered.length !== 2 || considered[0] !== expectedPrimaryFingerprint || considered[1] !== "0") {
      throw new Error("GnuPG considered a key other than the usable pinned primary key.");
    }
  }
  const signatureID = byTag.get("SIG_ID")[0];
  if (signatureID.length !== 3 || signatureID.some((field) => field.length === 0)) {
    throw new Error("GnuPG SIG_ID fields are invalid.");
  }
  const trustTags = [...byTag.keys()].filter((tag) => tag.startsWith("TRUST_"));
  if (trustTags.length > 1 || trustTags.some((tag) => byTag.get(tag).length !== 1)) {
    throw new Error("GnuPG trust status is ambiguous.");
  }
  const compliance = byTag.get("VERIFICATION_COMPLIANCE_MODE") ?? [];
  if (compliance.length > 1 || compliance.some((entry) => entry.length !== 1 || !/^\d+$/u.test(entry[0]))) {
    throw new Error("GnuPG verification compliance status is invalid.");
  }
  return { primaryFingerprint, signingFingerprint };
}

function requireCount(byTag, tag, expected) {
  if ((byTag.get(tag) ?? []).length !== expected) {
    throw new Error(`GnuPG did not report exactly ${expected} ${tag} status.`);
  }
}
