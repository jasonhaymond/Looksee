// Data retention: how many days each kind of data is kept (check results,
// metrics, events, flows, logs…), the disk-space guard that rolls over the
// oldest data early when the disk runs low, and the disk and database sizes.
// The guard never touches the newest data (the "always keep" hours) or the
// security audit log. The engine checks every value on save.

import { useCallback, useState } from "react";
import { Stack } from "expo-router";
import { api, type RetentionStatus } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { bytes, dateTime, errorText } from "../../lib/format";
import { Button, ButtonRow, Card, Chip, Chips, ErrorBox, Field, KeyValue, Loading, Note, Screen, T, Toggle, tell } from "../../components/ui";

type Draft = { rolloverEnabled: boolean; minFreeMode: string; minFreeGb: string; minFreePercent: string; minKeepHours: string; days: Record<string, string> };

const toDraft = (s: RetentionStatus): Draft => ({
  rolloverEnabled: s.rolloverEnabled,
  minFreeMode: s.minFreeMode,
  minFreeGb: String(s.minFreeGb),
  minFreePercent: String(s.minFreePercent),
  minKeepHours: String(s.minKeepHours),
  days: Object.fromEntries(s.kinds.map((k) => [k.key, k.saved != null ? String(k.saved) : ""])),
});

export default function Retention() {
  const load = useCallback(() => api.retention(), []);
  const { data, error, loading, refreshing, reload, setData } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form status={data} error={error} refreshing={refreshing} reload={reload} onSaved={setData} />;
}

/** The form, created once the status has loaded (its starting values come from it). */
function Form({ status: s, error, refreshing, reload, onSaved }: { status: RetentionStatus; error: string | null; refreshing: boolean; reload: () => Promise<void>; onSaved: (s: RetentionStatus) => void }) {
  const [draft, setDraft] = useState<Draft>(() => toDraft(s));
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const saved = await api.saveRetention({
        rolloverEnabled: draft.rolloverEnabled,
        minFreeMode: draft.minFreeMode,
        minFreeGb: Number(draft.minFreeGb),
        minFreePercent: Number(draft.minFreePercent),
        minKeepHours: Number(draft.minKeepHours),
        storagePath: s.storagePath,
        days: Object.fromEntries(Object.entries(draft.days).map(([k, v]) => [k, v.trim() === "" ? null : Number(v)])),
      });
      onSaved(saved);
      setDraft(toDraft(saved));
      tell("Saved");
    } catch (err) {
      tell("Not saved", errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Data retention" }} />
      <ErrorBox error={error} />
      <Card title="Disk">
        {s.disk ? <KeyValue label="Free" value={`${bytes(s.disk.freeBytes)} of ${bytes(s.disk.totalBytes)}`} /> : <Note tone="warn">{s.diskError ?? "Disk size unknown."}</Note>}
        <KeyValue label="Database" value={`${bytes(s.databaseBytes)} (${bytes(s.reusableBytes)} reusable)`} />
        <KeyValue label="Measured at" value={s.effectivePath} mono />
        {s.lastRolloverAt ? <KeyValue label="Last rollover" value={`${dateTime(s.lastRolloverAt)}: ${s.lastRolloverMessage ?? ""}`} /> : null}
      </Card>
      <Card title="Disk-space guard">
        <Toggle label="Roll over old data early when space runs low" value={draft.rolloverEnabled} onChange={(v) => setDraft({ ...draft, rolloverEnabled: v })} />
        <Chips>
          <Chip label="Keep GB free" on={draft.minFreeMode === "gb"} onPress={() => setDraft({ ...draft, minFreeMode: "gb" })} />
          <Chip label="Keep % free" on={draft.minFreeMode === "percent"} onPress={() => setDraft({ ...draft, minFreeMode: "percent" })} />
        </Chips>
        {draft.minFreeMode === "gb" ? <Field label="Keep free (GB)" value={draft.minFreeGb} onChangeText={(t) => setDraft({ ...draft, minFreeGb: t })} keyboardType="decimal-pad" /> : <Field label="Keep free (%)" value={draft.minFreePercent} onChangeText={(t) => setDraft({ ...draft, minFreePercent: t })} keyboardType="decimal-pad" />}
        <Field label="Always keep the newest (hours)" value={draft.minKeepHours} onChangeText={(t) => setDraft({ ...draft, minKeepHours: t })} keyboardType="number-pad" help="Never rolled over, whatever the disk says." />
      </Card>
      <Card title="Keep for (days)">
        {s.kinds.map((k) => (
          <Field key={k.key} label={`${k.label} · ${bytes(k.bytes)}${k.oldest ? ` · oldest ${dateTime(k.oldest)}` : ""}`} value={draft.days[k.key] ?? ""} onChangeText={(t) => setDraft({ ...draft, days: { ...draft.days, [k.key]: t } })} keyboardType="number-pad" placeholder={`${k.defaultDays} (default)`} help={`${k.help} Minimum ${k.minDays}.`} />
        ))}
      </Card>
      <ButtonRow>
        <Button title="Run cleanup now" onPress={async () => {
          try {
            const r = await api.runRetention();
            onSaved(r.status);
            tell("Cleanup", r.outcome.message);
          } catch (err) {
            tell("That didn't work", errorText(err));
          }
        }} />
        <Button title="Save" variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
      <T size="s" muted>Blank = the default period.</T>
    </Screen>
  );
}
