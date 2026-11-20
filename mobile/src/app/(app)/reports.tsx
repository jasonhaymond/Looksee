// SLA reports: time-weighted uptime per check over 1–365 days (maintenance
// excluded), worst first, against a target percentage, with totals.

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router } from "expo-router";
import { api } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { minutes } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import { Card, Chip, Chips, Empty, ErrorBox, Field, Loading, Row, Screen, Select, T } from "../../components/ui";

export default function Reports() {
  const { colors } = useTheme();
  const [days, setDays] = useState(30);
  const [siteId, setSiteId] = useState("");
  const [target, setTarget] = useState("99.9");
  const load = useCallback(async () => {
    const [report, sites] = await Promise.all([api.slaReport(days, siteId || undefined), api.sites()]);
    return { rows: report.checks, sites };
  }, [days, siteId]);
  const { data, error, loading, refreshing, reload } = useLoad(load);
  const goal = Number(target);
  const rows = [...(data?.rows ?? [])].sort((a, b) => (a.uptimePercent ?? 101) - (b.uptimePercent ?? 101));
  const measured = rows.filter((r) => r.uptimePercent != null);
  const avg = measured.length ? measured.reduce((a, r) => a + (r.uptimePercent ?? 0), 0) / measured.length : null;

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "SLA reports" }} />
      <Chips>
        {[1, 7, 30, 90, 365].map((d) => <Chip key={d} label={`${d} d`} on={days === d} onPress={() => setDays(d)} />)}
      </Chips>
      <View style={{ flexDirection: "row", gap: 8 }}>
        <View style={{ flex: 2 }}>
          <Select label="Site" value={siteId} onChange={setSiteId} options={[{ value: "", label: "All" }, ...(data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
        </View>
        <View style={{ flex: 1 }}>
          <Field label="Target %" value={target} onChangeText={setTarget} keyboardType="decimal-pad" />
        </View>
      </View>
      <ErrorBox error={error} />
      {loading ? <Loading /> : (
        <>
          <Card>
            <T>Average uptime: <T bold>{avg != null ? `${avg.toFixed(3)}%` : "—"}</T></T>
            <T>Below {target}%: <T bold>{measured.filter((r) => (r.uptimePercent ?? 100) < goal).length}</T> · Incidents: <T bold>{rows.reduce((a, r) => a + r.incidents, 0)}</T> · Downtime: <T bold>{minutes(rows.reduce((a, r) => a + r.downtimeMinutes, 0))}</T></T>
          </Card>
          <Card>
            {rows.length === 0 ? <Empty>No results recorded in this period.</Empty> : rows.map((r) => {
              const below = r.uptimePercent != null && r.uptimePercent < goal;
              return (
                <Row
                  key={r.checkId}
                  title={r.name}
                  subtitle={`down ${minutes(r.downtimeMinutes)} · degraded ${minutes(r.degradedMinutes)} · ${r.incidents} incident(s)${r.avgLatencyMs != null ? ` · avg ${r.avgLatencyMs} ms` : ""}`}
                  right={<T bold color={below ? colors.down : colors.text}>{r.uptimePercent != null ? `${r.uptimePercent.toFixed(3)}%` : "—"}{below ? "\nbelow" : ""}</T>}
                  onPress={() => router.push(`/checks/${r.checkId}`)}
                />
              );
            })}
          </Card>
        </>
      )}
    </Screen>
  );
}
