import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import packageJSON from "../package.json" with { type: "json" };
import compatibility from "../release-compatibility.json" with { type: "json" };

describe("React Native host compatibility", () => {
  it("separates the supported minimum from the pinned development baseline", () => {
    expect(packageJSON.peerDependencies.react).toBe("^18.2.0 || ^19.0.0");
    expect(packageJSON.peerDependencies["react-native"]).toBe(">=0.74.0 <1.0.0");
    expect(compatibility.react_native.react_peer).toBe(packageJSON.peerDependencies.react);
    expect(compatibility.react_native.supported_range).toBe(packageJSON.peerDependencies["react-native"]);
    expect(compatibility.react_native.minimum.react_native).toBe("0.74.0");
    expect(compatibility.react_native.minimum.react).toBe("18.2.0");
    expect(compatibility.react_native.new_architecture).toBe(true);
    expect(packageJSON.devDependencies["react-native"]).toBe(compatibility.react_native.baseline);
    expect(packageJSON.devDependencies.react).toBe(compatibility.react_native.react);
  });

  it("resolves Android runtime and Codegen from the consuming build", async () => {
    const build = await readFile(new URL("../android/build.gradle.kts", import.meta.url), "utf8");
    expect(build).toContain("workingDir(rootDir)");
    expect(build).toContain("require.resolve('react-native/package.json')");
    expect(build).toContain("require.resolve('@react-native/codegen/package.json', {paths: [process.argv[1]]})");
    expect(build).toContain("reactNativeDir.set(hostReactNativeDirectory)");
    expect(build).toContain("codegenDir.set(hostCodegenDirectory)");
    expect(build).toContain('implementation("com.facebook.react:react-android:$hostReactNativeVersion")');
    expect(build).not.toMatch(/react-android:0\.|file\("\.\.\/node_modules\/(?:react-native|@react-native\/codegen)"\)/u);
    for (const artifact of compatibility.android.artifacts) {
      expect(build).toContain(`implementation("dev.latchway:${artifact}:${compatibility.android.version}")`);
    }
  });

  it("tests real New Architecture registration without a gateway or test bridge", async () => {
    const [entry, android, ios, runner] = await Promise.all([
      readFile(new URL("../integration/minimum-host/index.js", import.meta.url), "utf8"),
      readFile(new URL("../integration/minimum-host/android/gradle.properties", import.meta.url), "utf8"),
      readFile(new URL("../integration/minimum-host/ios/Podfile", import.meta.url), "utf8"),
      readFile(new URL("../scripts/verify-minimum-host.mjs", import.meta.url), "utf8"),
    ]);
    expect(entry).toContain("TurboModuleRegistry.getEnforcing('NativeLatchway')");
    expect(entry).not.toContain("@latchway/react-native/testing");
    expect(entry).not.toContain("createLatchwayClient(");
    expect(android).toMatch(/^newArchEnabled=true$/mu);
    expect(ios).toContain("ENV['RCT_NEW_ARCH_ENABLED'] = '1'");
    expect(runner).toContain('"--strict-peer-deps"');
    expect(runner).not.toContain('"--legacy-peer-deps"');
    expect(runner).toContain('sdkRequire("react-native/package.json").version, minimum.react_native');
    expect(runner).toContain('sdkRequire("react/package.json").version, minimum.react');
  });

  it("keeps minimum-host toolchains explicit without disabling compiler validation", async () => {
    const [build, properties, wrapper] = await Promise.all([
      readFile(new URL("../integration/minimum-host/android/build.gradle", import.meta.url), "utf8"),
      readFile(new URL("../integration/minimum-host/android/gradle.properties", import.meta.url), "utf8"),
      readFile(new URL("../integration/minimum-host/android/gradle/wrapper/gradle-wrapper.properties", import.meta.url), "utf8"),
    ]);
    expect(build).toContain(`com.android.tools.build:gradle:${compatibility.react_native.minimum.android_gradle_plugin}`);
    expect(build).toContain(`kotlinVersion = "${compatibility.android.kotlin}"`);
    expect(build).toContain(`compileSdkVersion = ${compatibility.android.compile_sdk}`);
    expect(build).toContain("child.androidComponents.finalizeDsl");
    expect(build).toContain("androidDsl.compileOptions.sourceCompatibility = JavaVersion.VERSION_17");
    expect(build).toContain("androidDsl.compileOptions.targetCompatibility = JavaVersion.VERSION_17");
    expect(build).toContain("compilerOptions.jvmTarget.set(org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17)");
    expect(properties).toContain("react.internal.disableJavaVersionAlignment=true");
    expect(`${build}\n${properties}`).not.toMatch(/skipMetadataVersionCheck|allWarningsAsErrors\s*=\s*false|jvm\.target\.validation\.mode\s*=\s*ignore/u);
    expect(wrapper).toContain(`gradle-${compatibility.react_native.minimum.gradle}-bin.zip`);
    expect(wrapper).toMatch(/^distributionSha256Sum=[a-f0-9]{64}$/mu);
  });

  it("ships an opt-in adapter that preserves generated native providers", async () => {
    const adapter = await readFile(new URL("../android/react-native-074.gradle", import.meta.url), "utf8");
    const app = await readFile(new URL("../integration/minimum-host/android/app/build.gradle", import.meta.url), "utf8");
    expect(packageJSON.files).toContain("android/react-native-074.gradle");
    expect(app).toContain('apply from: file("../../node_modules/@latchway/react-native/android/react-native-074.gradle")');
    expect(app).toContain("autolinkLibrariesWithApp()");
    expect(adapter).toContain("versions[1] != '0.76.9'");
    expect(adapter).toContain("findProperty('newArchEnabled')?.toString() != 'true'");
    expect(adapter).toContain("dependsOn('generateAutolinkingNewArchitectureFiles')");
    for (const name of ["ModuleProvider", "cxxModuleProvider", "registerProviders"]) {
      expect(adapter).toContain(`.replace('autolinking_${name}', 'rncli_${name}')`);
    }
    expect(adapter).toContain("set(REACTNATIVE_MERGED_SO false)");
    expect(adapter).not.toContain("return nullptr");
  });
});
