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

const packageJSON = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
if (packageJSON.dependencies?.["@latchway/client"] !== "0.1.0-dev.0") {
  throw new Error("Published JavaScript dependency is not pinned exactly.");
}
const ios = await readFile(new URL("../ios/LatchwayNativeBridge.swift", import.meta.url), "utf8");
const android = await readFile(
  new URL("../android/src/main/java/dev/latchway/reactnative/NativeLatchwayModule.kt", import.meta.url),
  "utf8",
);
if (!ios.includes(".reactNativeIOS")) throw new Error("iOS bridge does not select react_native_ios runtime identity.");
if (!android.includes("REACT_NATIVE_ANDROID")) throw new Error("Android bridge does not select react_native_android runtime identity.");
const podspec = await readFile(new URL("../LatchwayReactNative.podspec", import.meta.url), "utf8");
if (!podspec.includes('spec.dependency "Latchway/AppAttest", "0.1.0"')) {
  throw new Error("The iOS native dependency is not pinned to the locked release.");
}
const androidBuild = await readFile(new URL("../android/build.gradle.kts", import.meta.url), "utf8");
for (const coordinate of [
  'implementation("dev.latchway:latchway-okhttp:0.1.0")',
  'implementation("dev.latchway:latchway-play-integrity:0.1.0")',
]) {
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
