// Received events: syslog messages and SNMP traps sent to Looksee (or its site
// collectors), newest first, filterable by source, severity, site and text.

import { useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { Stack } from "expo-router";
import { api, type EventRow } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { dateTime } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import { Chip, Chips, Empty, ErrorBox, Field, Loading, Row, Select, T } from "../../components/ui";

// Syslog severities 0–7 (0 = emergency … 7 = debug).
const SEVERITY = ["emergency", "alert", "critical", "error", "warning", "notice", "info", "debug"];

export default function Events() {
  const { colors } = useTheme();
  const [source, setSource] = useState("");
  const [maxSeverity, setMax] = useState("");
  const [site, setSite] = useState("");
  const [q, setQ] = useState("");
  const load = useCallback(async () => {
    const [events, sites] = await Promise.all([api.events({ source: source || undefined, maxSeverity: maxSeverity || undefined, site: site || undefined, q: q.trim() || undefined, limit: 300 }), api.sites()]);
    return { events, sites };
  }, [source, maxSeverity, site, q]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: "Events" }} />
      <View style={{ padding: 16, paddingBottom: 4, gap: 8 }}>
        <Chips>
          <Chip label="All" on={!source} onPress={() => setSource("")} />
          <Chip label="Syslog" on={source === "syslog"} onPress={() => setSource("syslog")} />
          <Chip label="SNMP traps" on={source === "snmp_trap"} onPress={() => setSource("snmp_trap")} />
        </Chips>
        <View style={{ flexDirection: "row", gap: 8 }}>
          <View style={{ flex: 1 }}>
            <Select label="Severity" value={maxSeverity} onChange={setMax} options={[{ value: "", label: "Any" }, ...SEVERITY.slice(0, 7).map((s, i) => ({ value: String(i), label: `${s} or worse` }))]} />
          </View>
          <View style={{ flex: 1 }}>
            <Select label="Site" value={site} onChange={setSite} options={[{ value: "", label: "All" }, ...(data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))]} />
          </View>
        </View>
        <Field label="Search" value={q} onChangeText={setQ} autoCapitalize="none" placeholder="Text or address" />
        <ErrorBox error={error} />
      </View>
      {loading ? <Loading /> : (
        <FlatList<EventRow>
          data={data?.events ?? []}
          keyExtractor={(e) => e.id}
          refreshing={refreshing}
          onRefresh={reload}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          renderItem={({ item }) => (
            <Row
              title={<T size="s" selectable>{item.message}</T>}
              subtitle={`${dateTime(item.receivedAt)} · ${item.source === "syslog" ? "syslog" : "trap"} from ${item.sourceIp}${item.severity != null ? ` · ${SEVERITY[item.severity] ?? item.severity}` : ""}`}
            />
          )}
          ListEmptyComponent={<Empty>No events match.</Empty>}
        />
      )}
    </View>
  );
}
