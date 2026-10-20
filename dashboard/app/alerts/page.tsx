"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api, type AlertEvent, type Endpoint, type Host, type Location } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { EmptyState, FilterChip, StatusBadge, inputClass } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";
import { pollEvery } from "../lib/poll";

const RANGES: [string, string, number][] = [
  ["24h", "24 hours", 24],
  ["7d", "7 days", 168],
  ["30d", "30 days", 720],
  ["90d", "90 days", 2160],
  ["365d", "1 year", 8760],
];

const duration = (min: number) => (min < 60 ? `${min} min` : min < 2880 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${Math.floor(min / 1440)} days`);

// Every alert incident (an alert rule firing until its check recovers),
// filterable by place, status and text — the history behind each alert.
export default function AlertsPage() {
  const authed = usePageAuth();
  const [events, setEvents] = useState<AlertEvent[] | null>(null);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [range, setRange] = useState("7d");
  const [status, setStatus] = useState<"" | "open" | "resolved">("");
  const [endpointId, setEndpointId] = useState("");
  const [locationId, setLocationId] = useState("");
  const [hostId, setHostId] = useState("");
  const [q, setQ] = useState("");

  useEffect(() => {
    if (!authed) return;
    Promise.all([api.endpoints(), api.hosts(), api.locations()]).then(([e, h, l]) => (setEndpoints(e), setHosts(h), setLocations(l)));
  }, [authed]);

  const load = useCallback(async () => {
    const hours = RANGES.find((r) => r[0] === range)![2];
    setEvents(await api.alertEvents({ since: new Date(Date.now() - hours * 3_600_000).toISOString(), status: status || undefined, endpointId: endpointId || undefined, locationId: locationId || undefined, hostId: hostId || undefined, q: q.trim() || undefined, limit: 2000 }));
  }, [range, status, endpointId, locationId, hostId, q]);

  useEffect(() => {
    if (!authed) return;
    const t = setTimeout(load, 250);
    const every = pollEvery(load, 30_000);
    return () => (clearTimeout(t), clearInterval(every));
  }, [authed, load]);

  const endpointName = useMemo(() => new Map(endpoints.map((e) => [e.id, e.name])), [endpoints]);
  const hostName = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);
  const open = events?.filter((e) => !e.resolvedAt).length ?? 0;
  const totalMin = events?.reduce((a, e) => a + (e.durationMinutes ?? 0), 0) ?? 0;

  if (!authed) return null;
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <TopNav active="/alerts" />
      <h2 className="mb-3 text-lg font-medium">Alert history</h2>
      <PageHelp anchor="alert-history">Every time an alert rule fired, how long the problem lasted, and whether it&apos;s still open. Click a check to see its full history and charts.</PageHelp>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {RANGES.map(([k, label]) => (
          <FilterChip key={k} active={range === k} onClick={() => setRange(k)}>
            {label}
          </FilterChip>
        ))}
        <span className="mx-1 w-px bg-[var(--border)]" />
        {(
          [
            ["", "All"],
            ["open", "Open"],
            ["resolved", "Resolved"],
          ] as const
        ).map(([k, label]) => (
          <FilterChip key={k} active={status === k} onClick={() => setStatus(k)}>
            {label}
          </FilterChip>
        ))}
      </div>
      <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search check or message…" className={inputClass} aria-label="Search alerts" />
        <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={inputClass} aria-label="Location">
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className={inputClass} aria-label="Endpoint">
          <option value="">All endpoints</option>
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select value={hostId} onChange={(e) => setHostId(e.target.value)} className={inputClass} aria-label="Host">
          <option value="">All hosts</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
      </div>

      {events && (
        <p className="mb-2 text-sm text-[var(--muted)]">
          {events.length} incident{events.length === 1 ? "" : "s"} · <span className={open ? "text-[var(--down)]" : ""}>{open} open</span> · {duration(totalMin)} of problems in total
        </p>
      )}
      {events && events.length === 0 ? (
        <EmptyState>No alerts match. Checks only raise alerts once they have an alert rule (Checks → select → Actions → Add alert rule).</EmptyState>
      ) : (
        <div className="surface overflow-x-auto rounded-xl">
          <table className="w-full text-sm">
            <thead className="bg-[var(--panel-2)] text-left text-xs text-[var(--muted)]">
              <tr>
                <th className="px-3 py-2 font-normal">Status</th>
                <th className="px-3 py-2 font-normal">Check</th>
                <th className="px-3 py-2 font-normal">Started</th>
                <th className="px-3 py-2 font-normal">Lasted</th>
                <th className="px-3 py-2 font-normal">Message</th>
              </tr>
            </thead>
            <tbody>
              {(events ?? []).map((e) => (
                <tr key={e.id} className="border-t border-[var(--border)] align-top">
                  <td className="whitespace-nowrap px-3 py-2">
                    <StatusBadge status={e.resolvedAt ? "up" : (e.severity ?? "down")} />
                    <div className="text-[10px] text-[var(--muted)]">{e.resolvedAt ? "resolved" : "open"}</div>
                  </td>
                  <td className="px-3 py-2">
                    {e.checkId ? (
                      <Link href={`/checks/${e.checkId}`} className="font-medium underline-offset-2 hover:underline">
                        {e.checkName}
                      </Link>
                    ) : (
                      e.checkName
                    )}
                    <div className="text-xs text-[var(--muted)]">{[e.checkType ? typeLabel(e.checkType) : null, e.hostId ? hostName.get(e.hostId) : null, e.endpointId ? endpointName.get(e.endpointId) : null].filter(Boolean).join(" · ")}</div>
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{new Date(e.triggeredAt).toLocaleString()}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-xs">{duration(e.durationMinutes ?? 0)}</td>
                  <td className="px-3 py-2 text-xs text-[var(--muted)]">{e.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
