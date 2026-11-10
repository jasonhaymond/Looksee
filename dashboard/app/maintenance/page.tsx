// The Maintenance page (/maintenance): lists maintenance windows, schedules
// new ones and edits existing ones.
//
// Where this sits: during a window, checks keep running and recording
// results, but no alerts go out and SLA reports skip that time. Windows are
// stored by the engine (engine/src/routes/maintenance.ts), which also decides
// when each is active and when it next starts
// (engine/src/services/maintenance.ts). Maintenance can also be started from
// multi-selections on the Checks, Endpoints and Sites pages, from a group and
// from a location; those windows show up here and can be edited like any other.
//
// Kinds of window: one time (a start and an end), or repeating — daily,
// weekly, monthly on a day of the month, or monthly on a weekday (e.g. the
// 2nd Tuesday) — optionally every N days/weeks/months and limited to a date
// range.
//
// Time zones: each window is entered either in this browser's time zone or
// in UTC. One-time windows are sent as exact instants, so they're right
// wherever the server is. Repeating windows are saved with their zone, so
// "02:00" means 02:00 in that zone whatever the server's clock is set to.
//
// "use client" makes this a React component that runs in the browser. Access
// is enforced by the engine (every maintenance route needs a session); the
// sign-in check here only decides whether to send you to the login page.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Check, type Site, type Endpoint, type Group, type MaintenanceWindow } from "../lib/api";
import { browserTimeZone, formatLocal, fromZonedInput, toZonedInput } from "../lib/localTime";
import { PageHelp } from "../components/PageHelp";
import { Button, EmptyState, Label, Modal, SortPicker, StatusBadge, inputClass, useToast } from "../components/ui";
import { useSort } from "../lib/useSort";

// Day names in JavaScript's numbering (0 = Sunday), as stored in daysOfWeek.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
// The repeat choices, in the order the dialog lists them.
type Kind = "once" | "daily" | "weekly" | "monthly_day" | "monthly_weekday";
const KINDS: [Kind, string][] = [
  ["once", "One time"],
  ["daily", "Every day"],
  ["weekly", "Every week"],
  ["monthly_day", "Every month, on a date (e.g. the 15th)"],
  ["monthly_weekday", "Every month, on a weekday (e.g. 2nd Tuesday)"],
];
// What "every N …" counts in, per repeat type.
const unitOf = (k: Kind) => (k === "daily" ? "days" : k === "weekly" ? "weeks" : "months");
// "1st" … "4th" for a week of the month, and -1 = "last".
const ordinal = (n: number) => (n === -1 ? "last" : dayLabel(n));
// A day of the month as "1st", "2nd", "23rd", "31st"; -1 = "last day".
const dayLabel = (n: number) => (n === -1 ? "last day" : `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`);

/**
 * A duration in minutes as words, e.g. 90 → "1 h 30 min", 2880 → "2 days".
 */
function duration(min: number) {
  if (min % 1440 === 0) return `${min / 1440} day${min === 1440 ? "" : "s"}`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return [h && `${h} h`, m && `${m} min`].filter(Boolean).join(" ");
}

/**
 * A one-line description of when a window runs. One-time windows are shown
 * in this browser's local time (and in UTC too, if they were entered in UTC).
 * A repeating window names its time zone only when it differs from yours
 * (or, for windows saved before zones were recorded, says it follows the
 * server's clock), so "at 02:00" is never ambiguous.
 *
 * @param w the window
 * @returns e.g. "Every 2 weeks on Tue, Thu at 02:00 (UTC) for 2 h, from 2026-11-10"
 */
function describe(w: MaintenanceWindow) {
  if (w.startsAt && w.endsAt) {
    const local = `${formatLocal(new Date(w.startsAt))} → ${formatLocal(new Date(w.endsAt))}`;
    return w.timeZone === "UTC" && browserTimeZone() !== "UTC" ? `${local} (entered as ${toZonedInput(new Date(w.startsAt), "UTC").replace("T", " ")} → ${toZonedInput(new Date(w.endsAt), "UTC").replace("T", " ")} UTC)` : local;
  }
  const rec = w.recurrence ?? (w.daysOfWeek?.length ? "weekly" : null);
  if (!rec) return "—";
  const every = w.repeatEvery ?? 1;
  const days = (w.daysOfWeek ?? []).map((d) => DAYS.at(d)).join(", ");
  const when =
    rec === "daily"
      ? every > 1 ? `Every ${every} days` : "Every day"
      : rec === "weekly"
        ? `Every ${every > 1 ? `${every} weeks` : "week"} on ${days}`
        : rec === "monthly_day"
          ? `On the ${dayLabel(w.dayOfMonth ?? 1)} of every ${every > 1 ? `${every} months` : "month"}`
          : `On the ${ordinal(w.weekOfMonth ?? 1)} ${days} of every ${every > 1 ? `${every} months` : "month"}`;
  const zone = !w.timeZone ? " (server's time)" : w.timeZone !== browserTimeZone() ? ` (${w.timeZone})` : "";
  const range = [w.startDate && `from ${w.startDate}`, w.endDate && `until ${w.endDate}`].filter(Boolean).join(" ");
  return `${when} at ${w.startTime}${zone} for ${duration(w.durationMinutes ?? 0)}${range ? `, ${range}` : ""}`;
}

/**
 * The page: loads windows and the sites/endpoints/checks/groups they can
 * target, and shows each window with its state and actions (edit, end now,
 * turn on/off, delete), plus the schedule/edit dialog.
 */
export default function MaintenancePage() {
  const router = useRouter();
  // useState holds values that re-draw the page when they change.
  const [authChecked, setAuthChecked] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const sort = useSort<MaintenanceWindow>("maintenance", { name: (w) => w.name, active: (w) => (w.active ? 0 : w.enabled ? 1 : 2), repeats: (w) => (w.startsAt ? 0 : 1), scope: (w) => w.scope, starts: (w) => (w.next ? new Date(w.next) : w.startsAt ? new Date(w.startsAt) : null) });
  const [sites, setSites] = useState<Site[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  // The dialog: closed (null), scheduling a new window ("new"), or editing one.
  const [editing, setEditing] = useState<MaintenanceWindow | "new" | null>(null);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  // Fetches everything the page shows in parallel. useCallback keeps the same
  // function between re-draws so the effect below doesn't re-run needlessly.
  const load = useCallback(() =>
    Promise.all([api.maintenance(), api.sites(), api.endpoints(), api.checks(), api.groups()]).then(([w, s, e, c, g]) => {
    setWindows(w);
    setSites(s);
    setEndpoints(e);
    setChecks(c);
    setGroups(g);
    setLoaded(true);
  }), []);

  // useEffect runs after the page appears: check the session first, and send
  // a signed-out visitor to the login page.
  useEffect(() => {
    api
      .me()
      .then(() => setAuthChecked(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
  }, [router]);
  useEffect(() => {
    if (authChecked) load();
  }, [authChecked, load]);

  // The name of one of a window's targets, looked up in the list matching its scope.
  const targetName = (w: MaintenanceWindow, id: string) =>
    (w.scope === "site" ? sites : w.scope === "endpoint" ? endpoints : w.scope === "group" ? groups : checks).find((x) => x.id === id)?.name ?? "(deleted)";

  if (!authChecked) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Maintenance windows</h2>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + Schedule maintenance
        </Button>
      </div>
      <PageHelp anchor="maintenance">During a window, checks keep running and recording results, but no alerts go out and SLA reports skip that time. Windows can be one-time or repeat daily, weekly or monthly; use Edit to change one. You can also start maintenance from a multi-selection on the Checks, Endpoints and Sites pages.</PageHelp>

      {loaded && windows.length === 0 ? (
        <EmptyState>No maintenance windows.</EmptyState>
      ) : (
        <ul className="space-y-2">
          <li>
            <SortPicker sort={sort} options={[["name", "Name"], ["active", "Active first"], ["repeats", "One-time, then repeating"], ["scope", "Applies to"], ["starts", "Next start"]]} />
          </li>
          {sort.apply(windows).map((w) => (
            <li key={w.id} className="rounded-xl surface p-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={w.active ? "maintenance" : w.enabled ? "unknown" : "disabled"} />
                <span className="font-medium">{w.name}</span>
                <span className="text-xs text-[var(--muted)]">{w.active ? "active now" : w.enabled ? (w.next ? "scheduled" : "finished") : "ended / off"}</span>
                <span className="flex-1" />
                <Button className="!py-0.5 text-xs" onClick={() => setEditing(w)}>
                  Edit
                </Button>
                {/* Only a running one-off window can be ended early. */}
                {w.active && w.startsAt && (
                  <Button className="!py-0.5 text-xs" onClick={async () => (await api.endMaintenance(w.id), toast.show("Maintenance ended."), load())}>
                    End now
                  </Button>
                )}
                {/* Repeating windows are paused and resumed instead. */}
                {!w.startsAt && (
                  <Button className="!py-0.5 text-xs" onClick={async () => (await api.updateMaintenance(w.id, { enabled: !w.enabled }), load())}>
                    {w.enabled ? "Turn off" : "Turn on"}
                  </Button>
                )}
                <Button variant="danger" className="!py-0.5 text-xs" onClick={async () => confirm(`Delete "${w.name}"?`) && (await api.deleteMaintenance(w.id), load())}>
                  Delete
                </Button>
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">{describe(w)}</p>
              {/* For a repeating window, when it next starts (a one-off's start is already in the line above). */}
              {!w.startsAt && w.next && !w.active && <p className="text-xs text-[var(--muted)]">Next: {formatLocal(new Date(w.next))}</p>}
              <p className="text-xs text-[var(--muted)]">
                Applies to: {w.scope === "all" ? "everything" : `${w.scope}s — ${w.targetIds.map((id) => targetName(w, id)).join(", ")}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {editing && (
        <WindowDialog
          window={editing === "new" ? null : editing}
          sites={sites}
          endpoints={endpoints}
          checks={checks}
          groups={groups}
          onClose={() => setEditing(null)}
          onSaved={(verb) => (setEditing(null), toast.show(`Maintenance window ${verb}.`), load())}
        />
      )}
      {toast.node}
    </main>
  );
}

/**
 * Picks the largest unit a stored duration divides into evenly, for the
 * edit dialog (e.g. 120 min → "2" hours, 2880 → "2" days).
 */
function splitDuration(min: number): { amount: string; unit: "minutes" | "hours" | "days" } {
  if (min % 1440 === 0) return { amount: String(min / 1440), unit: "days" };
  if (min % 60 === 0) return { amount: String(min / 60), unit: "hours" };
  return { amount: String(min), unit: "minutes" };
}

/**
 * The "Schedule maintenance" / "Edit maintenance" dialog: a one-time window
 * (start and end) or a repeating one (daily, weekly, monthly on a date, or
 * monthly on a weekday, every N, within an optional date range), entered in
 * your own time zone or in UTC, applied to everything or to chosen sites,
 * endpoints, checks or groups.
 *
 * @param window the window being edited, or null to schedule a new one
 * @param sites, endpoints, checks, groups the things a window can be limited to
 * @param onClose called when the dialog is cancelled
 * @param onSaved called after the engine accepts the window ("scheduled" or "saved")
 */
function WindowDialog({
  window: w,
  sites,
  endpoints,
  checks,
  groups,
  onClose,
  onSaved,
}: {
  window: MaintenanceWindow | null;
  sites: Site[];
  endpoints: Endpoint[];
  checks: Check[];
  groups: Group[];
  onClose: () => void;
  onSaved: (verb: string) => void;
}) {
  const local = browserTimeZone();
  const now = new Date();
  // The zone the times are entered in. "" = the server's clock, offered only
  // for a repeating window saved before zones were recorded, so editing it
  // doesn't silently move it.
  const [zone, setZone] = useState<string>(w ? (w.timeZone ?? (w.startsAt ? local : "")) : local);
  // The zone used to show and read one-time start/end fields.
  const inputZone = zone || local;
  const [name, setName] = useState(w?.name ?? "");
  const [kind, setKind] = useState<Kind>(w ? (w.startsAt && w.endsAt ? "once" : (w.recurrence ?? "weekly")) : "once");
  // One-time defaults: starting now and lasting two hours.
  const [startsAt, setStartsAt] = useState(toZonedInput(w?.startsAt ? new Date(w.startsAt) : now, inputZone));
  const [endsAt, setEndsAt] = useState(toZonedInput(w?.endsAt ? new Date(w.endsAt) : new Date(now.getTime() + 2 * 3_600_000), inputZone));
  // Repeating defaults: Sundays at 02:00 for two hours.
  const [days, setDays] = useState<number[]>(w?.daysOfWeek?.length ? w.daysOfWeek : [0]);
  const [dayOfMonth, setDayOfMonth] = useState(String(w?.dayOfMonth ?? 1));
  const [weekOfMonth, setWeekOfMonth] = useState(String(w?.weekOfMonth ?? 2));
  const [every, setEvery] = useState(String(w?.repeatEvery ?? 1));
  const [startTime, setStartTime] = useState(w?.startTime ?? "02:00");
  const initialDuration = splitDuration(w?.durationMinutes ?? 120);
  const [durAmount, setDurAmount] = useState(initialDuration.amount);
  const [durUnit, setDurUnit] = useState(initialDuration.unit);
  const [startDate, setStartDate] = useState(w?.startDate ?? "");
  const [endDate, setEndDate] = useState(w?.endDate ?? "");
  const [enabled, setEnabled] = useState(w?.enabled ?? true);
  const [scope, setScope] = useState<MaintenanceWindow["scope"]>(w?.scope ?? "all");
  const [targets, setTargets] = useState<string[]>(w?.targetIds ?? []);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The choices shown for the selected scope ("everything" has none).
  const list = scope === "site" ? sites : scope === "endpoint" ? endpoints : scope === "check" ? checks : scope === "group" ? groups : [];
  // The zones on offer: yours, UTC, and whatever zone an edited window already uses.
  const zones = [...new Set([local, "UTC", ...(w?.timeZone ? [w.timeZone] : [])])];
  const needsDays = kind === "weekly" || kind === "monthly_weekday";

  /** Sends the window to the engine: POST for a new one, PATCH for an edit. */
  async function save() {
    setError(null);
    const minutes = Number(durAmount) * (durUnit === "days" ? 1440 : durUnit === "hours" ? 60 : 1);
    const n = Math.max(1, Math.floor(Number(every) || 1));
    // "Every 2 or more" counts from a start date; default it to today in the window's zone.
    const fromDate = startDate || (n > 1 ? toZonedInput(new Date(), inputZone).slice(0, 10) : "");
    const body: Partial<MaintenanceWindow> = {
      name,
      scope,
      targetIds: scope === "all" ? [] : targets,
      timeZone: zone || null,
      ...(w ? { enabled } : {}),
      // A one-time window is sent as exact instants (the datetime-local
      // values read on the chosen zone's clock), and the repeat fields are
      // cleared; a repeating window is sent with its zone and no instants.
      ...(kind === "once"
        ? { startsAt: fromZonedInput(startsAt, inputZone).toISOString(), endsAt: fromZonedInput(endsAt, inputZone).toISOString() }
        : {
            startsAt: null,
            endsAt: null,
            recurrence: kind,
            repeatEvery: n,
            daysOfWeek: needsDays ? days : null,
            dayOfMonth: kind === "monthly_day" ? Number(dayOfMonth) : null,
            weekOfMonth: kind === "monthly_weekday" ? Number(weekOfMonth) : null,
            startTime,
            durationMinutes: Math.round(minutes),
            startDate: fromDate || null,
            endDate: endDate || null,
          }),
    };
    try {
      if (w) await api.updateMaintenance(w.id, body);
      else await api.createMaintenance(body);
      onSaved(w ? "saved" : "scheduled");
    } catch (err) {
      // The engine's validation message (e.g. "endsAt must be after startsAt").
      setError(err instanceof Error ? err.message : "Failed");
    }
  }

  return (
    <Modal title={w ? `Edit "${w.name}"` : "Schedule maintenance"} onClose={onClose} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          // Stops the browser's default full-page form submission.
          e.preventDefault();
          save();
        }}
      >
        <Label label="Name *">
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Patch Tuesday reboots" className={inputClass} />
        </Label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label label="Repeats">
            <select value={kind} onChange={(e) => setKind(e.target.value as Kind)} className={inputClass}>
              {KINDS.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </Label>
          <Label label="Time zone" help="The zone the times below are in. Repeating windows keep following it whatever the server's clock is set to.">
            {/* Switching zone keeps the clock times already typed; they now
                mean that time in the new zone (that's what "enter in UTC" means). */}
            <select value={zone} onChange={(e) => setZone(e.target.value)} className={inputClass}>
              {zones.map((z) => (
                <option key={z} value={z}>
                  {z === local ? `Your time (${z})` : z === "UTC" ? "UTC" : z}
                </option>
              ))}
              {zone === "" && <option value="">The server&apos;s clock (saved before time zones)</option>}
            </select>
          </Label>
        </div>

        {kind === "once" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Label label={`Starts (${inputZone})`}>
              <input type="datetime-local" required value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputClass} />
            </Label>
            <Label label={`Ends (${inputZone})`}>
              <input type="datetime-local" required value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputClass} />
            </Label>
          </div>
        ) : (
          <div className="space-y-3 rounded-md border border-[var(--border)] p-3">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Label label={`Every … ${unitOf(kind)}`} help={`1 = every time. 2 or more skips ${unitOf(kind)} in between, counted from the start date.`}>
                <input type="number" min={1} max={99} value={every} onChange={(e) => setEvery(e.target.value)} className={inputClass} />
              </Label>
              {kind === "monthly_day" && (
                <Label label="Day of the month" help="Days 29–31 fall on the last day of shorter months.">
                  <select value={dayOfMonth} onChange={(e) => setDayOfMonth(e.target.value)} className={inputClass}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {dayLabel(d)}
                      </option>
                    ))}
                    <option value={-1}>Last day</option>
                  </select>
                </Label>
              )}
              {kind === "monthly_weekday" && (
                <Label label="Which week">
                  <select value={weekOfMonth} onChange={(e) => setWeekOfMonth(e.target.value)} className={inputClass}>
                    {[1, 2, 3, 4, -1].map((n) => (
                      <option key={n} value={n}>
                        {ordinal(n)}
                      </option>
                    ))}
                  </select>
                </Label>
              )}
            </div>
            {needsDays && (
              <fieldset>
                <legend className="mb-1 text-xs text-[var(--muted)]">{kind === "weekly" ? "On" : "Weekday"}</legend>
                <div className="flex flex-wrap gap-3">
                  {DAYS.map((d, i) => (
                    <label key={d} className="flex items-center gap-1">
                      <input type="checkbox" className="accent-[var(--up)]" checked={days.includes(i)} onChange={(e) => setDays((p) => (e.target.checked ? [...p, i] : p.filter((x) => x !== i)))} />
                      {d}
                    </label>
                  ))}
                </div>
              </fieldset>
            )}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <Label label={`Start time (${zone || "server's clock"})`}>
                <input type="time" required value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputClass} />
              </Label>
              <Label label="Lasts">
                <div className="flex gap-2">
                  <input type="number" min={1} required value={durAmount} onChange={(e) => setDurAmount(e.target.value)} className={inputClass} />
                  <select value={durUnit} onChange={(e) => setDurUnit(e.target.value as typeof durUnit)} className={inputClass}>
                    <option value="minutes">minutes</option>
                    <option value="hours">hours</option>
                    <option value="days">days</option>
                  </select>
                </div>
              </Label>
            </div>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Label label="Starting on (optional)" help="No occurrence starts before this date. Needed for every 2 or more; defaults to today then.">
                <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} className={inputClass} />
              </Label>
              <Label label="Ending on (optional)" help="No occurrence starts after this date; leave empty to repeat indefinitely.">
                <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className={inputClass} />
              </Label>
            </div>
          </div>
        )}

        <Label label="Applies to">
          <select
            value={scope}
            onChange={(e) => {
              // Changing the scope clears targets chosen from the previous list.
              setScope(e.target.value as MaintenanceWindow["scope"]);
              setTargets([]);
            }}
            className={inputClass}
          >
            <option value="all">Everything</option>
            <option value="site">Chosen sites</option>
            <option value="endpoint">Chosen endpoints (incl. checks run from their agents)</option>
            <option value="check">Chosen checks</option>
            <option value="group">Chosen groups (whatever they contain at the time)</option>
          </select>
        </Label>
        {scope !== "all" && (
          <div className="rounded-md border border-[var(--border)] p-2">
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter…" className={`${inputClass} mb-2`} />
            <div className="max-h-48 space-y-1 overflow-y-auto">
              {list
                .filter((x) => x.name.toLowerCase().includes(filter.toLowerCase()))
                .map((x) => (
                  <label key={x.id} className="flex items-center gap-2">
                    <input type="checkbox" className="accent-[var(--up)]" checked={targets.includes(x.id)} onChange={(e) => setTargets((p) => (e.target.checked ? [...p, x.id] : p.filter((t) => t !== x.id)))} />
                    {x.name}
                  </label>
                ))}
            </div>
          </div>
        )}
        {/* Editing only: an ended or turned-off window can be switched back on here. */}
        {w && (
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-[var(--up)]" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            On (a window that is off never runs)
          </label>
        )}
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={(scope !== "all" && targets.length === 0) || (needsDays && days.length === 0)}>
            {w ? "Save" : "Schedule"}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
