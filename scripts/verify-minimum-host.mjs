import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isolatedRegistryEnvironment, writeRegistryNpmrcs } from "./npm-registry-isolation.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const lock = JSON.parse(await readFile(join(root, "release-compatibility.json"), "utf8"));
const minimum = lock.react_native.minimum;
const archiveArgument = process.argv.indexOf("--tarball");
if (archiveArgument !== -1 && !process.argv[archiveArgument + 1]?.endsWith(".tgz")) {
  throw new Error("--tarball requires an existing npm archive path.");
}
const archive = resolve(archiveArgument === -1
  ? join(root, ".artifacts", `latchway-react-native-${manifest.version}.tgz`)
  : process.argv[archiveArgument + 1]);
await readFile(archive);
const directory = await mkdtemp(join(tmpdir(), "latchway-minimum-host-"));
console.log(`Minimum host: ${directory}`);
const userconfig = join(directory, ".npmrc");
const globalconfig = join(directory, ".global.npmrc");
writeRegistryNpmrcs(userconfig, globalconfig, ["fund=false", "strict-peer-deps=true"]);
const environment = isolatedRegistryEnvironment(process.env, {
  cache: join(directory, ".npm-cache"), userconfig, globalconfig,
  excludedNames: ["NODE_AUTH_TOKEN", "NPM_TOKEN"],
});
const run = (command, args, cwd = directory, extraEnvironment = {}) =>
  execFileSync(command, args, { cwd, env: { ...environment, ...extraEnvironment }, stdio: "inherit" });
let passed = false;
try {
  await writeFile(join(directory, "package.json"), JSON.stringify({
    name: "latchway-minimum-host", version: "0.0.0", private: true,
    dependencies: {
      "@latchway/react-native": `file:${archive}`,
      "@latchway/client": lock.javascript.version,
      react: minimum.react,
      "react-native": minimum.react_native,
    },
    // Old VirtualizedLists has wildcard RN peers. Keep npm from selecting a
    // second, current RN release while resolving that peer cycle. Strict peer
    // validation stays enabled and the resolved host versions are asserted.
    overrides: {
      "react-native": "$react-native", react: "$react", "@types/react": "$@types/react",
    },
    devDependencies: {
      "@babel/core": "7.29.0",
      "@react-native/babel-preset": minimum.codegen,
      "@react-native/metro-config": minimum.codegen,
      "@react-native/gradle-plugin": minimum.gradle_plugin,
      "@react-native-community/cli": minimum.cli,
      "@react-native-community/cli-platform-ios": minimum.cli,
      "@react-native-community/cli-platform-android": minimum.cli,
      "@types/react": minimum.react_types,
      typescript: manifest.devDependencies.typescript,
      // Codegen 0.74's CLI uses parseSync but lists yargs only as a devDependency.
      yargs: "17.7.2",
    },
  }, null, 2) + "\n");
  run("npm", ["install", "--ignore-scripts", "--no-audit", "--strict-peer-deps"]);
  const hostRequire = createRequire(join(directory, "package.json"));
  const sdkRequire = createRequire(hostRequire.resolve("@latchway/react-native/package.json"));
  assert.equal(sdkRequire("./package.json").version, manifest.version);
  assert.equal(hostRequire("react/package.json").version, minimum.react);
  assert.equal(hostRequire("@react-native/gradle-plugin/package.json").version, minimum.gradle_plugin);
  assert.equal(sdkRequire("react-native/package.json").version, minimum.react_native);
  assert.equal(sdkRequire("react/package.json").version, minimum.react);
  const reactNativeRoot = join(directory, "node_modules/react-native");
  for (const entry of ["android", "ios", "babel.config.js", "metro.config.js", "app.json"]) {
    await cp(join(reactNativeRoot, "template", entry), join(directory, entry), { recursive: true });
  }
  await cp(join(root, "integration/minimum-host"), directory, { recursive: true });
  await cp(join(root, "integration/consumer/index.ts"), join(directory, "consumer.mts"));
  const typeConfig = JSON.parse(await readFile(join(root, "integration/consumer/tsconfig.json"), "utf8"));
  typeConfig.include = ["consumer.mts"];
  await writeFile(join(directory, "tsconfig.json"), JSON.stringify(typeConfig, null, 2) + "\n");
  run(process.execPath, [hostRequire.resolve("typescript/bin/tsc"), "-p", "tsconfig.json"]);
  const generated = join(directory, "generated");
  await mkdir(generated);
  const codegenRoot = join(reactNativeRoot, "..");
  const codegenRequire = createRequire(join(reactNativeRoot, "package.json"));
  const schema = join(generated, "schema.json");
  const nativeSource = join(directory, "node_modules/@latchway/react-native/src/native");
  run(process.execPath, [codegenRequire.resolve("@react-native/codegen/lib/cli/combine/combine-js-to-schema-cli.js"), schema, nativeSource]);
  run(process.execPath, [codegenRequire.resolve("@react-native/codegen/lib/cli/generators/generate-all.js"), schema,
    "LatchwayReactNativeSpec", generated, "dev.latchway.reactnative", "true"]);
  const parsed = JSON.parse(await readFile(schema, "utf8"));
  const spec = parsed.modules.NativeLatchway.spec;
  assert.equal((spec.methods ?? spec.properties).length, 19);
  for (const platform of ["ios", "android"]) {
    run(process.execPath, [join(codegenRoot, "react-native/cli.js"), "bundle", "--platform", platform,
      "--dev", "false", "--entry-file", "index.js", "--bundle-output", join(generated, `${platform}.jsbundle`),
      "--max-workers", "2"]);
  }
  if (process.argv.includes("--android")) {
    run(join(directory, "android/gradlew"), ["-p", join(directory, "android"), ":app:assembleDebug", "--no-daemon", "--max-workers=2"]);
  }
  if (process.argv.includes("--ios")) {
    run("pod", ["install"], join(directory, "ios"), { RCT_NEW_ARCH_ENABLED: "1" });
    const deviceBuild = process.argv.includes("--ios-device");
    run("xcodebuild", ["-workspace", "HelloWorld.xcworkspace", "-scheme", "HelloWorld", "-configuration", "Debug",
      "-sdk", deviceBuild ? "iphoneos" : "iphonesimulator", "-destination",
      deviceBuild ? "generic/platform=iOS" : "generic/platform=iOS Simulator",
      "-derivedDataPath", join(directory, "DerivedData"), "-jobs", "2",
      "CODE_SIGNING_ALLOWED=NO", "IPHONEOS_DEPLOYMENT_TARGET=15.1",
      `ARCHS=${deviceBuild || process.arch === "arm64" ? "arm64" : "x86_64"}`,
      "ONLY_ACTIVE_ARCH=YES", "build"], join(directory, "ios"));
  }
  passed = true;
  console.log(`React Native ${minimum.react_native} / React ${minimum.react}: package, types, Codegen and both Metro bundles passed.`);
  console.log("Native builds run only when --android / --ios is specified. This is not physical attestation evidence.");
} finally {
  if (passed && !process.argv.includes("--keep")) await rm(directory, { recursive: true, force: true });
  else console.log(`Retained minimum host: ${directory}`);
}
