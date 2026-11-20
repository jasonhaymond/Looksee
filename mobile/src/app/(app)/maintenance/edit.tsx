// Create or edit a maintenance window: what it covers (everything, or chosen
// sites / endpoints / checks / groups), and when: once (from–to, or "now for
// N minutes") or repeating (daily, weekly on chosen days, monthly on a day or
// on e.g. the 2nd Tuesday, every N, optionally between two dates). Times are
// in this phone's time zone, which is saved with the window.
// Params: id (edit), or nothing (create).

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type MaintenanceWindow } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, Chip, Chips, ErrorBox, Field, Loading, Screen, Select, T } from "../../../components/ui";

type Scope = MaintenanceWindow["scope"];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** "2026-11-20 14:30" for an ISO time, in the phone's own zone (blank for none). */
function localText(iso: string | null | undefined) {
  if (!iso) return "";
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Reads "YYYY-MM-DD HH:MM" (phone's local time) back to an instant; null if it isn't one. */
function parseLocal(text: string): Date | null {
  const m = text.trim().match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

export default function MaintenanceEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const load = useCallback(async () => {
    const [windows, sites, endpoints, checks, groups] = await Promise.all([api.maintenance(), api.sites(), api.endpoints(), api.checks(), api.groups()]);
    return { window: windows.find((w) => w.id === id) ?? null, sites, endpoints, checks, groups };
  }, [id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form {...data} />;
}

function Form({ window: w, sites, endpoints, checks, groups }: { window: MaintenanceWindow | null; sites: { id: string; name: string }[]; endpoints: { id: string; name: string }[]; checks: { id: string; name: string }[]; groups: { id: string; name: string }[] }) {
  const repeatingAtStart = Boolean(w && !w.startsAt);
  const [name, setName] = useState(w?.name ?? "");
  const [scope, setScope] = useState<Scope>(w?.scope ?? "all");
  const [targets, setTargets] = useState<string[]>(w?.targetIds ?? []);
  const [kind, setKind] = useState<"once" | "repeat">(repeatingAtStart ? "repeat" : "once");
  // Lazy initial values (functions): the current time is read once, not on every render.
  const [from, setFrom] = useState(() => localText(w?.startsAt ?? new Date().toISOString()));
  const [to, setTo] = useState(() => localText(w?.endsAt ?? new Date(Date.now() + 3_600_000).toISOString()));
  const [recurrence, setRecurrence] = useState<NonNullable<MaintenanceWindow["recurrence"]>>(w?.recurrence ?? "weekly");
  const [days, setDays] = useState<number[]>(w?.daysOfWeek ?? []);
  const [dayOfMonth, setDayOfMonth] = useState(w?.dayOfMonth != null ? String(w.dayOfMonth) : "1");
  const [weekOfMonth, setWeekOfMonth] = useState(w?.weekOfMonth != null ? String(w.weekOfMonth) : "1");
  const [startTime, setStartTime] = useState(w?.startTime ?? "02:00");
  const [duration, setDuration] = useState(String(w?.durationMinutes ?? 60));
  const [every, setEvery] = useState(String(w?.repeatEvery ?? 1));
  const [startDate, setStartDate] = useState(w?.startDate ?? "");
  const [endDate, setEndDate] = useState(w?.endDate ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const targetOptions = (scope === "site" ? sites : scope === "endpoint" ? endpoints : scope === "check" ? checks : scope === "group" ? groups : []).map((x) => ({ value: x.id, label: x.name }));

  async function save() {
    setErr(null);
    const base = { name: name.trim(), scope, targetIds: scope === "all" ? [] : targets, timeZone: zone, enabled: w?.enabled ?? true };
    let input: Partial<MaintenanceWindow>;
    if (kind === "once") {
      const a = parseLocal(from);
      const b = parseLocal(to);
      if (!a || !b) return setErr("Write the times as YYYY-MM-DD HH:MM, e.g. 2026-11-20 22:00.");
      input = { ...base, startsAt: a.toISOString(), endsAt: b.toISOString(), recurrence: null, daysOfWeek: null };
    } else {
      if (!/^\d{1,2}:\d{2}$/.test(startTime.trim())) return setErr("Start time is HH:MM, e.g. 02:00.");
      input = {
        ...base,
        startsAt: null,
        endsAt: null,
        recurrence,
        daysOfWeek: recurrence === "weekly" || recurrence === "monthly_weekday" ? days : null,
        dayOfMonth: recurrence === "monthly_day" ? Number(dayOfMonth) : null,
        weekOfMonth: recurrence === "monthly_weekday" ? Number(weekOfMonth) : null,
        startTime: startTime.trim().padStart(5, "0"),
        durationMinutes: Number(duration),
        repeatEvery: Math.max(1, Number(every) || 1),
        startDate: startDate.trim() || null,
        endDate: endDate.trim() || null,
      };
    }
    setBusy(true);
    try {
      if (w) await api.updateMaintenance(w.id, input);
      else await api.createMaintenance(input);
      router.back();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: w ? `Edit: ${w.name}` : "New maintenance window" }} />
      <Card>
        <Field label="Name *" value={name} onChangeText={setName} placeholder="Patch Tuesday" />
        <Select label="Applies to" value={scope} onChange={(v) => { setScope(v as Scope); setTargets([]); }} options={[{ value: "all", label: "Everything" }, { value: "site", label: "Chosen sites" }, { value: "endpoint", label: "Chosen endpoints" }, { value: "check", label: "Chosen checks" }, { value: "group", label: "Chosen groups" }]} />
        {scope !== "all" ? <Select multi label={`Which ${scope}s`} value={targets} onChange={setTargets} options={targetOptions} /> : null}
      </Card>
      <Card title="When">
        <Chips>
          <Chip label="Once" on={kind === "once"} onPress={() => setKind("once")} />
          <Chip label="Repeating" on={kind === "repeat"} onPress={() => setKind("repeat")} />
        </Chips>
        {kind === "once" ? (
          <>
            <Field label="From (YYYY-MM-DD HH:MM)" value={from} onChangeText={setFrom} />
            <Field label="To" value={to} onChangeText={setTo} />
            <Chips>
              {[30, 60, 120, 240].map((m) => <Chip key={m} label={`Now for ${m < 60 ? `${m} min` : `${m / 60} h`}`} on={false} onPress={() => { setFrom(localText(new Date().toISOString())); setTo(localText(new Date(Date.now() + m * 60_000).toISOString())); }} />)}
            </Chips>
          </>
        ) : (
          <>
            <Select label="Repeats" value={recurrence} onChange={(v) => setRecurrence(v as typeof recurrence)} options={[{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "monthly_day", label: "Monthly on a day" }, { value: "monthly_weekday", label: "Monthly on a weekday (e.g. 2nd Tuesday)" }]} />
            {recurrence === "weekly" || recurrence === "monthly_weekday" ? (
              <Chips>
                {DAYS.map((d, i) => <Chip key={d} label={d} on={days.includes(i)} onPress={() => setDays((x) => (x.includes(i) ? x.filter((y) => y !== i) : [...x, i].sort()))} />)}
              </Chips>
            ) : null}
            {recurrence === "monthly_day" ? <Field label="Day of the month (1–31, or -1 for the last)" value={dayOfMonth} onChangeText={setDayOfMonth} keyboardType="numbers-and-punctuation" /> : null}
            {recurrence === "monthly_weekday" ? <Select label="Which week" value={weekOfMonth} onChange={setWeekOfMonth} options={[{ value: "1", label: "1st" }, { value: "2", label: "2nd" }, { value: "3", label: "3rd" }, { value: "4", label: "4th" }, { value: "-1", label: "Last" }]} /> : null}
            <Field label="Start time (HH:MM)" value={startTime} onChangeText={setStartTime} keyboardType="numbers-and-punctuation" />
            <Field label="Lasts (minutes)" value={duration} onChangeText={setDuration} keyboardType="number-pad" />
            <Field label="Every N (1 = every time)" value={every} onChangeText={setEvery} keyboardType="number-pad" />
            <Field label="Starting on (YYYY-MM-DD, optional)" value={startDate} onChangeText={setStartDate} help="Needed when repeating every 2 or more." />
            <Field label="Until (YYYY-MM-DD, optional)" value={endDate} onChangeText={setEndDate} />
          </>
        )}
        <T size="s" muted>Times are in this phone's time zone ({zone}).</T>
      </Card>
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={w ? "Save" : "Create window"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
