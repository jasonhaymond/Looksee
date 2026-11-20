// More tab: every other management area, grouped like the dashboard's menu,
// plus this app's Settings (notifications, theme, sign out) and Help.

import { router, type Href } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../../lib/theme";
import { useSession } from "../../../lib/session";
import { Card, Row, Screen, T } from "../../../components/ui";

type Item = { label: string; sub: string; href: Href; icon: keyof typeof Ionicons.glyphMap };

const SECTIONS: { title: string; items: Item[] }[] = [
  {
    title: "Monitoring",
    items: [
      { label: "Groups", sub: "Sets of locations, sites, endpoints and checks", href: "/groups", icon: "albums-outline" },
      { label: "Maintenance windows", sub: "Planned quiet times, one-off or repeating", href: "/maintenance", icon: "construct-outline" },
      { label: "Exclusion lists", sub: "Items many checks ignore", href: "/exclusions", icon: "eye-off-outline" },
      { label: "Discovery", sub: "Scan a network and add what's found", href: "/discovery", icon: "search-outline" },
      { label: "SNMP templates", sub: "Ready-made checks for network devices", href: "/snmp-templates", icon: "hardware-chip-outline" },
    ],
  },
  {
    title: "Notifications",
    items: [
      { label: "Channels", sub: "Email, chat, webhooks, this app…", href: "/channels", icon: "megaphone-outline" },
      { label: "Status pages", sub: "Public uptime pages", href: "/status-pages", icon: "globe-outline" },
    ],
  },
  {
    title: "Insights",
    items: [
      { label: "SLA reports", sub: "Uptime per check over a period", href: "/reports", icon: "stats-chart-outline" },
      { label: "Events", sub: "Syslog messages and SNMP traps received", href: "/events", icon: "list-outline" },
      { label: "Top talkers", sub: "Network flows (NetFlow/sFlow)", href: "/flows", icon: "swap-horizontal-outline" },
    ],
  },
  {
    title: "System",
    items: [
      { label: "Security", sub: "Sessions, phones, IP access, security log", href: "/security", icon: "shield-checkmark-outline" },
      { label: "Engine log", sub: "What the server has been doing", href: "/logs", icon: "document-text-outline" },
      { label: "Backups", sub: "Back up now, archives, restore", href: "/backups", icon: "archive-outline" },
      { label: "Data retention", sub: "How long data is kept; disk space", href: "/retention", icon: "server-outline" },
      { label: "Outbound watchdog", sub: "Pings an outside monitor while Looksee is healthy", href: "/watchdog", icon: "heart-outline" },
      { label: "Email server (SMTP)", sub: "How Looksee sends email", href: "/smtp", icon: "mail-outline" },
    ],
  },
  {
    title: "This app",
    items: [
      { label: "Settings", sub: "Notifications on this phone, theme, sign out", href: "/settings", icon: "settings-outline" },
      { label: "Help", sub: "Looksee's guides", href: "/help", icon: "help-circle-outline" },
    ],
  },
];

export default function More() {
  const { colors } = useTheme();
  const session = useSession();
  return (
    <Screen>
      {SECTIONS.map((s) => (
        <Card key={s.title} title={s.title}>
          {s.items.map((i) => (
            <Row key={i.label} left={<Ionicons name={i.icon} size={20} color={colors.muted} />} title={i.label} subtitle={i.sub} onPress={() => router.push(i.href)} />
          ))}
        </Card>
      ))}
      <T size="s" muted style={{ textAlign: "center" }}>Signed in as {session.email} on {session.serverUrl}</T>
    </Screen>
  );
}
