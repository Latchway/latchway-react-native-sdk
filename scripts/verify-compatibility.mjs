import { access } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import {
  assertEqual,
  gitOutput,
  readJSON,
  readLock,
  readText,
  requireLockValue,
  requireMatch,
} from "./release-metadata.mjs";

const compatibility = await readJSON("release-compatibility.json");
const packageJSON = await readJSON("package.json");
const contractLock = await readLock();

if (compatibility.schema_version !== 1) throw new Error("Unsupported release compatibility schema.");
assertEqual(packageJSON.name, compatibility.react_native.package, "React Native package name");
assertEqual(packageJSON.version, compatibility.react_native.version, "React Native package version");
assertEqual(packageJSON.dependencies?.[compatibility.javascript.package], compatibility.javascript.version,
  "JavaScript runtime dependency");
assertEqual(packageJSON.devDependencies?.["react-native"], compatibility.react_native.baseline,
  "React Native development baseline");
const reactNativeLine = `${compatibility.react_native.baseline.split(".").slice(0, 2).join(".")}.x`;
assertEqual(packageJSON.peerDependencies?.["react-native"], reactNativeLine, "React Native supported line");
assertEqual(packageJSON.devDependencies?.react, compatibility.react_native.react,
  "React development baseline");
assertEqual(packageJSON.peerDependencies?.react, compatibility.react_native.react_peer, "React supported line");
if (compatibility.react_native.new_architecture !== true) {
  throw new Error("The locked React Native baseline must require the New Architecture.");
}

for (const [field, expected] of [
  ["contract_version", compatibility.contract.version],
  ["wire_protocol", String(compatibility.contract.wire_protocol)],
  ["core_commit", compatibility.contract.core_commit],
  ["bundle_sha256", compatibility.contract.bundle_sha256],
]) {
  assertEqual(requireLockValue(contractLock, field), expected, `contract.lock ${field}`);
}

const versionSource = await readText("src/version.ts");
assertEqual(requireMatch(versionSource, /SDK_VERSION = "([^"]+)"/u, "React Native SDK version constant"),
  compatibility.react_native.version, "React Native SDK version constant");
assertEqual(requireMatch(versionSource, /CONTRACT_VERSION = "([^"]+)"/u, "React Native contract constant"),
  compatibility.contract.version, "React Native contract constant");
assertEqual(Number(requireMatch(versionSource, /PROTOCOL_VERSION = (\d+)/u, "React Native protocol constant")),
  compatibility.contract.wire_protocol, "React Native protocol constant");

const podspec = await readText("LatchwayReactNative.podspec");
if (!podspec.includes('tag: "v#{spec.version}"')) {
  throw new Error("The React Native podspec source tag must match the annotated release tag convention.");
}
const escapedPod = escapeExpression(compatibility.ios.pod);
const escapedIOSVersion = escapeExpression(compatibility.ios.version);
if (!new RegExp(`spec\\.dependency "${escapedPod}", "${escapedIOSVersion}"`, "u").test(podspec)) {
  throw new Error("The podspec does not use the exact locked iOS dependency.");
}
assertEqual(requireMatch(podspec, /ios:\s*"([^"]+)"/u, "podspec minimum iOS version"),
  compatibility.ios.minimum_platform, "podspec minimum iOS version");

const androidBuild = await readText("android/build.gradle.kts");
const androidSettings = await readText("android/settings.gradle.kts");
const examplePackage = await readJSON("example/package.json");
const exampleAndroidBuild = await readText("example/android/build.gradle");
const npmConfiguration = await readText(".npmrc");
const examplePodfile = await readText("example/ios/Podfile");
assertEqual(examplePackage.dependencies?.["react-native"], compatibility.react_native.baseline,
  "example React Native baseline");
assertEqual(examplePackage.dependencies?.react, compatibility.react_native.react,
  "example React baseline");
for (const firebasePackage of ["@react-native-firebase/app", "@react-native-firebase/auth"]) {
  assertEqual(examplePackage.dependencies?.[firebasePackage], compatibility.react_native.firebase.react_native,
    `example ${firebasePackage}`);
}
assertEqual(requireMatch(npmConfiguration, /^node-linker=(\S+)$/mu, "pnpm Node linker"),
  compatibility.react_native.node_linker, "pnpm Node linker");
for (const requiredSetting of [
  "$RNFirebaseAsStaticFramework = true",
  "use_frameworks! :linkage => :static",
]) {
  if (!examplePodfile.includes(requiredSetting)) {
    throw new Error(`The iOS example must configure ${requiredSetting}.`);
  }
}
for (const cliPackage of [
  "@react-native-community/cli",
  "@react-native-community/cli-platform-android",
  "@react-native-community/cli-platform-ios",
]) {
  assertEqual(examplePackage.devDependencies?.[cliPackage], compatibility.react_native.cli,
    `example ${cliPackage}`);
}
if (!process.argv.includes("--metadata-only")) {
  const installedFirebase = await readJSON("node_modules/@react-native-firebase/app/package.json");
  assertEqual(installedFirebase.version, compatibility.react_native.firebase.react_native,
    "installed React Native Firebase version");
  assertEqual(installedFirebase.sdkVersions?.ios?.firebase, compatibility.react_native.firebase.apple_sdk,
    "Firebase Apple SDK version");
  assertEqual(installedFirebase.sdkVersions?.android?.firebase, compatibility.react_native.firebase.android_bom,
    "Firebase Android BOM version");
}
assertEqual(requireMatch(androidSettings, /id\("org\.jetbrains\.kotlin\.android"\) version "([^"]+)"/u,
  "Android Kotlin compiler"), compatibility.android.kotlin, "Android Kotlin compiler");
if (!androidBuild.includes(`implementation("com.facebook.react:react-android:${compatibility.react_native.baseline}")`)) {
  throw new Error("The standalone Android consumer does not resolve the exact React Native baseline.");
}
assertEqual(Number(requireMatch(androidBuild, /minSdk\s*=\s*(\d+)/u, "Android minimum SDK")),
  compatibility.android.minimum_sdk, "Android minimum SDK");
assertEqual(Number(requireMatch(androidBuild, /compileSdk\s*=\s*(\d+)/u, "Android compile SDK")),
  compatibility.android.compile_sdk, "Android compile SDK");
assertEqual(requireMatch(androidSettings, /id\("com\.android\.library"\) version "([^"]+)"/u,
  "Android consumer Gradle plugin"), compatibility.android.consumer_android_gradle_plugin,
  "Android consumer Gradle plugin");
assertEqual(Number(requireMatch(exampleAndroidBuild, /compileSdkVersion\s*=\s*(\d+)/u,
  "example Android compile SDK")), compatibility.android.compile_sdk, "example Android compile SDK");
assertEqual(requireMatch(exampleAndroidBuild, /kotlinVersion\s*=\s*"([^"]+)"/u,
  "example Android Kotlin compiler"), compatibility.android.kotlin, "example Android Kotlin compiler");
for (const artifact of compatibility.android.artifacts) {
  const coordinate = `${compatibility.android.group}:${artifact}:${compatibility.android.version}`;
  if (!androidBuild.includes(`implementation("${coordinate}")`)) {
    throw new Error(`The Android build does not use exact locked coordinate ${coordinate}.`);
  }
}

if (process.argv.includes("--sources")) await verifyDependencySources(compatibility);

async function verifyDependencySources(lock) {
  const javascriptRoot = dependencyRoot("LATCHWAY_JS_SDK_PATH", "../../latchway-js/");
  const iosRoot = dependencyRoot("LATCHWAY_IOS_SDK_PATH", "../../latchway-ios-sdk/");
  const androidRoot = dependencyRoot("LATCHWAY_ANDROID_SDK_PATH", "../../latchway-android/");
  const coreRoot = dependencyRoot("LATCHWAY_CORE_PATH", "../../latchway/");
  await Promise.all([
    requireDirectory(javascriptRoot, "JavaScript SDK"),
    requireDirectory(iosRoot, "iOS SDK"),
    requireDirectory(androidRoot, "Android SDK"),
    requireDirectory(coreRoot, "core"),
  ]);

  const coreHead = gitOutput(coreRoot, "rev-parse", "HEAD");
  assertEqual(
    gitOutput(coreRoot, "rev-parse", "--verify", `${lock.contract.core_commit}^{commit}`),
    lock.contract.core_commit,
    "locked core contract checkpoint",
  );
  assertEqual(
    gitOutput(coreRoot, "merge-base", lock.contract.core_commit, coreHead),
    lock.contract.core_commit,
    "core source ancestry",
  );
  const contractDrift = gitOutput(
    coreRoot,
    "diff",
    "--name-only",
    `${lock.contract.core_commit}..${coreHead}`,
    "--",
    "api",
  );
  if (contractDrift.length !== 0) {
    throw new Error(`Core source changed frozen contract files after ${lock.contract.core_commit}: ${contractDrift}`);
  }
  const coreProtocol = await readJSON("api/protocol-version.json", coreRoot);
  assertEqual(coreProtocol.contract_version, lock.contract.version, "core contract manifest version");
  assertEqual(coreProtocol.wire_protocol?.current, lock.contract.wire_protocol,
    "core contract manifest wire protocol");
  assertEqual(coreProtocol.bundle?.file_name, `latchway-contract-${lock.contract.version}.tar.gz`,
    "core contract bundle name");
  if (!coreProtocol.sdk_kinds?.includes("react-native")) {
    throw new Error("The locked core contract does not declare the React Native SDK kind.");
  }

  assertEqual(gitOutput(javascriptRoot, "rev-parse", "HEAD"), lock.javascript.source_commit,
    "JavaScript source commit");
  const javascriptPackage = await readJSON("package.json", javascriptRoot);
  const javascriptVersion = await readText("src/version.ts", javascriptRoot);
  assertEqual(javascriptPackage.name, lock.javascript.package, "JavaScript package name");
  assertEqual(javascriptPackage.version, lock.javascript.version, "JavaScript package version");
  assertEqual(requireMatch(javascriptVersion, /CONTRACT_VERSION = "([^"]+)"/u, "JavaScript contract constant"),
    lock.contract.version, "JavaScript contract constant");
  await verifyDependencyContract(javascriptRoot, lock.contract, "JavaScript");

  assertEqual(gitOutput(iosRoot, "rev-parse", "HEAD"), lock.ios.source_commit, "iOS source commit");
  const iosVersion = await readText("Sources/Latchway/LatchwayVersion.swift", iosRoot);
  const iosPodspec = await readText("Latchway.podspec", iosRoot);
  assertEqual(requireMatch(iosVersion, /sdk = "([^"]+)"/u, "iOS SDK version"), lock.ios.version,
    "iOS SDK version");
  assertEqual(requireMatch(iosVersion, /contract = "([^"]+)"/u, "iOS contract version"),
    lock.contract.version, "iOS contract version");
  assertEqual(requireMatch(iosPodspec, /spec\.version\s*=\s*['"]([^'"]+)['"]/u, "iOS podspec version"),
    lock.ios.version, "iOS podspec version");
  await verifyDependencyContract(iosRoot, lock.contract, "iOS");

  assertEqual(gitOutput(androidRoot, "rev-parse", "HEAD"), lock.android.source_commit, "Android source commit");
  const androidAPI = await readText("latchway-core/src/main/kotlin/dev/latchway/core/LatchwayApi.kt", androidRoot);
  assertEqual(requireMatch(androidAPI, /LATCHWAY_SDK_VERSION:\s*String\s*=\s*"([^"]+)"/u,
    "Android SDK version"), lock.android.version, "Android SDK version");
  assertEqual(requireMatch(androidAPI, /LATCHWAY_CONTRACT_VERSION:\s*String\s*=\s*"([^"]+)"/u,
    "Android contract version"), lock.contract.version, "Android contract version");
  const androidPublication = await readText("build.gradle.kts", androidRoot);
  const androidCatalog = await readText("gradle/libs.versions.toml", androidRoot);
  const androidCoreBuild = await readText("latchway-core/build.gradle.kts", androidRoot);
  assertEqual(requireMatch(androidCatalog, /^agp\s*=\s*"([^"]+)"/mu, "Android publisher Gradle plugin"),
    lock.android.publisher_android_gradle_plugin, "Android publisher Gradle plugin");
  assertEqual(Number(requireMatch(androidCoreBuild, /compileSdk\s*=\s*(\d+)/u,
    "Android publisher compile SDK")), lock.android.compile_sdk, "Android publisher compile SDK");
  for (const artifact of lock.android.artifacts) {
    if (!androidPublication.includes(`path = ":${artifact}"`)) {
      throw new Error(`Android source does not publish locked artifact ${artifact}.`);
    }
  }
  await verifyDependencyContract(androidRoot, lock.contract, "Android");
}

async function verifyDependencyContract(root, expected, label) {
  const lock = await readLock("contract.lock", root);
  assertEqual(requireLockValue(lock, "contract_version"), expected.version, `${label} contract lock version`);
  const wireField = lock.has("wire_protocol") ? "wire_protocol" : "wire_protocol_version";
  assertEqual(requireLockValue(lock, wireField), String(expected.wire_protocol), `${label} wire protocol lock`);
  assertEqual(requireLockValue(lock, "core_commit"), expected.core_commit, `${label} core commit lock`);
  assertEqual(requireLockValue(lock, "bundle_sha256"), expected.bundle_sha256, `${label} bundle lock`);
}

function dependencyRoot(environmentName, fallback) {
  const configured = process.env[environmentName];
  return configured === undefined ? new URL(fallback, import.meta.url) : pathToFileURL(`${configured}/`);
}

async function requireDirectory(root, description) {
  try {
    await access(new URL(".git/HEAD", root));
  } catch {
    throw new Error(`${description} source is required for --sources (${root.pathname}).`);
  }
}

function escapeExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
