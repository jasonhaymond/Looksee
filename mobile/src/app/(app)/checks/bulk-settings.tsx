// Edit the settings of one kind of check on many endpoints at once, the app
// version of the dashboard's "Edit settings…" dialog. For each setting: keep
// it as it is on each check, set it to one value everywhere, or clear it.
// Exclusions are edited item by item: tick items to remove them from every
// check, and add new items to every check, without overwriting each check's
// other items. Sent to the engine as one bulk "edit_settings" request; checks
// of another type are skipped.
//
// Params: ids (comma-separated check IDs, the starting selection).

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, TYPE_BY_KEY, own, typeLabel, type Check, type Field as FieldDef } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { useTheme } from "../../../lib/theme";
import { Button, ButtonRow, Card, Chip, Chips, ErrorBox, Field, Loading, Screen, Select, T, tell } from "../../../components/ui";
import { SettingInput } from "../../../components/CheckFields";

type Mode = "keep" | "set" | "clear";
const MASK = "••••••••";

/** The settings offered for a type: its own fields (not exclusions, edited separately) plus thresholds and timing. */
function settingsFor(type: string): FieldDef[] {
  const def = TYPE_BY_KEY.get(type);
  if (!def) return [];
  const own = def.fields.filter((f) => f.kind !== "metric" && f.key !== "exclude");
  const extra: FieldDef[] = [];
  if (def.value) extra.push(...(["warnAbove", "criticalAbove", "warnBelow", "criticalBelow"] as const).map((key) => ({ key, label: key.replace(/([A-Z])/g, " $1").toLowerCase(), kind: "number" as const })));
  if (def.latency) extra.push({ key: "latencyWarnMs", label: "Warn if slower than (ms)", kind: "number" }, { key: "latencyCriticalMs", label: "Critical if slower than (ms)", kind: "number" });
  extra.push({ key: "timeoutsBeforeDown", label: "Timeouts in a row before down", kind: "number" });
  return [...own, ...extra, { key: "intervalSeconds", label: "Check every (seconds)", kind: "number" }, { key: "retryIntervalSeconds", label: "Retry every (seconds) while failing", kind: "number" }];
}

/** What a setting is on each target now: "60 on 3 · 300 on 1". */
function summarize(key: string, targets: Check[]): string {
  const counts = new Map<string, number>();
  for (const c of targets) {
    const raw = key === "intervalSeconds" ? c.intervalSeconds : key === "retryIntervalSeconds" ? c.retryIntervalSeconds : own(c.config, key);
    const v = raw == null || raw === "" ? "not set" : String(raw) === MASK ? "saved secret" : String(raw);
    counts.set(v, (counts.get(v) ?? 0) + 1);
  }
  return [...counts.entries()].map(([v, n]) => `${v.length > 30 ? `${v.slice(0, 30)}…` : v} on ${n}`).join(" · ");
}

/** A check's own exclusion items, split the way the engine reads them (one per line). */
const itemsOf = (c: Check) => String(c.config.exclude ?? "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

export default function BulkSettings() {
  const { colors } = useTheme();
  const { ids } = useLocalSearchParams<{ ids?: string }>();
  const load = useCallback(() => api.checks(), []);
  const { data, error, loading } = useLoad(load);
  const start = (ids ?? "").split(",").filter(Boolean);
  const startTypes = [...new Set((data ?? []).filter((c) => start.includes(c.id)).map((c) => c.type))];
  const [chosenType, setType] = useState<string | null>(null);
  const type = chosenType ?? startTypes[0] ?? "";
  const [extra, setExtra] = useState<string[] | null>(null);
  const [modes, setModes] = useState<Record<string, Mode>>({});
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [remove, setRemove] = useState<string[]>([]);
  const [add, setAdd] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const sameType = (data ?? []).filter((c) => c.type === type);
  const targetIds = extra ?? start.filter((id) => sameType.some((c) => c.id === id));
  const targets = sameType.filter((c) => targetIds.includes(c.id));
  const fields = settingsFor(type);
  const hasExclude = Boolean(TYPE_BY_KEY.get(type)?.fields.some((f) => f.key === "exclude"));
  // Every exclusion item across the targets, with how many targets have it (case ignored).
  const union = (() => {
    const map = new Map<string, { item: string; n: number }>();
    for (const c of targets) for (const i of new Set(itemsOf(c).map((x) => x.toLowerCase()))) {
      const original = itemsOf(c).find((x) => x.toLowerCase() === i) ?? i;
      map.set(i, { item: map.get(i)?.item ?? original, n: (map.get(i)?.n ?? 0) + 1 });
    }
    return [...map.values()].sort((a, b) => b.n - a.n || a.item.localeCompare(b.item));
  })();

  /** Builds the request and applies it. */
  async function apply() {
    setErr(null);
    const set: Record<string, unknown> = {};
    const unset: string[] = [];
    let intervalSeconds: number | undefined;
    let retryIntervalSeconds: number | null | undefined;
    for (const f of fields) {
      const mode = modes[f.key] ?? "keep";
      if (mode === "keep") continue;
      if (f.key === "intervalSeconds") {
        if (mode === "set") intervalSeconds = Number(values[f.key]);
        continue;
      }
      if (f.key === "retryIntervalSeconds") {
        retryIntervalSeconds = mode === "set" ? Number(values[f.key]) || null : null;
        continue;
      }
      if (mode === "clear") {
        unset.push(f.key);
        continue;
      }
      // Converted here rather than with the registry's normalizeConfig, which
      // drops settings whose show-condition depends on other settings (not
      // part of this edit). Numbers must be numbers; an empty value is refused
      // rather than silently treated as "clear".
      const raw = values[f.key];
      if (f.kind === "checkbox") set[f.key] = raw === true;
      else if (raw == null || String(raw).trim() === "") return setErr(`Enter a value for "${f.label}", or choose Keep or Clear.`);
      else if (f.kind === "number") {
        const n = Number(raw);
        if (!Number.isFinite(n)) return setErr(`"${f.label}" must be a number.`);
        set[f.key] = n;
      } else set[f.key] = typeof raw === "string" && f.kind !== "textarea" ? raw.trim() : raw;
    }
    const cleaned = set;
    if (intervalSeconds !== undefined && !(intervalSeconds >= 5)) return setErr("Check every must be at least 5 seconds.");
    const excludeAdd = add.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    const params = {
      type,
      ...(Object.keys(cleaned).length ? { set: cleaned } : {}),
      ...(unset.length ? { unset } : {}),
      ...(excludeAdd.length ? { excludeAdd } : {}),
      ...(remove.length ? { excludeRemove: remove } : {}),
      ...(intervalSeconds !== undefined ? { intervalSeconds } : {}),
      ...(retryIntervalSeconds !== undefined ? { retryIntervalSeconds } : {}),
    };
    if (Object.keys(params).length === 1) return setErr("Nothing to change: set or clear a setting, or add/remove an exclusion.");
    setBusy(true);
    try {
      const r = await api.bulkChecks(targetIds, "edit_settings", params);
      tell(`Changed ${r.affected} check${r.affected === 1 ? "" : "s"}`, r.errors.length ? `${r.errors.length} skipped: ${r.errors[0].error}` : undefined);
      router.back();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: "Edit settings on many" }} />
      <ErrorBox error={error} />
      {startTypes.length > 1 ? (
        <Select label="Kind of check" value={type} onChange={(t) => { setType(t); setExtra(null); setModes({}); setRemove([]); }} options={startTypes.map((t) => ({ value: t, label: typeLabel(t), sub: `${(data ?? []).filter((c) => c.type === t && start.includes(c.id)).length} selected` }))} help="Settings belong to a kind of check; the others in the selection are left alone." />
      ) : null}
      <Card title={`${targets.length} ${typeLabel(type)} check${targets.length === 1 ? "" : "s"}`}>
        <Select multi label="Apply to" value={targetIds} onChange={setExtra} options={sameType.map((c) => ({ value: c.id, label: c.name }))} />
      </Card>
      {hasExclude ? (
        <Card title="Exclusions">
          {union.length ? <T size="s" muted>Tick items to remove them from every chosen check.</T> : <T size="s" muted>None of these checks excludes anything yet.</T>}
          <Chips>
            {union.map((u) => (
              <Chip key={u.item} label={`${remove.includes(u.item) ? "✕ " : ""}${u.item} (${u.n} of ${targets.length})`} on={remove.includes(u.item)} onPress={() => setRemove((r) => (r.includes(u.item) ? r.filter((x) => x !== u.item) : [...r, u.item]))} />
            ))}
          </Chips>
          <Field label="Add to every chosen check" value={add} onChangeText={setAdd} multiline autoCapitalize="none" placeholder="One per line" />
        </Card>
      ) : null}
      <Card title="Settings">
        {fields.map((f) => {
          const mode = modes[f.key] ?? "keep";
          const setMode = (m: Mode) => setModes((s) => ({ ...s, [f.key]: m }));
          return (
            <View key={f.key} style={{ gap: 6, borderTopColor: colors.border, borderTopWidth: 1, paddingTop: 8 }}>
              <T bold>{f.label}</T>
              <T size="s" muted>Now: {summarize(f.key, targets)}</T>
              <Chips>
                <Chip label="Keep" on={mode === "keep"} onPress={() => setMode("keep")} />
                {f.kind === "checkbox" ? (
                  <>
                    <Chip label="On" on={mode === "set" && values[f.key] === true} onPress={() => { setMode("set"); setValues((v) => ({ ...v, [f.key]: true })); }} />
                    <Chip label="Off" on={mode === "set" && values[f.key] === false} onPress={() => { setMode("set"); setValues((v) => ({ ...v, [f.key]: false })); }} />
                  </>
                ) : (
                  <Chip label="Set" on={mode === "set"} onPress={() => setMode("set")} />
                )}
                {f.key !== "intervalSeconds" ? <Chip label="Clear" on={mode === "clear"} onPress={() => setMode("clear")} /> : null}
              </Chips>
              {mode === "set" && f.kind !== "checkbox" ? <SettingInput field={{ ...f, label: "New value", help: undefined }} value={values[f.key]} onChange={(v) => setValues((s) => ({ ...s, [f.key]: v }))} checks={data ?? []} /> : null}
            </View>
          );
        })}
      </Card>
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={`Apply to ${targets.length}`} variant="primary" busy={busy} disabled={!targets.length} onPress={apply} />
      </ButtonRow>
    </Screen>
  );
}
