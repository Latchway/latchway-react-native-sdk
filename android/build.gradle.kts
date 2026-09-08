import groovy.json.JsonSlurper
import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("com.facebook.react")
}

kotlin {
    compilerOptions { jvmTarget.set(JvmTarget.JVM_17) }
}

group = "dev.latchway"
version = "1.2.0"

// Resolve from the consuming build, not this library's node_modules. npm and
// pnpm can hoist React Native and Codegen; the host owns both versions.
val hostReactNativeManifest = file(providers.exec {
    workingDir(rootDir)
    commandLine("node", "--print", "require.resolve('react-native/package.json')")
}.standardOutput.asText.get().trim())
val hostReactNativeDirectory = hostReactNativeManifest.parentFile
val hostReactNativeVersion =
    (JsonSlurper().parse(hostReactNativeManifest) as Map<*, *>)["version"] as String
val hostCodegenDirectory = file(providers.exec {
    workingDir(rootDir)
    commandLine(
        "node", "--print",
        "require.resolve('@react-native/codegen/package.json', {paths: [process.argv[1]]})",
        hostReactNativeDirectory.absolutePath,
    )
}.standardOutput.asText.get().trim()).parentFile

react {
    root.set(file(".."))
    reactNativeDir.set(hostReactNativeDirectory)
    codegenDir.set(hostCodegenDirectory)
    libraryName.set("LatchwayReactNativeSpec")
    codegenJavaPackageName.set("dev.latchway.reactnative")
}

android {
    namespace = "dev.latchway.reactnative"
    // The shared-native source candidate is compiled against API 34. Hosts
    // may select a newer API for React Native or their other dependencies.
    compileSdk = 34

    defaultConfig {
        minSdk = 24
        aarMetadata { minCompileSdk = 34 }
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = true
        warningsAsErrors = true
        // These versions are compatibility inputs, not opportunistic upgrades.
        // scripts/verify-compatibility.mjs enforces the reviewed exact lock.
        disable += setOf("AndroidGradlePluginVersion", "NewerVersionAvailable")
    }

    testOptions {
        unitTests.isIncludeAndroidResources = true
    }
}

dependencies {
    // Also use the host version in standalone library builds, where no app
    // plugin is present to align react-android automatically.
    implementation("com.facebook.react:react-android:$hostReactNativeVersion")
    implementation("dev.latchway:latchway-okhttp:1.1.0")
    implementation("dev.latchway:latchway-play-integrity:1.1.0")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:5.3.0")
}
