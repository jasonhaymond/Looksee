# Looksee for Android

[← Looksee README](../README.md) · [User guide: Android app](../docs/user-guide.md#android-app) · [Deployment guide §12: building and installing](../docs/deployment-guide.md#12-the-android-app) · [Design decisions](../docs/plans/v5.8-android-app.md) · [CHANGELOG](../CHANGELOG.md)

**Current version: 5.8.0**, always the same as the engine and dashboard; see the
[CHANGELOG](../CHANGELOG.md) for history.

The Android app manages everything the dashboard does, with native screens, and receives
Looksee alerts as phone notifications over its own connection to the server (no Firebase
or other third-party push service).

## Contents

1. [How it fits together](#how-it-fits-together)
2. [How notifications reach the phone](#how-notifications-reach-the-phone)
3. [Folder layout](#folder-layout)
4. [Local development](#local-development)
5. [Checks before a release](#checks-before-a-release)
6. [Building](#building)
7. [Dependency pins](#dependency-pins)

## How it fits together

- **Screens** are React Native (Expo SDK 58, Expo Router): each file in `src/app/` is a
  screen. The tab bar is `src/app/(app)/(tabs)/`; everything signed-in lives under
  `src/app/(app)/`, which the root layout only allows while signed in.
- **The API client is the dashboard's own** (`dashboard/app/lib/api.ts`), imported
  through `src/lib/shared.ts`; so is the check-type registry (`checkTypes.ts`) that
  draws every check type's settings. `metro.config.js` lets the bundler read that folder.
  A new engine route or check type therefore reaches the app without a copy.
- **Signing in** uses the same two steps as the dashboard (password, then a required
  second factor) with `client: "app"`; the session token comes back in the response and
  is sent as `Authorization: Bearer …` (`src/lib/session.tsx`). It's kept in
  `expo-secure-store`, encrypted with the Android Keystore.

## How notifications reach the phone

1. After sign-in the app registers the phone (`POST /api/app/devices`) and gets a
   **notification-only token**, stored on the server only as a SHA-256 hash.
2. The token goes to a native **foreground service** (Kotlin, in
   `modules/looksee-stream/`), which keeps one WebSocket open to
   `wss://<server>/api/app/stream`. It runs without the app's JavaScript, so alerts arrive
   with the app closed; a boot receiver starts it again after a restart or an app update.
3. The engine queues each notification for each phone (`app_notifications`) and sends it
   while the phone is connected; the phone shows it and acknowledges it. A phone that was
   offline gets what it missed in the last 24 hours when it reconnects.
4. Reconnects back off from 5 s to 5 min and retry at once when the network returns.
   After 10 minutes without a connection the phone shows "Can't reach Looksee".

The engine side is `engine/src/services/appStream.ts` (the stream),
`engine/src/services/notifications/app.ts` (the channel) and `engine/src/routes/app.ts`
(phones), tested in `engine/test/app-notifications.test.ts`.

## Folder layout

| Path | What's there |
|---|---|
| `src/app/` | Screens (Expo Router: file = screen) |
| `src/components/` | Shared building blocks: UI kit, check settings inputs, alert rule form, prompt, chart |
| `src/lib/` | Session, theme, storage, data loading, formatting, the shared dashboard code |
| `modules/looksee-stream/` | The native notification service (Kotlin) and its JavaScript wrapper |
| `scripts/` | `build-android.mjs` (build server), `check-native-versions.mjs` |
| `app.config.js` | App name, package ID, version and versionCode, icons, build settings |
| `assets/` | Icons and splash image (drawn from the dashboard's logo) |

## Local development

```bash
cd mobile
npm install
npx expo start --web     # the screens in a browser at http://localhost:8081
```

The web preview is for checking screens only: it talks to a local engine (sign in with
`http://localhost:4100`; add `http://localhost:8081` to the engine's
`CORS_ALLOWED_ORIGINS`), keeps the session in memory only, and has no notification
service. Notifications need a real Android build: a debug build from the build server
(`npm run build:android -- --debug --abi x86_64 --allow-http` for the emulator, then
`adb install`).

## Checks before a release

```bash
npm run typecheck                         # TypeScript
npm run lint                              # ESLint, including the security rules
node scripts/check-native-versions.mjs    # native packages match the Expo SDK
npx expo-doctor                           # Expo's own dependency/config checks
npx expo export --platform android --output-dir dist-check   # the JavaScript bundle builds
```

The repository's security gate (`scripts/security-check.sh`) also runs the lint,
typecheck and `npm audit` for this folder, and Semgrep over its TypeScript and Kotlin.

## Building

Release APKs are built on the self-hosted build server from an approved, pushed release
tag. Once the Looksee server has the build server settings in `mobile/.env`,
`scripts/update.sh` builds each new version's APK right after updating the server;
otherwise run `npm run build:android -- --ref vX.Y.Z` here. See
[deployment guide §12](../docs/deployment-guide.md#12-the-android-app) for the one-time
setup, both ways of building and installing on a phone.

## Dependency pins

- `overrides.minimatch: ^11.0.9` in `package.json`: Expo's build tooling
  (`@expo/fingerprint`) asks for minimatch 10, which has a denial-of-service advisory
  (GHSA-g3hv-75wg-m249). Version 11 is API-compatible for its use. Remove the override
  once Expo depends on a fixed version.
- `react-native-gesture-handler`, `react-native-reanimated` and `react-native-worklets`
  are direct dependencies only to hold them at the versions Expo SDK 58 supports
  (`npx expo install` chose them): `expo-router` would otherwise pull newer ones, which
  build but crash on launch. `scripts/check-native-versions.mjs` catches a mismatch.
