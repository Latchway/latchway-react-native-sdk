pluginManagement {
    includeBuild("../node_modules/@react-native/gradle-plugin")
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

val latchwayNativeRepository = providers.gradleProperty("latchwayNativeRepository").orNull
    ?: providers.environmentVariable("LATCHWAY_NATIVE_REPOSITORY").orNull

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
