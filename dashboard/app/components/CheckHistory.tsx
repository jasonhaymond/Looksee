"use client";

import { useEffect, useState } from "react";
import { api, type CheckResult } from "../lib/api";
import { Sparkline } from "./Sparkline";

const HISTORY_LIMIT = 50;
const SPARKLINE_POINTS = 20;
const POLL_MS = 15_000; // matches the dashboard page's own refresh cadence

const STATUS_LINE_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
};

export function CheckHistory({ checkId, currentStatus }: { checkId: string; currentStatus: string }) {
  const [results, setResults] = useState<CheckResult[] | null>(null);

  useEffect(() => {
    const load = () => api.checkResults(checkId, HISTORY_LIMIT).then(setResults);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [checkId]);

  if (!results || results.length === 0) return null;

  const upCount = results.filter((r) => r.status === "up").length;
  const uptimePercent = Math.round((upCount / results.length) * 1000) / 10;

  // API returns newest-first; sparkline reads left-to-right chronologically.
  const latencies = results
    .filter((r): r is CheckResult & { latencyMs: number } => r.latencyMs != null)
    .slice(0, SPARKLINE_POINTS)
    .reverse()
    .map((r) => r.latencyMs);

  return (
    <div className="mt-1 flex items-center gap-2 text-xs text-[var(--muted)]">
      <span>
        {uptimePercent}% up <span className="opacity-70">(last {results.length})</span>
      </span>
      {latencies.length >= 2 && <Sparkline values={latencies} color={STATUS_LINE_COLOR[currentStatus]} />}
    </div>
  );
}
