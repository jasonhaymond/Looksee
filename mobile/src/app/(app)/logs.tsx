// The engine log: what the Looksee server has been doing (checks, agents,
// alerts, backups, security), newest first, by minimum level. Each entry shows
// its plain-language summary; tap one for the technical detail.

import { useCallback, useState } from "react";
import { FlatList, View } from "react-native";
import { Stack } from "expo-router";
import { api, type LogEntry, type LogLevel } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { dateTime } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import { Chip, Chips, Empty, ErrorBox, Loading, Row, T } from "../../components/ui";

export default function Logs() {
  const { colors } = useTheme();
  const [level, setLevel] = useState<LogLevel>("info");
  const [open, setOpen] = useState<string | null>(null);
  const load = useCallback(() => api.logs({ level, limit: 300 }), [level]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);
  const color = (l: LogLevel) => (l === "error" ? colors.down : l === "warn" ? colors.warn : colors.muted);
  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <Stack.Screen options={{ title: "Engine log" }} />
      <View style={{ padding: 16, paddingBottom: 4, gap: 8 }}>
        <Chips>
          {(["debug", "info", "warn", "error"] as LogLevel[]).map((l) => <Chip key={l} label={`${l} and up`} on={level === l} onPress={() => setLevel(l)} />)}
        </Chips>
        <ErrorBox error={error} />
      </View>
      {loading ? <Loading /> : (
        <FlatList<LogEntry>
          data={data ?? []}
          keyExtractor={(e) => e.id}
          refreshing={refreshing}
          onRefresh={reload}
          contentContainerStyle={{ paddingHorizontal: 16, paddingBottom: 32 }}
          renderItem={({ item }) => (
            <Row
              left={<T size="s" bold color={color(item.level)} style={{ width: 44 }}>{item.level.toUpperCase()}</T>}
              title={<T size="s" selectable>{item.humanMessage ?? item.message}</T>}
              subtitle={open === item.id ? <T size="s" muted selectable style={{ fontFamily: "monospace" }}>{`${dateTime(item.createdAt)} · ${item.source}\n${item.message}${item.metadata ? `\n${JSON.stringify(item.metadata, null, 1)}` : ""}`}</T> : `${dateTime(item.createdAt)} · ${item.source}`}
              onPress={() => setOpen(open === item.id ? null : item.id)}
              right={<View />}
            />
          )}
          ListEmptyComponent={<Empty>Nothing logged at this level.</Empty>}
        />
      )}
    </View>
  );
}
