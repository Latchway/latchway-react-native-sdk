import { readdir, readFile } from "node:fs/promises";
import { assertCurrentNativeSpec } from "./current-consumer-contract.mjs";

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
for (const forbidden of ["attestationEvidence", "integrityToken", "refreshToken", "accessToken", "privateKey", "requestHash", "clientDataHash", "identityToken", "idToken"]) {
  if (spec.includes(forbidden)) throw new Error(`TurboModule accepts forbidden protocol-owned material: ${forbidden}`);
}
assertCurrentNativeSpec(spec);
if (!spec.includes("appCommand(commandJSON: string): Promise<string>")) {
  throw new Error("Explicit supplied-identity transitions must use the native app command boundary.");
}
if (!spec.includes("revokeFamily(clientID: string, operationID: string): Promise<void>")) {
  throw new Error("No-argument family sign-out must delegate component discovery to the native durable registry.");
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
for (const [label, source, markers] of [
  ["iOS", ios, ["framework: .reactNativeFetch(version: self.frameworkVersion)", "frameworkVersion = reactNativeFrameworkVersion"]],
  // The native Android SDK chooses canonical framework metadata from this
  // platform; JavaScript no longer supplies a second framework configuration.
  ["Android", android, ["ProductionNativeClientOperations(app.makeClient(", "LatchwayClientPlatform.REACT_NATIVE_ANDROID, sdkVersion", "client.buildOkHttpClient("]],
]) {
  for (const marker of markers) {
    if (!source.includes(marker)) throw new Error(`${label} bridge omits canonical React Native framework metadata: ${marker}`);
  }
}
for (const marker of [
  'rootKeychainAccessGroup: apple?["rootKeychainAccessGroup"] as? String',
  "options.componentKeychainAccessGroups = groups",
  "LatchwayAppRegistry.shared.configure(options",
  'input["identityMode"] as? String == "supplied"',
  '"nativeAppABI": 3',
]) {
  if (!ios.includes(marker)) throw new Error(`iOS bridge omits explicit root Keychain boundary: ${marker}`);
}
for (const marker of [
  "client.prepareComponents(components.map(\\.configuration))",
  "client.replaceComponent(component.configuration)",
  "client.componentDiagnostics(component.configuration)",
  "client.revokeComponent(component.configuration)",
  "revokeCurrentInstallationFamily()",
]) {
  if (!ios.includes(marker)) throw new Error(`iOS bridge omits root component lifecycle operation: ${marker}`);
}
if (!android.includes('"rootKeychainAccessGroup", "sharedKeychainAccessGroups"')) {
  throw new Error("Android strict decoding does not accept the cross-platform Apple Keychain fields.");
}
for (const marker of [
  "framework: .reactNativeFetch(version: self.frameworkVersion)",
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
if (!ios.includes("withClient { try await $0.revokeCurrentInstallationFamily() }")) {
  throw new Error("iOS no-argument family sign-out does not invoke the native SDK's durable component registry path.");
}
for (const marker of [
  "LatchwayExtensionClient(",
  "definitionID: input.definitionID",
  "isApplicationExtensionProcess()",
  "runtime: .reactNativeIOS",
  "JSONDecoder().decode(LatchwayComponentAccount.self, from: data)",
  "component: component, account: account",
  '"delegated_direct_attested"',
]) {
  const source = marker === '"delegated_direct_attested"' ? joined : ios;
  if (!source.includes(marker)) throw new Error(`React Native component compatibility boundary is incomplete: ${marker}`);
}
const componentContext = ios.match(/private final class NativeComponentContext[\s\S]*?private func isApplicationExtensionProcess/u)?.[0] ?? "";
if (!componentContext) throw new Error("The iOS component security boundary could not be inspected.");
if (componentContext.includes("LatchwayAppAttestProvider(")) {
  throw new Error("The iOS extension component must not construct App Attest; generateKey is unavailable in iOS app extensions.");
}
if (componentContext.includes("directAttestationProvider:")) {
  throw new Error("The iOS extension component must use the delegated-only public initializer.");
}
if (componentContext.includes("rootKeychainAccessGroup") ||
    !componentContext.includes("keychainAccessGroup: input.keychainAccessGroup")) {
  throw new Error("The iOS extension component confuses the root-private and exact shared access groups.");
}
if (!android.includes("Account-bound iOS components are not supported by the Android bridge")) {
  throw new Error("Android must reject iOS component clients.");
}
if (!android.includes('.put("nativeAppABI", 3)') ||
    !android.includes('input.optString("identityMode", "") == "supplied"') ||
    !android.includes("LatchwayAppRegistry.configure(")) {
  throw new Error("Android must use the current supplied-account registry and bridge ABI.");
}
for (const [label, source] of [["iOS", ios], ["Android", android]]) {
  for (const forbidden of ["withIdentityToken", "NativeIdentityBroker", "legacySharedKeychainAccessGroups", "legacyComponents", "legacyMigration", "establishDirectAttestation", "revokeFamilyWithComponents"]) {
    if (source.includes(forbidden)) throw new Error(`${label} bridge retains a removed legacy path: ${forbidden}`);
  }
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
