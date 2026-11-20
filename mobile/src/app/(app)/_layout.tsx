// Every screen available while signed in: the tab bar plus the detail and
// edit screens opened from it. Headers take their colours from the theme.
// Screens not listed here still work (Expo Router finds them by file); the
// list only sets titles.
//
// On the first signed-in start it asks, once, for what notifications need:
// Android 13+'s notification permission, then (with an explanation first) to
// leave Looksee out of battery saving so the connection survives the phone
// sleeping. Both can be changed later in Settings.

import { useEffect } from "react";
import { Alert, PermissionsAndroid, Platform } from "react-native";
import { Stack } from "expo-router";
import * as Storage from "../../lib/storage";
import * as Stream from "../../../modules/looksee-stream";
import { useTheme } from "../../lib/theme";

const ASKED = "looksee.askedPermissions";

/** Asks for notification permission and the battery exemption, once per install. */
async function askOnce() {
  if (Platform.OS !== "android" || !Stream.isAvailable() || (await Storage.getItem(ASKED))) return;
  await Storage.setItem(ASKED, "1");
  if (Number(Platform.Version) >= 33) await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
  if (!Stream.isIgnoringBatteryOptimizations()) {
    Alert.alert("Keep alerts coming", "Looksee keeps a connection to your server to receive alerts. Android's battery saving can cut it while the phone sleeps. On the next screen, allow Looksee to run in the background.", [
      { text: "Not now", style: "cancel" },
      { text: "Continue", onPress: () => Stream.requestIgnoreBatteryOptimizations() },
    ]);
  }
}

export default function AppLayout() {
  const { colors } = useTheme();
  useEffect(() => {
    void askOnce();
  }, []);
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.panel },
        headerTintColor: colors.text,
        headerTitleStyle: { color: colors.text },
        contentStyle: { backgroundColor: colors.bg },
      }}
    >
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
    </Stack>
  );
}
