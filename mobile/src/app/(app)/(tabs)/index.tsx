// Overview tab: how many checks are up, warn, down; what's failing right now
// (worst first); open alerts and checks in maintenance; and a warning when
// this phone isn't receiving notifications. Refreshes every 30 seconds while
// shown, and on pull-down.

import { useCallback } from "react";
import { Pressable, View } from "react-native";
import { router } from "expo-router";
import * as Stream from "../../../../modules/looksee-stream";
import { api } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { statusColor, useTheme } from "../../../lib/theme";
import { Card, Empty, ErrorBox, Loading, Note, Row, Screen, T } from "../../../components/ui";
import { CheckRow } from "../../../components/CheckRow";
import { useStreamStatus } from "../../../lib/useStreamStatus";

const RANK: Record<string, number> = { down: 0, warn: 1, unknown: 2, up: 3 };

export default function Overview() {
  const { colors } = useTheme();
  const load = useCallback(async () => {
    const [checks, open, sites] = await Promise.all([api.checks(), api.alertEvents({ status: "open", limit: 200 }), api.sites()]);
    return { checks, open, siteName: new Map(sites.map((s) => [s.id, s.name])) };
  }, []);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);
  const stream = useStreamStatus();

  if (loading) return <Loading />;
  const enabled = (data?.checks ?? []).filter((c) => c.enabled);
  const count = (s: string) => enabled.filter((c) => (c.lastStatus ?? "unknown") === s).length;
  const failing = enabled.filter((c) => c.lastStatus === "down" || c.lastStatus === "warn").sort((a, b) => (RANK[a.lastStatus ?? "unknown"] ?? 9) - (RANK[b.lastStatus ?? "unknown"] ?? 9));
  const maint = enabled.filter((c) => c.inMaintenance).length;

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <ErrorBox error={error} />
      {Stream.isAvailable() && stream.state !== "connected" ? (
        <Pressable onPress={() => router.push("/settings")} accessibilityRole="button">
          <Note tone="warn">
            <T size="s">{!stream.enabled ? "This phone isn't receiving Looksee notifications." : stream.state === "waiting" ? `Notifications: can't reach the server (${stream.lastError ?? "retrying"}).` : "Notifications: connecting…"}</T>
            <T size="s" color={colors.accent} style={{ marginTop: 4 }}>Open notification settings →</T>
          </Note>
        </Pressable>
      ) : null}
      <View style={{ flexDirection: "row", gap: 8 }}>
        {(["up", "warn", "down", "unknown"] as const).map((s) => (
          <View key={s} style={{ flex: 1, backgroundColor: colors.panel, borderRadius: 10, padding: 10, borderColor: colors.border, borderWidth: 1 }}>
            <T size="xl" bold color={statusColor(colors, s)}>{count(s)}</T>
            <T size="s" muted>{s === "unknown" ? "not run" : s}</T>
          </View>
        ))}
      </View>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 1 }}>
          <Row title={`${data?.open.length ?? 0} open alert${data?.open.length === 1 ? "" : "s"}`} onPress={() => router.push("/alerts")} />
        </View>
        <View style={{ flex: 1 }}>
          <Row title={`${maint} in maintenance`} onPress={() => router.push("/maintenance")} />
        </View>
      </View>
      <Card title={failing.length ? `Failing now (${failing.length})` : "Failing now"}>
        {failing.length === 0 ? <Empty>Everything enabled is up.</Empty> : failing.map((c) => <CheckRow key={c.id} check={c} site={data?.siteName.get(c.siteId)} />)}
      </Card>
    </Screen>
  );
}
