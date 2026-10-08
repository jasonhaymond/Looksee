"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Check, type Endpoint, type Host, type MaintenanceWindow } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { Button, EmptyState, Label, Modal, StatusBadge, inputClass, useToast } from "../components/ui";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function describe(w: MaintenanceWindow) {
  if (w.startsAt && w.endsAt) return `${new Date(w.startsAt).toLocaleString()} → ${new Date(w.endsAt).toLocaleString()}`;
  if (w.daysOfWeek?.length) return `Every ${w.daysOfWeek.map((d) => DAYS[d]).join(", ")} at ${w.startTime} for ${w.durationMinutes} min`;
  return "—";
}

const toLocalInput = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);

export default function MaintenancePage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [windows, setWindows] = useState<MaintenanceWindow[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [adding, setAdding] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    const [w, e, h, c] = await Promise.all([api.maintenance(), api.endpoints(), api.hosts(), api.checks()]);
    setWindows(w);
    setEndpoints(e);
    setHosts(h);
    setChecks(c);
    setLoaded(true);
  }, []);

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

  const targetName = (w: MaintenanceWindow, id: string) =>
    (w.scope === "endpoint" ? endpoints : w.scope === "host" ? hosts : checks).find((x) => x.id === id)?.name ?? "(deleted)";

  if (!authChecked) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <TopNav active="/maintenance" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Maintenance windows</h2>
        <Button variant="primary" onClick={() => setAdding(true)}>
          + Schedule maintenance
        </Button>
      </div>
      <PageHelp anchor="maintenance">During a window, checks keep running and recording results, but no alerts go out and SLA reports skip that time. You can also start maintenance from a multi-selection on the Checks, Hosts and Endpoints pages.</PageHelp>

      {loaded && windows.length === 0 ? (
        <EmptyState>No maintenance windows.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {windows.map((w) => (
            <li key={w.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-sm">
              <div className="flex flex-wrap items-center gap-3">
                <StatusBadge status={w.active ? "maintenance" : w.enabled ? "unknown" : "disabled"} />
                <span className="font-medium">{w.name}</span>
                <span className="text-xs text-[var(--muted)]">{w.active ? "active now" : w.enabled ? "scheduled" : "ended / off"}</span>
                <span className="flex-1" />
                {w.active && w.startsAt && (
                  <Button className="!py-0.5 text-xs" onClick={async () => (await api.endMaintenance(w.id), toast.show("Maintenance ended."), load())}>
                    End now
                  </Button>
                )}
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
      {adding && <AddWindow endpoints={endpoints} hosts={hosts} checks={checks} onClose={() => setAdding(false)} onSaved={() => (setAdding(false), load())} />}
      {toast.node}
    </main>
  );
}

function AddWindow({ endpoints, hosts, checks, onClose, onSaved }: { endpoints: Endpoint[]; hosts: Host[]; checks: Check[]; onClose: () => void; onSaved: () => void }) {
  const now = new Date();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<"once" | "weekly">("once");
  const [startsAt, setStartsAt] = useState(toLocalInput(now));
  const [endsAt, setEndsAt] = useState(toLocalInput(new Date(now.getTime() + 2 * 3_600_000)));
  const [days, setDays] = useState<number[]>([0]);
  const [startTime, setStartTime] = useState("02:00");
  const [duration, setDuration] = useState("120");
  const [scope, setScope] = useState<MaintenanceWindow["scope"]>("all");
  const [targets, setTargets] = useState<string[]>([]);
  const [filter, setFilter] = useState("");
  const [error, setError] = useState<string | null>(null);
  const list = scope === "endpoint" ? endpoints : scope === "host" ? hosts : scope === "check" ? checks : [];

  return (
    <Modal title="Schedule maintenance" onClose={onClose} wide>
      <form
        className="space-y-3 text-sm"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.createMaintenance({
              name,
              scope,
              targetIds: scope === "all" ? [] : targets,
              ...(kind === "once"
                ? { startsAt: new Date(startsAt).toISOString(), endsAt: new Date(endsAt).toISOString() }
                : { daysOfWeek: days, startTime, durationMinutes: Number(duration) }),
            });
            onSaved();
          } catch (err) {
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
              <Label label="Start time (engine's local time)">
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
              setScope(e.target.value as MaintenanceWindow["scope"]);
              setTargets([]);
            }}
            className={inputClass}
          >
            <option value="all">Everything</option>
            <option value="endpoint">Chosen endpoints</option>
            <option value="host">Chosen hosts (incl. checks run from their agents)</option>
            <option value="check">Chosen checks</option>
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
