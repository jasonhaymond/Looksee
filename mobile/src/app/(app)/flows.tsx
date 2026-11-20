// Top talkers: who used the most network traffic over the last minutes/hours,
// from NetFlow/sFlow records exporters send to Looksee, grouped by source,
// destination, conversation (source → destination) or service (protocol/port).

import { useCallback, useState } from "react";
import { Stack } from "expo-router";
import { api } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { bytes } from "../../lib/format";
import { Card, Chip, Chips, Empty, ErrorBox, Loading, Row, Screen, Select, T } from "../../components/ui";

// How traffic is grouped (the engine's "by" values).
const BY = [
  { value: "pair", label: "Conversations" },
  { value: "src", label: "Sources" },
  { value: "dst", label: "Destinations" },
  { value: "port", label: "Services (protocol/port)" },
];

export default function Flows() {
  const [minutes, setMinutes] = useState(60);
  const [by, setBy] = useState("pair");
  const [exporter, setExporter] = useState("");
  const load = useCallback(async () => {
    const [rows, exporters] = await Promise.all([api.topFlows({ minutes, by, exporter: exporter || undefined, limit: 50 }), api.flowExporters()]);
    return { rows, exporters };
  }, [minutes, by, exporter]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 60);
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Top talkers" }} />
      <Chips>
        {[15, 60, 360, 1440].map((m) => <Chip key={m} label={m < 60 ? `${m} min` : `${m / 60} h`} on={minutes === m} onPress={() => setMinutes(m)} />)}
      </Chips>
      <Chips>
        {BY.map((b) => <Chip key={b.value} label={b.label} on={by === b.value} onPress={() => setBy(b.value)} />)}
      </Chips>
      <Select label="Exporter" value={exporter} onChange={setExporter} options={[{ value: "", label: "All" }, ...(data?.exporters ?? []).map((e) => ({ value: e.exporter, label: e.exporter }))]} />
      <ErrorBox error={error} />
      {loading ? <Loading /> : (
        <Card>
          {!data?.rows.length ? <Empty>No flow records in this period. Point a router's NetFlow/sFlow export at Looksee to see traffic here.</Empty> : data.rows.map((r) => (
            <Row key={r.label} title={r.label} right={<T size="s">{bytes(r.bytes)}{"\n"}{r.avgMbps.toFixed(2)} Mbps</T>} subtitle={`${r.packets.toLocaleString()} packets`} />
          ))}
        </Card>
      )}
    </Screen>
  );
}
