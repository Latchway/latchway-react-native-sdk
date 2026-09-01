pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

val latchwayNativeRepository = providers.environmentVariable("LATCHWAY_NATIVE_REPOSITORY")
    .orNull
    ?.takeIf(String::isNotBlank)
    ?: error("LATCHWAY_NATIVE_REPOSITORY must name the exact locked local publication")

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        exclusiveContent {
            forRepository {
                maven {
                    name = "exactLockedLatchwayAndroid"
                    url = uri(latchwayNativeRepository)
                }
            }
            filter { includeGroup("dev.latchway") }
        }
        google()
        mavenCentral {
            content { excludeGroup("dev.latchway") }
        }
    }
}

rootProject.name = "latchway-react-native-pr-native-driver"
