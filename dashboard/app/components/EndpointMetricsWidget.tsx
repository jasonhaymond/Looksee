"use client";

import { useEffect, useState } from "react";
import { api, type Endpoint, type EndpointMetric, type Widget } from "../lib/api";
import { rangeToSince, DEFAULT_RANGE_HOURS } from "../lib/timeRange";
import { RangeSelect } from "./RangeSelect";
import { Sparkline } from "./Sparkline";
import { pollEvery } from "../lib/poll";

const POLL_MS = 15_000;
const POINTS = 20;
const RANGE_LIMIT = 2000;

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

export function EndpointMetricsWidget({ widget, host, onChanged }: { widget: Widget; host: Endpoint | undefined; onChanged: () => void }) {
  const rangeHours = widget.config.rangeHours ?? DEFAULT_RANGE_HOURS;
  const [metrics, setMetrics] = useState<EndpointMetric[] | null>(null);

  useEffect(() => {
    if (!host) return;
    const load = () => api.endpointMetrics(host.id, RANGE_LIMIT, rangeToSince(rangeHours)).then(setMetrics);
    load();
    const timer = pollEvery(load, POLL_MS);
    return () => clearInterval(timer);
  }, [host, rangeHours]);

  async function handleRangeChange(hours: number) {
    await api.updateWidget(widget.id, { config: { ...widget.config, rangeHours: hours } });
    onChanged();
  }

  if (!host) {
    return (
      <p className="surface rounded-lg p-3 text-xs text-[var(--muted)]">
        Endpoint not found — it may have been deleted.
      </p>
    );
  }

  // API returns newest-first; sparklines read left-to-right chronologically.
  // Downsample to POINTS so a wide time range doesn't render an unreadably
  // dense sparkline — the summary numbers still reflect the freshest value.
  const chronological = (metrics ?? []).slice().reverse();
  const step = Math.max(1, Math.ceil(chronological.length / POINTS));
  const sampled = chronological.filter((_, i) => i % step === 0);
  const cpu = sampled.filter((m) => m.cpuPercent != null).map((m) => m.cpuPercent as number);
  const mem = sampled.filter((m) => m.memPercent != null).map((m) => m.memPercent as number);
  const disk = sampled.filter((m) => m.diskPercent != null).map((m) => m.diskPercent as number);

  return (
    <div className="h-full surface rounded-lg p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium">{host.name}</h3>
        <RangeSelect hours={rangeHours} onChange={handleRangeChange} />
      </div>
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
