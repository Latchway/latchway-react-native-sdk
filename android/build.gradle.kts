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
version = "0.1.0-dev.0"

react {
    root.set(file(".."))
    reactNativeDir.set(file("../node_modules/react-native"))
    codegenDir.set(file("../node_modules/@react-native/codegen"))
    libraryName.set("LatchwayReactNativeSpec")
    codegenJavaPackageName.set("dev.latchway.reactnative")
}

android {
    namespace = "dev.latchway.reactnative"
    // The exact native 0.1.0 AAR metadata requires API 37 consumers.
    compileSdk = 37

    defaultConfig {
        minSdk = 24
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
}

dependencies {
    // A real host's React plugin forces this to the installed 0.82.x patch. The
    // exact baseline keeps standalone package-consumer builds deterministic.
    implementation("com.facebook.react:react-android:0.82.0")
    implementation("dev.latchway:latchway-okhttp:0.1.0")
    implementation("dev.latchway:latchway-play-integrity:0.1.0")
}
