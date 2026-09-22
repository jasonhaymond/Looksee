"use client";

import { useEffect, useState } from "react";
import { api, type Host, type HostMetric, type Widget } from "../lib/api";
import { rangeToSince, DEFAULT_RANGE_HOURS } from "../lib/timeRange";
import { RangeSelect } from "./RangeSelect";
import { Sparkline } from "./Sparkline";

const POLL_MS = 15_000;
const POINTS = 20;
const RANGE_LIMIT = 2000;

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// netRxBytes/netTxBytes have been in every agent report since v1.0.0 but
// were never visualized until this widget — same hostMetrics data
// HostMetricsWidget already reads, just the two fields it doesn't show.
export function NetworkBandwidthWidget({ widget, host, onChanged }: { widget: Widget; host: Host | undefined; onChanged: () => void }) {
  const rangeHours = widget.config.rangeHours ?? DEFAULT_RANGE_HOURS;
  const [metrics, setMetrics] = useState<HostMetric[] | null>(null);

  useEffect(() => {
    if (!host) return;
    const load = () => api.hostMetrics(host.id, RANGE_LIMIT, rangeToSince(rangeHours)).then(setMetrics);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [host, rangeHours]);

  async function handleRangeChange(hours: number) {
    await api.updateWidget(widget.id, { config: { ...widget.config, rangeHours: hours } });
    onChanged();
  }

  if (!host) {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
        Host not found — it may have been deleted.
      </p>
    );
  }

  const chronological = (metrics ?? []).slice().reverse();
  const step = Math.max(1, Math.ceil(chronological.length / POINTS));
  const sampled = chronological.filter((_, i) => i % step === 0);
  const rx = sampled.filter((m) => m.netRxBytes != null).map((m) => m.netRxBytes as number);
  const tx = sampled.filter((m) => m.netTxBytes != null).map((m) => m.netTxBytes as number);
  const latestRx = rx[rx.length - 1];
  const latestTx = tx[tx.length - 1];

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium">{host.name}</h3>
        <RangeSelect hours={rangeHours} onChange={handleRangeChange} />
      </div>
      {!metrics || metrics.length === 0 ? (
        <p className="mt-2 text-xs text-[var(--muted)]">No metrics reported yet.</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--muted)]">↓ RX</span>
            <div className="flex items-center gap-2">
              {rx.length >= 2 && <Sparkline values={rx} color="var(--up)" width={64} height={18} />}
              <span className="w-16 text-right text-xs">{latestRx != null ? formatBytes(latestRx) : "—"}</span>
            </div>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span className="text-xs text-[var(--muted)]">↑ TX</span>
            <div className="flex items-center gap-2">
              {tx.length >= 2 && <Sparkline values={tx} color="var(--warn)" width={64} height={18} />}
              <span className="w-16 text-right text-xs">{latestTx != null ? formatBytes(latestTx) : "—"}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
