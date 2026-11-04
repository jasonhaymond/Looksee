// The SLA reports page (/reports): uptime per check over 7–365 days, excluding
// maintenance and excluded results. "use client" makes this a React component
// that runs in the browser; the engine refuses every call without a session.

"use client";

import { useEffect, useState } from "react";
import { api, type Site, type SlaRow } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { PageHelp } from "../components/PageHelp";
import { Button, EmptyState, SortTh, inputClass } from "../components/ui";
import { useSort, type SortState } from "../lib/useSort";
import { usePageAuth } from "../components/usePageAuth";

// Worst uptime first until another column is chosen.
const WORST_FIRST: SortState = { key: "uptimePercent", dir: "asc" };

const minutes = (m: number) => (m >= 120 ? `${(m / 60).toFixed(1)} h` : `${m} min`);

export default function ReportsPage() {
  const authed = usePageAuth();
  const [days, setDays] = useState(30);
  const [siteId, setSiteId] = useState("");
  const [sites, setSites] = useState<Site[]>([]);
  const [rows, setRows] = useState<SlaRow[] | null>(null);
  const [target, setTarget] = useState("99.9");
  const sort = useSort<SlaRow>("sla", { name: (r) => r.name, uptimePercent: (r) => r.uptimePercent, downtimeMinutes: (r) => r.downtimeMinutes, degradedMinutes: (r) => r.degradedMinutes, maintenanceMinutes: (r) => r.maintenanceMinutes, incidents: (r) => r.incidents, avgLatencyMs: (r) => r.avgLatencyMs }, WORST_FIRST);

  useEffect(() => {
    if (!authed) return;
    api.sites().then(setSites);
  }, [authed]);
  useEffect(() => {
    if (!authed) return;
    setRows(null);
    api.slaReport(days, siteId || undefined).then((r) => setRows(r.checks));
  }, [authed, days, siteId]);

  const sorted = sort.apply(rows ?? []);
  const goal = Number(target);
  const measured = (rows ?? []).filter((r) => r.uptimePercent != null);
  const overall = measured.length ? measured.reduce((a, r) => a + (r.uptimePercent ?? 0), 0) / measured.length : null;
  const missing = measured.filter((r) => (r.uptimePercent ?? 100) < goal).length;

  const th = (key: string, label: string) => (
    <SortTh sort={sort} column={key} className="px-2 py-2 text-left font-normal">
      {label}
    </SortTh>
  );

  if (!authed) return null;
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <h2 className="mb-3 text-lg font-medium">SLA reports</h2>
      <PageHelp anchor="sla-reports">Time-weighted uptime per check. Maintenance windows are excluded; an incident is each time a check went down.</PageHelp>
      <div className="mb-4 flex flex-wrap items-end gap-3 text-sm">
        <label>
          <span className="block text-xs text-[var(--muted)]">Period</span>
          <select value={days} onChange={(e) => setDays(Number(e.target.value))} className={inputClass}>
            {[1, 7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                Last {d} day{d === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="block text-xs text-[var(--muted)]">Site</span>
          <select value={siteId} onChange={(e) => setSiteId(e.target.value)} className={inputClass}>
            <option value="">All</option>
            {sites.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="block text-xs text-[var(--muted)]">SLA target %</span>
          <input value={target} onChange={(e) => setTarget(e.target.value)} className={`${inputClass} w-24`} />
        </label>
        <span className="flex-1" />
        <Button
          onClick={async () => {
            const blob = await api.slaCsv(days, siteId || undefined);
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = `looksee-sla-${days}d.csv`;
            a.click();
            URL.revokeObjectURL(url);
          }}
        >
          Download CSV
        </Button>
      </div>
      {rows && (
        <div className="mb-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="text-xs text-[var(--muted)]">Average uptime</div>
            <div className="text-xl font-semibold">{overall != null ? `${overall.toFixed(3)}%` : "—"}</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="text-xs text-[var(--muted)]">Below {target}%</div>
            <div className="text-xl font-semibold">{missing}</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="text-xs text-[var(--muted)]">Incidents</div>
            <div className="text-xl font-semibold">{rows.reduce((a, r) => a + r.incidents, 0)}</div>
          </div>
          <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
            <div className="text-xs text-[var(--muted)]">Total downtime</div>
            <div className="text-xl font-semibold">{minutes(rows.reduce((a, r) => a + r.downtimeMinutes, 0))}</div>
          </div>
        </div>
      )}
      {!rows ? (
        <p className="text-sm text-[var(--muted)]">Loading…</p>
      ) : rows.length === 0 ? (
        <EmptyState>No results recorded in this period.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl surface">
          <table className="w-full text-sm">
            <thead className="text-xs text-[var(--muted)]">
              <tr>
                {th("name", "Check")}
                {th("uptimePercent", "Uptime")}
                {th("downtimeMinutes", "Downtime")}
                {th("degradedMinutes", "Degraded")}
                {th("maintenanceMinutes", "Maintenance")}
                {th("incidents", "Incidents")}
                {th("avgLatencyMs", "Avg response")}
              </tr>
            </thead>
            <tbody>
              {sorted.map((r) => {
                const below = r.uptimePercent != null && r.uptimePercent < goal;
                return (
                  <tr key={r.checkId} className="border-t border-[var(--border)]">
                    <td className="px-2 py-2">
                      <div>{r.name}</div>
                      <div className="text-xs text-[var(--muted)]">{typeLabel(r.type)}</div>
                    </td>
                    <td className={`px-2 py-2 font-medium ${below ? "text-[var(--down)]" : ""}`}>
                      {r.uptimePercent != null ? `${r.uptimePercent.toFixed(3)}%` : "—"}
                      {below && <span className="block text-[10px] font-normal">below target</span>}
                    </td>
                    <td className="px-2 py-2">{minutes(r.downtimeMinutes)}</td>
                    <td className="px-2 py-2 text-[var(--muted)]">{minutes(r.degradedMinutes)}</td>
                    <td className="px-2 py-2 text-[var(--muted)]">{minutes(r.maintenanceMinutes)}</td>
                    <td className="px-2 py-2">{r.incidents}</td>
                    <td className="px-2 py-2 text-[var(--muted)]">{r.avgLatencyMs != null ? `${r.avgLatencyMs} ms` : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
