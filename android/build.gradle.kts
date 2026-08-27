plugins {
    id("com.android.library") version "8.12.0"
    id("org.jetbrains.kotlin.android") version "2.1.20"
    id("com.facebook.react")
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
    compileSdk = 36

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions { jvmTarget = "17" }

    lint {
        abortOnError = true
        warningsAsErrors = true
    }
}

dependencies {
    implementation("com.facebook.react:react-android")
    implementation("dev.latchway:latchway-okhttp:0.1.0")
    implementation("dev.latchway:latchway-play-integrity:0.1.0")
}
