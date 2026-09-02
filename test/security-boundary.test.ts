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
    expect(spec).toContain("prepareComponents(");
    expect(spec).toContain("replaceComponent(");
    expect(spec).toContain("rootComponentDiagnostics(");
    expect(spec).toContain("revokeComponent(");
    expect(spec).toContain("revokeFamilyWithComponents(");
    expect(spec).not.toContain("authorize(");
    expect(types).not.toContain("authorize(");
    expect(spec).not.toMatch(/accessToken|refreshToken|privateKey|clientDataHash|requestHash|integrityToken|attestationEvidence/gu);
    expect(spec).toContain("componentJSON: string");
    expect(types).toContain("LatchwayComponentClient");
    expect(types).toContain('"delegated_direct_attested"');
    expect(ios).toContain("definitionID: input.definitionID");
    expect(ios).toContain("isApplicationExtensionProcess()");
    expect(ios).toContain("clientRuntime: .reactNativeIOS");
    expect(ios).toContain("rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup");
    expect(ios).toContain("legacySharedKeychainAccessGroups: configuration.apple.legacySharedKeychainAccessGroups");
    expect(android).toContain('"rootKeychainAccessGroup", "legacySharedKeychainAccessGroups"');
    expect(ios).toContain("runComponent(clientID:");
    expect(android).toContain("Direct component attestation is not supported by this Android SDK");
    const rootDiagnostics = spec.match(/rootComponentDiagnostics\([\s\S]*?\): Promise<string>;/u)?.[0] ?? "";
    expect(rootDiagnostics).not.toContain("identityToken");
    expect(ios).toContain("client.prepareComponents(components.map(\\.configuration))");
    expect(ios).toContain("client.replaceComponent(component.configuration)");
    expect(ios).toContain("client.componentDiagnostics(component.configuration)");
    expect(ios).toContain("client.revokeComponent(component.configuration)");
    expect(ios).toContain("revokeCurrentInstallationFamily(retiring: components.map(\\.configuration))");
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
    const componentContext = ios.match(
      /private final class NativeComponentContext[\s\S]*?private func isApplicationExtensionProcess/u,
    )?.[0] ?? "";
    expect(componentContext).not.toContain("directAttestationProvider:");
    expect(componentContext).not.toContain("LatchwayAppAttestProvider(");
    expect(componentContext).toContain("rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup");
    expect(componentContext).toContain("keychainAccessGroup: input.keychainAccessGroup");
    expect(types).toContain("Retained for API compatibility");
    expect(types).toContain("attestation_unsupported");
  });

  it("FW-AUTH-104 and FW-AUTH-105 keep iOS identity and family work inside the native client", async () => {
    const ios = await readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8");
    const identityStart = ios.indexOf("func withIdentityToken<T: Sendable>");
    const identityEnd = ios.indexOf("\n    func close()", identityStart);
    const identityScope = ios.slice(identityStart, identityEnd);

    expect(identityScope).toContain("await identity.set(token)");
    expect(identityScope.match(/await identity\.clear\(\)/gu)).toHaveLength(2);
    expect(identityScope).toContain("await operationLock.acquire()");
    expect(ios).toContain("try await $0.revokeCurrentInstallationFamily()");
    expect(ios).toContain("revokeCurrentInstallationFamily(retiring: components.map(\\.configuration))");
    expect(ios).toContain("case .identityChanged:");
    expect(ios).toContain('code = "identity_reauthentication_required"');
    expect(ios).toContain("case .installationFamilyRevoked:");
    expect(ios).toContain('code = "installation_family_revoked"');
  });

  it("FW-SEC-102 keeps both native request decoders closed to caller credentials", async () => {
    const [typescript, ios, android] = await Promise.all([
      readFile(new URL("../src/client.ts", import.meta.url), "utf8"),
      readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8"),
      readFile(new URL("../android/src/main/java/dev/latchway/reactnative/NativeLatchwayModule.kt", import.meta.url), "utf8"),
    ]);

    expect(typescript).toContain("if (isForbiddenCredentialName(normalized)) return;");
    expect(ios).toContain("!isForbiddenCredentialName(name)");
    expect(android).toContain("!isForbiddenCredentialName(name)");
    expect(ios).toContain("request.setValue(pair[1], forHTTPHeaderField: pair[0])");
    expect(ios).not.toContain("request.addValue(");
    expect(android).not.toContain(".addHeader(");
  });

  it("FW-BEH-107 forbids production logging APIs and secret-bearing native rejection metadata", async () => {
    const typescriptFiles = await walk(new URL("../src/", import.meta.url));
    const [typescriptSources, ios, android] = await Promise.all([
      Promise.all(typescriptFiles.map(async (file) => readFile(file, "utf8"))),
      readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8"),
      readFile(new URL("../android/src/main/java/dev/latchway/reactnative/NativeLatchwayModule.kt", import.meta.url), "utf8"),
    ]);
    const typescript = typescriptSources.join("\n");

    expect(typescript).not.toMatch(/\bconsole\.(?:debug|info|log|warn|error|trace)\s*\(/gu);
    expect(android).not.toMatch(/\bandroid\.util\.Log\b|\bLog\.(?:v|d|i|w|e|wtf|println|isLoggable)\s*\(/gu);
    expect(ios).not.toMatch(/\b(?:NSLog|print|os_log)\s*\(|\b(?:os\.)?Logger\b|\bOSLog\b/gu);

    const rejectionStart = ios.indexOf("private static func reject(_ error: Error");
    const rejectionEnd = ios.indexOf("\nprivate actor LatchwayBridgeStore", rejectionStart);
    const rejectionEnvelope = ios.slice(rejectionStart, rejectionEnd);
    expect(rejectionEnvelope).toContain('"operationID": failure.operationID as Any');
    expect(rejectionEnvelope).not.toMatch(/identityToken|accessToken|refreshToken|attestationEvidence|privateKey/gu);
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
