import { readdir, readFile } from "node:fs/promises";

const sources = await sourceFiles(new URL("../src/", import.meta.url));
const joined = (await Promise.all(sources.map((file) => readFile(file, "utf8")))).join("\n");
for (const forbidden of [
  "subtle.generateKey",
  "SecKeyCreateRandomKey",
  "DCAppAttestService",
  "IntegrityManagerFactory",
  "KeyPairGenerator",
  "private_jwk_for_tests_only",
]) {
  if (joined.includes(forbidden)) throw new Error(`JavaScript source crosses the native security boundary: ${forbidden}`);
}

const spec = await readFile(new URL("../src/native/NativeLatchway.ts", import.meta.url), "utf8");
for (const forbidden of ["attestationEvidence", "integrityToken", "refreshToken", "accessToken", "privateKey", "requestHash", "clientDataHash"]) {
  if (spec.includes(forbidden)) throw new Error(`TurboModule accepts forbidden protocol-owned material: ${forbidden}`);
}
if (!spec.includes("identityToken: string")) {
  throw new Error("TurboModule must accept the transient app-owned identity token callback result.");
}
for (const required of [
  "startRequest(", "readResponseChunk(", "closeResponse(", "revokeFamily(",
  "configureComponent(", "establishDirectAttestation(", "componentDiagnostics(",
]) {
  if (!spec.includes(required)) throw new Error(`TurboModule omits native-owned transport primitive: ${required}`);
}
if (spec.includes("authorize(")) {
  throw new Error("TurboModule must not return a JavaScript authorization envelope.");
}
for (const method of ["establishDirectAttestation", "componentDiagnostics"]) {
  const signature = spec.match(new RegExp(`${method}\\([\\s\\S]*?\\): Promise<`))?.[0] ?? "";
  if (signature.includes("identityToken") || signature.includes("componentJSON")) {
    throw new Error(`${method} must use the separately configured component context without root identity input.`);
  }
}

const packageJSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const compatibility = JSON.parse(
  await readFile(new URL("../release-compatibility.json", import.meta.url), "utf8"),
);
if (packageJSON.dependencies?.[compatibility.javascript.package] !== compatibility.javascript.version) {
  throw new Error("Published JavaScript dependency is not pinned exactly.");
}
const ios = await readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8");
const android = await readFile(
  new URL("../android/src/main/java/dev/latchway/reactnative/NativeLatchwayModule.kt", import.meta.url),
  "utf8",
);
if (!ios.includes(".reactNativeIOS")) throw new Error("iOS bridge does not select react_native_ios runtime identity.");
if (!android.includes("REACT_NATIVE_ANDROID")) throw new Error("Android bridge does not select react_native_android runtime identity.");
for (const marker of [
  "rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup",
  "legacySharedKeychainAccessGroups: configuration.apple.legacySharedKeychainAccessGroups",
]) {
  if (!ios.includes(marker)) throw new Error(`iOS bridge omits explicit root Keychain boundary: ${marker}`);
}
if (!android.includes('"rootKeychainAccessGroup", "legacySharedKeychainAccessGroups"')) {
  throw new Error("Android strict decoding does not accept the cross-platform Apple Keychain fields.");
}
for (const marker of [
  "client.transport(feature: input.feature).bytes(for: preparedRequest)",
  "LatchwayAsyncBytes.AsyncIterator",
  "stream.bytes.makeAsyncIterator()",
  "stream.finish()",
  "stream.cancel()",
]) {
  if (!ios.includes(marker)) throw new Error(`iOS bridge omits SDK-owned streaming transport lifecycle: ${marker}`);
}
for (const forbidden of ["client.authorize(&authorizedRequest", "client.makeURLSession()", "session.bytes(for: authorizedRequest)"]) {
  if (ios.includes(forbidden)) throw new Error(`iOS bridge bypasses the SDK-owned streaming retry transport: ${forbidden}`);
}
for (const [label, source, marker] of [
  ["iOS", ios, "revokeCurrentInstallationFamily()"],
  ["Android", android, "revokeCurrentInstallationFamily()"],
]) {
  if (!source.includes(marker)) throw new Error(`${label} bridge omits installation-family revocation.`);
}
for (const marker of [
  "LatchwayExtensionClient(",
  "definitionID: input.definitionID",
  "establishDirectAttestation()",
  "isApplicationExtensionProcess()",
  "clientRuntime: .reactNativeIOS",
  '"delegated_direct_attested"',
]) {
  const source = marker === '"delegated_direct_attested"' ? joined : ios;
  if (!source.includes(marker)) throw new Error(`React Native component compatibility boundary is incomplete: ${marker}`);
}
const componentContext = ios.match(/private final class NativeComponentContext[\s\S]*?private func isApplicationExtensionProcess/u)?.[0] ?? "";
if (componentContext.includes("LatchwayAppAttestProvider(")) {
  throw new Error("The iOS extension component must not construct App Attest; generateKey is unavailable in iOS app extensions.");
}
if (componentContext.includes("directAttestationProvider:")) {
    throw new Error("The iOS extension component must use the delegated-only public initializer.");
}
if (!componentContext.includes("rootKeychainAccessGroup: configuration.apple.rootKeychainAccessGroup") ||
    !componentContext.includes("keychainAccessGroup: input.keychainAccessGroup")) {
  throw new Error("The iOS extension component confuses the root-private and exact shared access groups.");
}
if (!android.includes("Direct component attestation is not supported by this Android SDK")) {
  throw new Error("Android must fail closed until its native SDK exposes direct component attestation.");
}
for (const [label, source] of [["iOS", ios], ["Android", android]]) {
  for (const marker of ["/proxy/", "GET", "PATCH", "%2f", "%5c"]) {
    if (!source.toLowerCase().includes(marker.toLowerCase())) {
      throw new Error(`${label} bridge omits opaque-route boundary marker: ${marker}`);
    }
  }
}
if (/"(?:authorization|dpop|accessToken|refreshToken|privateKey)"\s*:/u.test(ios)) {
  throw new Error("iOS bridge serializes credential material to JavaScript.");
}
if (/\.put\("(?:authorization|dpop|accessToken|refreshToken|privateKey)"/u.test(android)) {
  throw new Error("Android bridge serializes credential material to JavaScript.");
}
const podspec = await readFile(new URL("../LatchwayReactNative.podspec", import.meta.url), "utf8");
if (!podspec.includes(`spec.dependency "${compatibility.ios.pod}", "${compatibility.ios.version}"`)) {
  throw new Error("The iOS native dependency is not pinned to the locked release.");
}
const androidBuild = await readFile(new URL("../android/build.gradle.kts", import.meta.url), "utf8");
for (const artifact of compatibility.android.artifacts) {
  const coordinate = `implementation("${compatibility.android.group}:${artifact}:${compatibility.android.version}")`;
  if (!androidBuild.includes(coordinate)) throw new Error(`The Android native dependency is not pinned: ${coordinate}`);
}

async function sourceFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) output.push(...await sourceFiles(url));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) output.push(url);
  }
  return output;
}
