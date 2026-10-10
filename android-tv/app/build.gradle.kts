import java.io.FileInputStream
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// Release signing config, read from keystore.properties (gitignored — see
// that file's own comment and .gitignore) rather than hardcoded here, so
// the actual keystore path/passwords never land in git. Falls back to
// building an *unsigned* release if that file doesn't exist yet, so a
// plain debug build still works with zero setup — signing only matters
// once you're producing the build you'll upload to Play Console.
//
// Imported explicitly (java.io.FileInputStream / java.util.Properties)
// rather than referenced inline as java.io.X / java.util.X — Gradle's
// Kotlin DSL adds an implicit `java` extension property to every build
// script (from the Android/Kotlin plugins), which shadows the `java`
// top-level package name and breaks a fully-qualified java.util.Foo /
// java.io.Foo reference ("Unresolved reference: util"/"io") even though
// the exact same classes work fine when imported normally.
val keystorePropertiesFile = rootProject.file("keystore.properties")
val keystoreProperties = Properties()
val hasKeystoreProperties = keystorePropertiesFile.exists()
if (hasKeystoreProperties) {
    keystoreProperties.load(FileInputStream(keystorePropertiesFile))
}

android {
    namespace = "com.vyzn.tv"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.vyzn.tv"
        // Android TV / Google TV boxes in real use (Shield, Chromecast with
        // Google TV, most smart-TV-embedded Android TV) are comfortably
        // API 24+; this also installs fine on a phone/tablet/emulator for
        // testing before you have a TV to side-load onto.
        minSdk = 24
        targetSdk = 34
        versionCode = 5
        versionName = "1.3.0"
    }

    signingConfigs {
        // A fixed debug key (committed on purpose — it only signs side-loaded
        // test builds, never Play releases) so every build, local or from
        // GitHub Actions, is signed the same and installs as an update over
        // the previous one instead of failing with "package conflicts".
        getByName("debug") {
            storeFile = rootProject.file("debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
        if (hasKeystoreProperties) {
            create("release") {
                storeFile = rootProject.file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("storePassword")
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("keyPassword")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasKeystoreProperties) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }

    buildFeatures {
        viewBinding = false
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.12.0")
    implementation("androidx.appcompat:appcompat:1.6.1")
    // WebViewCompat / ProcessGlobalConfig — lets us check for feature
    // support (e.g. force-dark) safely across older WebView versions
    // instead of hand-rolling API-level checks everywhere.
    implementation("androidx.webkit:webkit:1.10.0")
    implementation("com.google.android.material:material:1.11.0")

    // Native playback (PlayerActivity), used only for the direct/raw-file
    // path (/api/raw/:id) so multichannel (5.1+) source audio reaches the
    // TV/AVR intact — the WebView's HTML5 <video>/hls.js pipeline (still
    // used for every other screen, and still what /api/stream serves)
    // downmixes to stereo because browsers can't reliably play multichannel
    // audio via MediaSource Extensions at all, confirmed against this
    // server directly (hls.js "mediaSourceRequiresReset"). ExoPlayer runs
    // on Android's own media framework instead of a browser engine, so it
    // doesn't have that limitation. media3-exoplayer's default extractors
    // (bundled, no extra setup) cover MKV/MP4 containers with H.264/H.265
    // video and AAC audio — which is what VYZN's scanner/library already
    // assumes throughout. They do NOT include AC-3/E-AC-3/DTS/TrueHD
    // decoding (those require ExoPlayer's separately-built FFmpeg
    // extension, left for later — see vyzn-tv/README.md's native-player
    // section for what that would take and why it's not included here).
    implementation("androidx.media3:media3-exoplayer:1.3.1")
    // PlayerView: a ready-made, D-pad-navigable playback UI (play/pause,
    // seek bar, buffering spinner) built for exactly this — no reason to
    // hand-roll player chrome a second time in native code.
    implementation("androidx.media3:media3-ui:1.3.1")
}
