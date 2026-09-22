"use client";

import { useCheckHistory } from "../lib/useCheckHistory";
import { Sparkline } from "./Sparkline";

const STATUS_LINE_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
};

export function CheckHistory({ checkId, currentStatus }: { checkId: string; currentStatus: string }) {
  const { results, uptimePercent, latencies } = useCheckHistory(checkId);

  if (!results) return null;

  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
      <span>
        {uptimePercent}% up <span className="opacity-70">(last {results.length})</span>
      </span>
      {latencies.length >= 2 && <Sparkline values={latencies} color={STATUS_LINE_COLOR[currentStatus]} />}
    </div>
  );
}
