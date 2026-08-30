import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("JavaScript security boundary", () => {
  it("is strict-CSP-safe and delegates cryptography and attestation to native code", async () => {
    const files = await walk(new URL("../src/", import.meta.url));
    const source = (await Promise.all(files.map(async (file) => readFile(file, "utf8")))).join("\n");
    expect(source).not.toMatch(/\beval\s*\(|new\s+Function|subtle\.generateKey/gu);
    expect(source).not.toMatch(/DCAppAttestService|IntegrityManagerFactory|KeyPairGenerator/gu);
  });

  it("uses opaque native dispatch and never returns protocol credentials through the bridge", async () => {
    const [spec, types, ios, android] = await Promise.all([
      readFile(new URL("../src/native/NativeLatchway.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
      readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8"),
      readFile(new URL("../android/src/main/java/dev/latchway/reactnative/NativeLatchwayModule.kt", import.meta.url), "utf8"),
    ]);
    expect(spec).toContain("identityToken: string");
    expect(spec).toContain("startRequest(");
    expect(spec).toContain("readResponseChunk(");
    expect(spec).toContain("closeResponse(");
    expect(spec).toContain("establishDirectAttestation(");
    expect(spec).toContain("componentDiagnostics(");
    expect(spec).toContain("configureComponent(");
    expect(spec).not.toContain("authorize(");
    expect(types).not.toContain("authorize(");
    expect(spec).not.toMatch(/accessToken|refreshToken|privateKey|clientDataHash|requestHash|integrityToken|attestationEvidence/gu);
    expect(spec).toContain("componentJSON: string");
    expect(types).toContain("LatchwayComponentClient");
    expect(types).toContain('"delegated_direct_attested"');
    expect(ios).toContain("componentDefinitionID: input.definitionID");
    expect(ios).toContain("isApplicationExtensionProcess()");
    expect(ios).toContain("clientRuntime: .reactNativeIOS");
    expect(ios).toContain("runComponent(clientID:");
    expect(android).toContain("Direct component attestation is not supported by this Android SDK");
    expect(ios).not.toMatch(/"(?:authorization|dpop|accessToken|refreshToken|privateKey)"\s*:/gu);
    expect(android).not.toMatch(/\.put\("(?:authorization|dpop|accessToken|refreshToken|privateKey)"/gu);
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

  it("isolates the extension-process client from the containing root lease and identity callback", async () => {
    const [spec, types, ios] = await Promise.all([
      readFile(new URL("../src/native/NativeLatchway.ts", import.meta.url), "utf8"),
      readFile(new URL("../src/types.ts", import.meta.url), "utf8"),
      readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8"),
    ]);
    const directMethod = spec.match(/establishDirectAttestation\([\s\S]*?\): Promise<void>;/u)?.[0] ?? "";
    const componentDiagnostics = spec.match(/componentDiagnostics\([\s\S]*?\): Promise<string>;/u)?.[0] ?? "";
    expect(directMethod).not.toContain("identityToken");
    expect(directMethod).not.toContain("componentJSON");
    expect(componentDiagnostics).not.toContain("identityToken");
    expect(types).toContain("A component-scoped client");
    expect(ios).toContain("guard isApplicationExtensionProcess()");
    expect(ios).toContain('bundle.bundleURL.pathExtension == "appex"');
    expect(ios).toContain('object(forInfoDictionaryKey: "NSExtension")');
    expect(ios).toContain("private var componentClients:");
    expect(ios).toContain("clientRuntime: .reactNativeIOS");
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
