"use client";

import { useEffect, useState } from "react";
import { api, type FlowRow } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { SiteSelect } from "../components/SiteSelect";
import { PageHelp } from "../components/PageHelp";
import { EmptyState, formatBytes, inputClass, relativeTime } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

const RANGES = [
  [15, "15 minutes"],
  [60, "1 hour"],
  [360, "6 hours"],
  [1440, "24 hours"],
  [10080, "7 days"],
] as const;

export default function FlowsPage() {
  const authed = usePageAuth();
  const [minutes, setMinutes] = useState(60);
  const [by, setBy] = useState("pair");
  const [exporter, setExporter] = useState("");
  const [site, setSite] = useState("");
  const [exporters, setExporters] = useState<{ exporter: string; last: string }[]>([]);
  const [rows, setRows] = useState<FlowRow[] | null>(null);

  useEffect(() => {
    if (authed) api.flowExporters().then(setExporters);
  }, [authed]);
  useEffect(() => {
    if (!authed) return;
    const load = () => api.topFlows({ minutes, by, exporter: exporter || undefined, site: site || undefined, limit: 50 }).then(setRows);
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [authed, minutes, by, exporter, site]);

  const max = Math.max(1, ...(rows ?? []).map((r) => r.bytes));
  if (!authed) return null;
  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <TopNav active="/flows" />
      <h2 className="mb-3 text-lg font-medium">Top talkers</h2>
      <PageHelp anchor="top-talkers">
        Who is using the network, from NetFlow v5/v9, IPFIX (UDP 2055) or sFlow (UDP 6343) sent to the engine or to a site collector — e.g. pfSense&apos;s softflowd package or a managed switch. Totals are summed per minute; the busiest 1,000 conversations per exporter per minute are kept for 7 days.
      </PageHelp>
      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <select value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} className={inputClass} aria-label="Range">
          {RANGES.map(([m, l]) => (
            <option key={m} value={m}>
              Last {l}
            </option>
          ))}
        </select>
        <select value={by} onChange={(e) => setBy(e.target.value)} className={inputClass} aria-label="Group by">
          <option value="pair">Conversations (source → destination)</option>
          <option value="src">Sources</option>
          <option value="dst">Destinations</option>
          <option value="port">Services (protocol/port)</option>
        </select>
        <SiteSelect value={site} onChange={setSite} />
        <select value={exporter} onChange={(e) => setExporter(e.target.value)} className={inputClass} aria-label="Exporter">
          <option value="">All exporters</option>
          {exporters.map((x) => (
            <option key={x.exporter} value={x.exporter}>
              {x.exporter} (last data {relativeTime(x.last)})
            </option>
          ))}
        </select>
      </div>
      {rows && rows.length === 0 ? (
        <EmptyState>{exporters.length ? "No traffic recorded in this window." : "No flow exporter has sent data yet."}</EmptyState>
      ) : (
        <ol className="space-y-2">
          {(rows ?? []).map((r, i) => (
            <li key={r.label} className="rounded-lg border border-[var(--border)] bg-[var(--panel)]/40 p-2 text-sm">
              <div className="flex flex-wrap justify-between gap-2">
                <span className="font-mono">
                  <span className="mr-2 text-[var(--muted)]">{i + 1}.</span>
                  {r.label}
                </span>
                <span className="text-xs text-[var(--muted)]">
                  {formatBytes(r.bytes)} · {Math.round(r.packets).toLocaleString()} pkts · avg {r.avgMbps} Mbps
                </span>
              </div>
              <div className="mt-1 h-1.5 rounded bg-[var(--border)]">
                <div className="h-1.5 rounded bg-[var(--up)]" style={{ width: `${(r.bytes / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ol>
      )}
    </main>
  );
}
