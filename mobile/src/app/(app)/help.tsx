// Help: Looksee's guides, opened in the phone's browser from your own Looksee
// server (the dashboard's Help pages, always matching the server's version).
// The browser may ask you to sign in to the dashboard the first time.

import { Linking } from "react-native";
import { Stack } from "expo-router";
import { useSession } from "../../lib/session";
import { Card, Row, Screen, T } from "../../components/ui";

// The dashboard's help pages (dashboard/app/help/docs.ts): address part and title.
const DOCS = [
  { slug: "#android-app", title: "Using the Android app", sub: "Notifications, battery settings, what works offline" },
  { slug: "", title: "User guide", sub: "Everything in Looksee, step by step" },
  { slug: "checks", title: "Check reference", sub: "What each check type does and its settings" },
  { slug: "check-settings", title: "Check settings", sub: "Thresholds, intervals, retries, dependencies" },
  { slug: "patching", title: "Patching updates & vulnerabilities", sub: "When Windows Update, macOS updates or apt don't fix them" },
  { slug: "security", title: "Security guide", sub: "Sign-in, IP access, attack detection" },
  { slug: "vpn", title: "VPN-only access", sub: "Reaching Looksee only over your VPN" },
  { slug: "windows-agent", title: "Windows agent & security software", sub: "Antivirus and EDR exclusions" },
];

export default function Help() {
  const { serverUrl } = useSession();
  return (
    <Screen>
      <Stack.Screen options={{ title: "Help" }} />
      <Card>
        {DOCS.map((d) => (
          <Row key={d.title} title={d.title} subtitle={d.sub} onPress={() => void Linking.openURL(`${serverUrl}/help${d.slug && !d.slug.startsWith("#") ? `/${d.slug}` : ""}${d.slug.startsWith("#") ? d.slug : ""}`)} />
        ))}
      </Card>
      <T size="s" muted>Guides open in your browser from {serverUrl}.</T>
    </Screen>
  );
}
