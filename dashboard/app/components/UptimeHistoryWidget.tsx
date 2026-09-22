"use client";

import type { Check, Widget } from "../lib/api";
import { api } from "../lib/api";
import { useCheckHistory } from "../lib/useCheckHistory";
import { RANGE_OPTIONS, DEFAULT_RANGE_HOURS } from "../lib/timeRange";
import { RangeSelect } from "./RangeSelect";
import { Sparkline } from "./Sparkline";

const STATUS_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
};

// A standalone, bigger version of what StatusTile embeds inline via
// CheckHistory — same underlying data (useCheckHistory), just given a full
// widget tile's worth of room and its own time-range control instead of a
// fixed "last 50" footer.
export function UptimeHistoryWidget({ widget, check, onChanged }: { widget: Widget; check: Check | undefined; onChanged: () => void }) {
  const rangeHours = widget.config.rangeHours ?? DEFAULT_RANGE_HOURS;
  // Hooks must run unconditionally — fetch with an empty id (a harmless
  // no-op fetch, api.checkResults("") just 404s and results stays null)
  // when there's no check, rather than early-returning before the hook.
  const { results, uptimePercent, latencies } = useCheckHistory(check?.id ?? "", rangeHours);

  async function handleRangeChange(hours: number) {
    await api.updateWidget(widget.id, { config: { ...widget.config, rangeHours: hours } });
    onChanged();
  }

  if (!check) {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
        Check not found — it may have been deleted.
      </p>
    );
  }

  const rangeLabel = RANGE_OPTIONS.find((o) => o.hours === rangeHours)?.label ?? `${rangeHours}h`;

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate font-medium">{check.name}</h3>
        <RangeSelect hours={rangeHours} onChange={handleRangeChange} />
      </div>
      {!results ? (
        <p className="mt-2 text-xs text-[var(--muted)]">No results yet.</p>
      ) : (
        <>
          <p className="mt-1 text-2xl font-semibold" style={{ color: uptimePercent === 100 ? "var(--up)" : "var(--text)" }}>
            {uptimePercent}%
          </p>
          <p className="text-xs text-[var(--muted)]">
            uptime over {rangeLabel} ({results.length} result{results.length === 1 ? "" : "s"})
          </p>
          {latencies.length >= 2 && (
            <div className="mt-3">
              <Sparkline values={latencies} color={STATUS_COLOR.up} width={200} height={48} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
