// Lootsy na Androida: Trusted Web Activity, czyli aplikacja otwierająca https://mattcex.github.io/konkursy/
// na pełnym ekranie (silnik Chrome). Brak własnego kodu – wszystko robi android-browser-helper.
plugins {
    id("com.android.application")
}

val appVersionCode = (findProperty("versionCode") as String?)?.toIntOrNull() ?: 1
val appVersionName = (findProperty("versionName") as String?) ?: "1.0.0"
val keystorePath: String? = System.getenv("LOOTSY_KEYSTORE")

android {
    namespace = "io.github.mattcex.lootsy"
    compileSdk = 36

    defaultConfig {
        applicationId = "io.github.mattcex.lootsy"
        minSdk = 24
        targetSdk = 36
        versionCode = appVersionCode
        versionName = appVersionName
    }

    signingConfigs {
        create("release") {
            if (keystorePath != null) {
                storeFile = file(keystorePath)
                storeType = "pkcs12"
                storePassword = System.getenv("LOOTSY_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("LOOTSY_KEY_ALIAS") ?: "lootsy"
                keyPassword = System.getenv("LOOTSY_KEYSTORE_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            // Bez klucza (np. lokalnie) wydanie podpisuje się kluczem debug.
            signingConfig = if (keystorePath != null) signingConfigs.getByName("release") else signingConfigs.getByName("debug")
        }
    }

    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}

dependencies {
    implementation("com.google.androidbrowserhelper:androidbrowserhelper:2.7.4")
}
