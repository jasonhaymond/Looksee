"use client";

import type { Check } from "../lib/api";
import { useCheckHistory } from "../lib/useCheckHistory";
import { Sparkline } from "./Sparkline";

const STATUS_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
};

// A standalone, bigger version of what StatusTile embeds inline via
// CheckHistory — same underlying data (useCheckHistory), just given a full
// widget tile's worth of room instead of a two-line footer.
export function UptimeHistoryWidget({ check }: { check: Check | undefined }) {
  // Hooks must run unconditionally — fetch with an empty id (a harmless
  // no-op fetch, api.checkResults("") just 404s and results stays null)
  // when there's no check, rather than early-returning before the hook.
  const { results, uptimePercent, latencies } = useCheckHistory(check?.id ?? "");

  if (!check) {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
        Check not found — it may have been deleted.
      </p>
    );
  }

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <h3 className="font-medium">{check.name}</h3>
      {!results ? (
        <p className="mt-2 text-xs text-[var(--muted)]">No results yet.</p>
      ) : (
        <>
          <p className="mt-1 text-2xl font-semibold" style={{ color: uptimePercent === 100 ? "var(--up)" : "var(--text)" }}>
            {uptimePercent}%
          </p>
          <p className="text-xs text-[var(--muted)]">uptime, last {results.length} results</p>
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
