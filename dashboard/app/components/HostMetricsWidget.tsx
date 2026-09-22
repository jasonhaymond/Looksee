"use client";

import { useEffect, useState } from "react";
import { api, type Host, type HostMetric } from "../lib/api";
import { Sparkline } from "./Sparkline";

const POLL_MS = 15_000;
const POINTS = 20;

function MetricRow({ label, values, color }: { label: string; values: number[]; color: string }) {
  const latest = values[values.length - 1];
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-xs text-[var(--muted)]">{label}</span>
      <div className="flex items-center gap-2">
        {values.length >= 2 && <Sparkline values={values} color={color} width={64} height={18} />}
        <span className="w-10 text-right text-xs">{latest != null ? `${Math.round(latest)}%` : "—"}</span>
      </div>
    </div>
  );
}

export function HostMetricsWidget({ host }: { host: Host | undefined }) {
  const [metrics, setMetrics] = useState<HostMetric[] | null>(null);

  useEffect(() => {
    if (!host) return;
    const load = () => api.hostMetrics(host.id, POINTS).then(setMetrics);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [host]);

  if (!host) {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
        Host not found — it may have been deleted.
      </p>
    );
  }

  // API returns newest-first; sparklines read left-to-right chronologically.
  const chronological = (metrics ?? []).slice().reverse();
  const cpu = chronological.filter((m) => m.cpuPercent != null).map((m) => m.cpuPercent as number);
  const mem = chronological.filter((m) => m.memPercent != null).map((m) => m.memPercent as number);
  const disk = chronological.filter((m) => m.diskPercent != null).map((m) => m.diskPercent as number);

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <h3 className="font-medium">{host.name}</h3>
      {!metrics || metrics.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--muted)]">No metrics reported yet.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <MetricRow label="CPU" values={cpu} color="var(--up)" />
          <MetricRow label="RAM" values={mem} color="var(--warn)" />
          <MetricRow label="Disk" values={disk} color="var(--down)" />
        </div>
      )}
    </div>
  );
}
