"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { api, type Check, type Endpoint, type FlowRow, type Widget } from "../lib/api";
import { StatusBadge, formatBytes } from "./ui";
import { displayStatus } from "./CheckDetail";

const RANGES = [
  { minutes: 15, label: "15m" },
  { minutes: 60, label: "1h" },
  { minutes: 360, label: "6h" },
  { minutes: 1440, label: "24h" },
];

export function TopTalkersWidget({ widget, onChanged }: { widget: Widget; onChanged: () => void }) {
  const minutes = widget.config.rangeMinutes ?? 60;
  const by = widget.config.groupBy ?? "pair";
  const [rows, setRows] = useState<FlowRow[] | null>(null);
  useEffect(() => {
    const load = () => api.topFlows({ minutes, by, limit: 8 }).then(setRows).catch(() => setRows([]));
    load();
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [minutes, by]);
  const max = Math.max(1, ...(rows ?? []).map((r) => r.bytes));
  const update = async (config: Widget["config"]) => {
    await api.updateWidget(widget.id, { config: { ...widget.config, ...config } });
    onChanged();
  };
  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <Link href="/flows" className="font-medium hover:underline">
          Top talkers
        </Link>
        <span className="no-drag flex gap-1">
          <select value={by} onChange={(e) => update({ groupBy: e.target.value })} className="rounded border border-[var(--border)] bg-transparent px-1 text-xs">
            <option value="pair">pairs</option>
            <option value="src">sources</option>
            <option value="dst">destinations</option>
            <option value="port">services</option>
          </select>
          <select value={minutes} onChange={(e) => update({ rangeMinutes: Number(e.target.value) })} className="rounded border border-[var(--border)] bg-transparent px-1 text-xs">
            {RANGES.map((r) => (
              <option key={r.minutes} value={r.minutes}>
                {r.label}
              </option>
            ))}
          </select>
        </span>
      </div>
      {!rows ? null : rows.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No flow data in this window — point a NetFlow/IPFIX/sFlow exporter at the engine (see Top talkers page).</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {rows.map((r) => (
            <li key={r.label}>
              <div className="flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="shrink-0 text-[var(--muted)]">{formatBytes(r.bytes)}</span>
              </div>
              <div className="mt-0.5 h-1 rounded bg-[var(--border)]">
                <div className="h-1 rounded bg-[var(--up)]" style={{ width: `${(r.bytes / max) * 100}%` }} />
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Counts by status for one endpoint (or everything) with the problems
// listed — a compact "what's wrong right now" tile.
export function StatusSummaryWidget({ checks, endpoint }: { checks: Check[]; endpoint: Endpoint | undefined }) {
  const counts: Record<string, number> = {};
  for (const c of checks) counts[displayStatus(c)] = (counts[displayStatus(c)] ?? 0) + 1;
  const problems = checks.filter((c) => ["down", "warn"].includes(displayStatus(c))).sort((a, b) => (displayStatus(a) === "down" ? -1 : 1) - (displayStatus(b) === "down" ? -1 : 1));
  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 font-medium">{endpoint ? endpoint.name : "All endpoints"}</div>
      <div className="mb-2 flex flex-wrap gap-3 text-sm">
        {["down", "warn", "up", "maintenance", "unknown"].map((s) =>
          counts[s] ? (
            <span key={s} className="inline-flex items-center gap-1.5">
              <StatusBadge status={s} compact />
              <strong>{counts[s]}</strong>
              <span className="text-xs text-[var(--muted)]">{s}</span>
            </span>
          ) : null
        )}
      </div>
      {problems.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">Nothing down or warning.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {problems.slice(0, 8).map((c) => (
            <li key={c.id} className="flex items-center gap-2">
              <StatusBadge status={displayStatus(c)} compact />
              <span className="truncate">{c.name}</span>
              <span className="truncate text-[var(--muted)]">{c.lastMessage}</span>
            </li>
          ))}
          {problems.length > 8 && <li className="text-[var(--muted)]">+{problems.length - 8} more</li>}
        </ul>
      )}
    </div>
  );
}
