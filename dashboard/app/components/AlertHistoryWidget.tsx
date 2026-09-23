"use client";

import { useEffect, useState } from "react";
import { api, type AlertEvent, type Endpoint, type Widget } from "../lib/api";
import { rangeToSince, DEFAULT_RANGE_HOURS, RANGE_OPTIONS } from "../lib/timeRange";
import { RangeSelect } from "./RangeSelect";

const POLL_MS = 15_000;

const STATUS_COLOR: Record<AlertEvent["status"], string> = {
  triggered: "var(--down)",
  resolved: "var(--up)",
};

export function AlertHistoryWidget({ widget, endpoint, onChanged }: { widget: Widget; endpoint: Endpoint | undefined; onChanged: () => void }) {
  const rangeHours = widget.config.rangeHours ?? DEFAULT_RANGE_HOURS;
  const [events, setEvents] = useState<AlertEvent[] | null>(null);

  useEffect(() => {
    const load = () => api.alertEvents({ endpointId: widget.config.endpointId, since: rangeToSince(rangeHours), limit: 50 }).then(setEvents);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [widget.config.endpointId, rangeHours]);

  async function handleRangeChange(hours: number) {
    await api.updateWidget(widget.id, { config: { ...widget.config, rangeHours: hours } });
    onChanged();
  }

  const rangeLabel = RANGE_OPTIONS.find((o) => o.hours === rangeHours)?.label ?? `${rangeHours}h`;

  return (
    <div className="h-full overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="truncate font-medium">Alert history{endpoint ? ` — ${endpoint.name}` : ""}</h3>
        <RangeSelect hours={rangeHours} onChange={handleRangeChange} />
      </div>
      {!events ? (
        <p className="text-xs text-[var(--muted)]">Loading…</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No alerts in the last {rangeLabel}.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {events.map((e) => (
            <li key={e.id} className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: STATUS_COLOR[e.status] }} />
              <span className="truncate">{e.checkName}</span>
              <span className="text-[var(--muted)]">{e.status}</span>
              <span className="ml-auto shrink-0 text-[var(--muted)]">{new Date(e.triggeredAt).toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
