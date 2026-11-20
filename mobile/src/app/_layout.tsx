// The app's root: wraps every screen in the theme and sign-in state, and
// decides what can be shown. Signed out, only the sign-in screen is reachable;
// signed in, everything in the (app) folder is. Stack.Protected enforces this
// for every way in, including looksee:// links from notification taps.
//
// Expo Router turns files in src/app into screens: a folder in brackets like
// (app) groups screens without appearing in the address, so
// (app)/checks/[id].tsx is looksee://checks/<id>.

import { Stack } from "expo-router";
import { StatusBar } from "expo-status-bar";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ThemeProvider, useTheme } from "../lib/theme";
import { SessionProvider, useSession } from "../lib/session";
import { Loading } from "../components/ui";

/** The screens, with headers coloured from the theme. */
function Screens() {
  const { colors, dark } = useTheme();
  const session = useSession();
  if (session.status === "loading") return <Loading />;
  const signedIn = session.status === "signedIn";
  return (
    <>
      <StatusBar style={dark ? "light" : "dark"} />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: colors.bg } }}>
        <Stack.Protected guard={!signedIn}>
          <Stack.Screen name="sign-in" options={{ headerShown: false }} />
        </Stack.Protected>
        <Stack.Protected guard={signedIn}>
          <Stack.Screen name="(app)" options={{ headerShown: false }} />
        </Stack.Protected>
      </Stack>
    </>
  );
}

/** Root component: providers around the screens. */
export default function RootLayout() {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <SessionProvider>
          <Screens />
        </SessionProvider>
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
