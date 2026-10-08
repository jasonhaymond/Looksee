"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type EventRow } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { EmptyState, inputClass } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

const SEVERITY = ["emerg", "alert", "crit", "error", "warning", "notice", "info", "debug"];
const SEV_COLOR = (s: number | null) => (s == null ? "var(--muted)" : s <= 3 ? "var(--down)" : s === 4 ? "var(--warn)" : "var(--muted)");

export default function EventsPage() {
  const authed = usePageAuth();
  const [rows, setRows] = useState<EventRow[] | null>(null);
  const [source, setSource] = useState("");
  const [sourceIp, setSourceIp] = useState("");
  const [q, setQ] = useState("");
  const [maxSeverity, setMaxSeverity] = useState("");
  const [live, setLive] = useState(true);

  const load = useCallback(() => api.events({ source, sourceIp, q, maxSeverity, limit: 300 }).then(setRows), [source, sourceIp, q, maxSeverity]);
  useEffect(() => {
    if (!authed) return;
    load();
    if (!live) return;
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [authed, load, live]);

  if (!authed) return null;
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <TopNav active="/events" />
      <h2 className="mb-3 text-lg font-medium">SNMP traps &amp; syslog</h2>
      <PageHelp anchor="traps-and-syslog">
        Everything devices have sent to the engine. Point SNMP traps at UDP 1162 and syslog at UDP/TCP 1514 on the engine (only private-network senders are accepted by default). To alert on these, add an “SNMP trap received” or “Syslog message received” check.
      </PageHelp>
      <div className="mb-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <select value={source} onChange={(e) => setSource(e.target.value)} className={inputClass} aria-label="Source">
          <option value="">Traps and syslog</option>
          <option value="snmp_trap">SNMP traps</option>
          <option value="syslog">Syslog</option>
        </select>
        <input value={sourceIp} onChange={(e) => setSourceIp(e.target.value)} placeholder="From IP" className={inputClass} />
        <select value={maxSeverity} onChange={(e) => setMaxSeverity(e.target.value)} className={inputClass} aria-label="Severity">
          <option value="">Any severity</option>
          {SEVERITY.slice(0, 7).map((s, i) => (
            <option key={s} value={i}>
              {s} or worse
            </option>
          ))}
        </select>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search text" className={inputClass} />
        <label className="flex items-center gap-2 text-sm text-[var(--muted)]">
          <input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} className="accent-[var(--up)]" />
          Live (10s)
        </label>
      </div>
      {rows && rows.length === 0 ? (
        <EmptyState>Nothing received yet matching these filters.</EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-[var(--border)] bg-[var(--panel)]/40">
          <table className="w-full text-xs">
            <thead className="text-[var(--muted)]">
              <tr>
                <th className="px-2 py-2 text-left font-normal">Received</th>
                <th className="px-2 py-2 text-left font-normal">From</th>
                <th className="px-2 py-2 text-left font-normal">Type</th>
                <th className="px-2 py-2 text-left font-normal">Severity</th>
                <th className="px-2 py-2 text-left font-normal">Message</th>
              </tr>
            </thead>
            <tbody>
              {(rows ?? []).map((r) => (
                <tr key={r.id} className="border-t border-[var(--border)] align-top">
                  <td className="whitespace-nowrap px-2 py-1.5 text-[var(--muted)]">{new Date(r.receivedAt).toLocaleString()}</td>
                  <td className="px-2 py-1.5 font-mono">{r.sourceIp}</td>
                  <td className="px-2 py-1.5">{r.source === "snmp_trap" ? "trap" : `syslog${(r.data as { app?: string } | null)?.app ? ` · ${(r.data as { app: string }).app}` : ""}`}</td>
                  <td className="px-2 py-1.5" style={{ color: SEV_COLOR(r.severity) }}>
                    {r.severity != null ? SEVERITY[r.severity] : "—"}
                  </td>
                  <td className="break-all px-2 py-1.5">{r.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
