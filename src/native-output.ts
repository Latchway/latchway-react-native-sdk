import { LatchwayError } from "@latchway/client";

const forbiddenCredentialKeyFragments = [
  "authorization",
  "dpop",
  "accesstoken",
  "refreshtoken",
  "privatekey",
  "sessiontoken",
  "identitytoken",
  "integritytoken",
  "attestationevidence",
  "clientdatahash",
  "requesthash",
  "credential",
  "secret",
  "jwk",
] as const;

const forbiddenExactCredentialKeys = new Set(["key", "proof", "token"]);

/** Fails closed when a native return or rejection envelope names credential material. */
export function assertNoCredentialFields(value: unknown): void {
  if (containsCredentialField(value)) {
    throw new LatchwayError("protocol_response_invalid", "Latchway native output crossed the credential boundary.");
  }
}

function containsCredentialField(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsCredentialField);
  if (!isRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    const compact = key.replace(/[^A-Za-z0-9]/gu, "").toLowerCase();
    if (forbiddenExactCredentialKeys.has(compact) ||
        forbiddenCredentialKeyFragments.some((fragment) => compact.includes(fragment))) return true;
    if (containsCredentialField(item)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
