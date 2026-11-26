// Alerts tab: alert incidents from the alert rules — open ones (still
// failing), resolved ones, or both — newest first, with a search. Tapping one
// opens its check. Refreshes every 15 seconds while shown, as soon as the
// app comes back to the foreground, and at once when a new alert arrives
// (lib/useLoad.ts).

import { useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { router } from "expo-router";
import { api, type AlertEvent } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { dateTime, minutes, relativeTime } from "../../../lib/format";
import { useTheme } from "../../../lib/theme";
import { Chip, Chips, Empty, ErrorBox, Field, Loading, Row, StatusBadge } from "../../../components/ui";

export default function Alerts() {
  const { colors } = useTheme();
  const [filter, setFilter] = useState<"open" | "resolved" | "all">("open");
  const [q, setQ] = useState("");
  const load = useCallback(() => api.alertEvents({ status: filter === "all" ? undefined : filter, q: q.trim() || undefined, limit: 200 }), [filter, q]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 15);

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <View style={{ padding: 16, paddingBottom: 4, gap: 8 }}>
        <Chips>
          <Chip label="Open" on={filter === "open"} onPress={() => setFilter("open")} />
          <Chip label="Resolved" on={filter === "resolved"} onPress={() => setFilter("resolved")} />
          <Chip label="All" on={filter === "all"} onPress={() => setFilter("all")} />
        </Chips>
        <Field label="Search" value={q} onChangeText={setQ} placeholder="Check name or message" autoCapitalize="none" />
        <ErrorBox error={error} />
      </View>
      {loading ? (
        <Loading />
      ) : (
        <FlatList
          data={data ?? []}
          keyExtractor={(e) => e.id}
          refreshing={refreshing}
          onRefresh={reload}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          renderItem={({ item }) => <AlertRow event={item} />}
          ListEmptyComponent={<Empty>{filter === "open" ? "No open alerts." : "No alerts."}</Empty>}
        />
      )}
    </View>
  );
}

/**
 * One incident: severity (or RESOLVED), check name, when it started (exact
 * time — and for an open one, how long ago), how long it lasted, and the
 * message. The time comes first so a long message can't push it out of the
 * two lines a row shows.
 */
function AlertRow({ event }: { event: AlertEvent }) {
  const open = event.status === "triggered";
  const length = event.durationMinutes ?? (event.resolvedAt ? (new Date(event.resolvedAt).getTime() - new Date(event.triggeredAt).getTime()) / 60_000 : null);
  const when = open ? `${dateTime(event.triggeredAt)} (${relativeTime(event.triggeredAt)})` : `${dateTime(event.triggeredAt)}, lasted ${minutes(length)}`;
  return (
    <Row
      left={<StatusBadge status={open ? (event.severity ?? "down") : "up"} small />}
      title={event.checkName}
      subtitle={[when, event.message].filter(Boolean).join(" · ")}
      onPress={event.checkId ? () => router.push(`/checks/${event.checkId}`) : undefined}
    />
  );
}
