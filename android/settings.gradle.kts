pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
    plugins {
        // React Native 0.82 owns this supported consumer AGP baseline.
        id("com.android.library") version "8.12.0"
        id("org.jetbrains.kotlin.android") version "2.3.21"
    }
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

val latchwayNativeRepository = providers.gradleProperty("latchwayNativeRepository").orNull
    ?: providers.environmentVariable("LATCHWAY_NATIVE_REPOSITORY").orNull
val latchwayNativeVersion = providers.environmentVariable("LATCHWAY_NATIVE_VERSION").orNull
if (latchwayNativeVersion != null) {
    require(latchwayNativeRepository != null) { "A native development version requires an explicit local repository." }
    require(Regex("[0-9]+\\.[0-9]+\\.[0-9]+-dev").matches(latchwayNativeVersion))
    gradle.beforeProject {
        configurations.configureEach {
            resolutionStrategy.eachDependency {
                if (requested.group == "dev.latchway" && requested.name in setOf("latchway-core", "latchway-okhttp", "latchway-play-integrity", "latchway-firebase-auth", "latchway-bom")) useVersion(latchwayNativeVersion)
            }
        }
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        if (latchwayNativeRepository != null) {
            maven {
                name = "latchwayNativeDevelopment"
                url = uri(latchwayNativeRepository)
                content { includeGroup("dev.latchway") }
            }
        }
        google()
        mavenCentral()
    }
}

rootProject.name = "latchway-react-native"
