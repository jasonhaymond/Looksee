// The Maintenance page (/maintenance): lists maintenance windows and
// schedules new ones.
//
// Where this sits: during a window, checks keep running and recording
// results, but no alerts go out and SLA reports skip that time. Windows are
// stored by the engine (engine/src/routes/maintenance.ts), which also decides
// when each is active (engine/src/services/maintenance.ts). Maintenance can
// also be started from multi-selections on the Checks, Endpoints and Sites
// pages and from a location.
//
// Time zones: one-off windows are sent as exact instants, so they're right
// wherever the server is. Weekly windows ("every Sunday at 02:00") are saved
// with this browser's time zone, so 02:00 means 02:00 where you are.
//
// "use client" makes this a React component that runs in the browser. Access
// is enforced by the engine (every maintenance route needs a session); the
// sign-in check here only decides whether to send you to the login page.

"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Check, type Site, type Endpoint, type Group, type MaintenanceWindow } from "../lib/api";
import { browserTimeZone } from "../lib/localTime";
import { PageHelp } from "../components/PageHelp";
import { Button, EmptyState, Label, Modal, StatusBadge, inputClass, useToast } from "../components/ui";

// Day names in JavaScript's numbering (0 = Sunday), as stored in daysOfWeek.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * A one-line description of when a window runs. One-off windows are shown in
 * this browser's local time. A weekly window names its time zone only when it
 * differs from yours (or, for windows saved before zones were recorded, says
 * it follows the server's clock), so "at 02:00" is never ambiguous.
 *
 * @param w the window
 * @returns e.g. "Every Sun at 02:00 for 120 min (Europe/Berlin time)"
 */
function describe(w: MaintenanceWindow) {
  if (w.startsAt && w.endsAt) return `${new Date(w.startsAt).toLocaleString()} → ${new Date(w.endsAt).toLocaleString()}`;
  if (w.daysOfWeek?.length) {
    const zone = !w.timeZone ? " (server's time)" : w.timeZone !== browserTimeZone() ? ` (${w.timeZone} time)` : "";
    return `Every ${w.daysOfWeek.map((d) => DAYS.at(d)).join(", ")} at ${w.startTime}${zone} for ${w.durationMinutes} min`;
  }
  return "—";
}

/**
 * Formats a Date for a datetime-local input ("2026-10-13T14:05"), which
 * expects local wall-clock time with no zone. toISOString() is always UTC, so
 * the time-zone offset is subtracted first to land on local time.
 */
const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

/**
 * The page: loads windows and the sites/endpoints/checks they can target,
 * and shows each window with its state and actions (end now, turn on/off,
 * delete), plus the "Schedule maintenance" dialog.
 */
export default function MaintenancePage() {
  const router = useRouter();
  // useState holds values that re-draw the page when they change.
  const [authChecked, setAuthChecked] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [adding, setAdding] = useState(false);
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
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Schedule maintenance
        </Button>
      </div>
      <PageHelp anchor="maintenance">During a window, checks keep running and recording results, but no alerts go out and SLA reports skip that time. You can also start maintenance from a multi-selection on the Checks, Endpoints and Sites pages.</PageHelp>

      {loaded && windows.length === 0 ? (
        <EmptyState>No maintenance windows.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {windows.map((w) => (
            <li key={w.id} className="rounded-xl surface p-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={w.active ? "maintenance" : w.enabled ? "unknown" : "disabled"} />
                <span className="font-medium">{w.name}</span>
                <span className="text-xs text-[var(--muted)]">{w.active ? "active now" : w.enabled ? "scheduled" : "ended / off"}</span>
                <span className="flex-1" />
                {/* Only a running one-off window can be ended early. */}
                {w.active && w.startsAt && (
                  <Button className="!py-0.5 text-xs" onClick={async () => (await api.endMaintenance(w.id), toast.show("Maintenance ended."), load())}>
                    End now
                  </Button>
                )}
                {/* Weekly windows are paused and resumed instead. */}
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
              <p className="text-xs text-[var(--muted)]">
                Applies to: {w.scope === "all" ? "everything" : `${w.scope}s — ${w.targetIds.map((id) => targetName(w, id)).join(", ")}`}
              </p>
            </li>
          ))}
        </ul>
      )}
      {adding && <AddWindow sites={sites} endpoints={endpoints} checks={checks} groups={groups} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), load())} />}
      {toast.node}
    </main>
  );
}

/**
 * The "Schedule maintenance" dialog: a one-time window (start and end in
 * local time) or a weekly one (days, local start time, duration), applied to
 * everything or to chosen sites, endpoints or checks.
 *
 * @param sites, endpoints, checks, groups the things a window can be limited to
 * @param onClose called when the dialog is cancelled
 * @param onSaved called after the engine accepts the new window
 */
function AddWindow({ sites, endpoints, checks, groups, onClose, onSaved }: { sites: Site[]; endpoints: Endpoint[]; checks: Check[]; groups: Group[]; onClose: () => void; onSaved: () => void }) {
  const now = new Date();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"once" | "weekly">("once");
  // Defaults: a one-off window starting now and lasting two hours.
  const [startsAt, setStartsAt] = useState(toLocalInput(now));
  const [endsAt, setEndsAt] = useState(toLocalInput(new Date(now.getTime() + 2 * 3_600_000)));
  const [days, setDays] = useState<number[]>([0]);
  const [startTime, setStartTime] = useState("02:00");
  const [duration, setDuration] = useState("120");
  const [scope, setScope] = useState<MaintenanceWindow["scope"]>("all");
  const [targets, setTargets] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  // The choices shown for the selected scope ("everything" has none).
  const list = scope === "site" ? sites : scope === "endpoint" ? endpoints : scope === "check" ? checks : scope === "group" ? groups : [];
  const zone = browserTimeZone();

  return (
    <Modal title="Schedule maintenance" onClose={onClose} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={async (e) => {
          // Stops the browser's default full-page form submission.
          e.preventDefault();
          setError(null);
          try {
            await api.createMaintenance({
              name,
              scope,
              targetIds: scope === "all" ? [] : targets,
              // A datetime-local value has no zone; `new Date(...)` reads it as
              // local time, and toISOString() sends that exact instant in UTC.
              // A weekly window instead carries this browser's zone name.
              ...(kind === "once"
                ? { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }
                : { daysOfWeek: days, startTime, durationMinutes: Number(duration), timeZone: zone }),
            });
            onSaved();
          } catch (err) {
            // The engine's validation message (e.g. "endsAt must be after startsAt").
            setError(err instanceof Error ? err.message : "Failed");
          }
        }}
      >
        <Label label="Name *">
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Patch Tuesday reboots" className={inputClass} />
        </Label>
        <div className="flex gap-4">
          {(["once", "weekly"] as const).map((k) => (
            <label key={k} className="flex items-center gap-1.5">
              <input type="radio" checked={kind === k} onChange={() => setKind(k)} className="accent-[var(--up)]" />
              {k === "once" ? "One time" : "Every week"}
            </label>
          ))}
        </div>
        {kind === "once" ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Label label="Starts">
              <input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} className={inputClass} />
            </Label>
            <Label label="Ends">
              <input type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} className={inputClass} />
            </Label>
          </div>
        ) : (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-3">
              {DAYS.map((d, i) => (
                <label key={d} className="flex items-center gap-1">
                  <input type="checkbox" className="accent-[var(--up)]" checked={days.includes(i)} onChange={(e) => setDays((p) => (e.target.checked ? [...p, i] : p.filter((x) => x !== i)))} />
                  {d}
                </label>
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Label label="Start time" help={`Your local time (${zone}). The window follows this time zone even if the server's clock is set differently.`}>
                <input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} className={inputClass} />
              </Label>
              <Label label="Duration (minutes)">
                <input type="number" min={1} value={duration} onChange={(e) => setDuration(e.target.value)} className={inputClass} />
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
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={scope !== "all" && targets.length === 0}>
            Schedule
          </Button>
        </div>
      </form>
    </Modal>
  );
}
