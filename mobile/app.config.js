// Expo configuration for the Looksee Android app: name, package ID, version,
// icons, and the build plugins. Read by Expo when the app is built or started.
//
// Version: kept the same as the engine and dashboard (lockstep). Android's
// versionCode must follow it as MAJOR×10000 + MINOR×100 + PATCH (5.8.0 →
// 50800), because Android refuses to install an update with a lower number;
// scripts/build-android.mjs checks this before every build.
//
// Security: release builds refuse plain http:// connections
// (usesCleartextTraffic false), so the session and phone tokens only ever travel
// over HTTPS. A debug build may allow http:// for testing against a local engine
// (an emulator reaching http://10.0.2.2:4100) by building with
// LOOKSEE_ALLOW_HTTP=1 set; that setting is never used for a release.

const allowHttp = process.env.LOOKSEE_ALLOW_HTTP === "1";

module.exports = {
  expo: {
    name: "Looksee",
    slug: "looksee",
    version: "5.10.0",
    orientation: "portrait",
    icon: "./assets/icon.png",
    // Follows the phone's light/dark setting unless changed in the app's Settings.
    userInterfaceStyle: "automatic",
    // looksee:// links open screens in the app; notification taps use them
    // (looksee://checks/<id>, looksee://alerts, looksee://settings).
    scheme: "looksee",
    android: {
      package: "com.haymondtechnologies.looksee",
      versionCode: 51000,
      // Keeps the app's data (sign-in token) out of Google's cloud backups.
      allowBackup: false,
      adaptiveIcon: {
        backgroundImage: "./assets/android-icon-background.png",
        foregroundImage: "./assets/android-icon-foreground.png",
        monochromeImage: "./assets/android-icon-monochrome.png",
      },
      predictiveBackGestureEnabled: false,
    },
    plugins: [
      "expo-router",
      "expo-font",
      "expo-secure-store",
      "expo-status-bar",
      [
        "expo-splash-screen",
        { image: "./assets/splash-icon.png", imageWidth: 140, resizeMode: "contain", backgroundColor: "#eceff4", dark: { image: "./assets/splash-icon.png", backgroundColor: "#0e1319" } },
      ],
      [
        "expo-build-properties",
        {
          android: {
            // Real phones are 64-bit ARM; an emulator build passes ANDROID_ABI
            // to the build server instead.
            buildArchs: ["arm64-v8a"],
            enableMinifyInReleaseBuilds: true,
            enableShrinkResourcesInReleaseBuilds: true,
            usesCleartextTraffic: allowHttp,
          },
        },
      ],
    ],
    experiments: { typedRoutes: false },
  },
};
