import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("JavaScript security boundary", () => {
  it("is strict-CSP-safe and delegates cryptography and attestation to native code", async () => {
    const files = await walk(new URL("../src/", import.meta.url));
    const source = (await Promise.all(files.map(async (file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/\beval\s*\(|new\s+Function|subtle\.generateKey/gu);
    expect(source).not.toMatch(/DCAppAttestService|IntegrityManagerFactory|KeyPairGenerator/gu);
  });

  it("never makes protocol-owned secrets or attestation evidence native inputs", async () => {
    const spec = await readFile(new URL("../src/native/NativeLatchway.ts", import.meta.url), "utf8");
    expect(spec).toContain("identityToken: string");
    expect(spec).not.toMatch(/accessToken|refreshToken|privateKey|clientDataHash|requestHash|integrityToken|attestationEvidence/gu);
  });

  it("carries only the canonical operation reconciliation identifier through native failures", async () => {
    const [ios, android] = await Promise.all([
      readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8"),
      readFile(new URL("../android/src/main/java/dev/latchway/reactnative/NativeLatchwayModule.kt", import.meta.url), "utf8"),
    ]);
    expect(ios).toContain('"operationID": failure.operationID as Any');
    expect(android).toContain('putString("operationID", it)');
    expect(`${ios}\n${android}`).not.toMatch(/operation.?detail|operation.?payload|operation.?result/iu);
  });
});

async function walk(directory: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) files.push(...await walk(url));
    else if (entry.name.endsWith(".ts")) files.push(url);
  }
  return files;
}
