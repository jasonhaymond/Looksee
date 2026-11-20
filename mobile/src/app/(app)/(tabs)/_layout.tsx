// The bottom tab bar: Overview, Alerts, Browse (locations/sites/endpoints),
// Checks, and More (every other management area and Settings).

import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../../lib/theme";

/** One tab's icon, coloured by whether it's the current tab. */
const icon = (name: keyof typeof Ionicons.glyphMap) => ({ color, size }: { color: unknown; size: number }) => <Ionicons name={name} color={typeof color === "string" ? color : undefined} size={size} />;

export default function TabsLayout() {
  const { colors } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerStyle: { backgroundColor: colors.panel },
        headerTintColor: colors.text,
        tabBarStyle: { backgroundColor: colors.panel, borderTopColor: colors.border },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.muted,
        sceneStyle: { backgroundColor: colors.bg },
      }}
    >
      <Tabs.Screen name="index" options={{ title: "Overview", tabBarIcon: icon("pulse") }} />
      <Tabs.Screen name="alerts" options={{ title: "Alerts", tabBarIcon: icon("notifications-outline") }} />
      <Tabs.Screen name="browse" options={{ title: "Browse", tabBarIcon: icon("git-network-outline") }} />
      <Tabs.Screen name="checks" options={{ title: "Checks", tabBarIcon: icon("checkmark-done-outline") }} />
      <Tabs.Screen name="more" options={{ title: "More", tabBarIcon: icon("menu") }} />
    </Tabs>
  );
}
