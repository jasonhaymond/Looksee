import { useEffect, useState } from "react";
import { api, type CheckResult } from "./api";
import { rangeToSince } from "./timeRange";

const HISTORY_LIMIT = 50;
// A time-windowed fetch can span far more than 50 results, so it uses a much
// higher safety ceiling — the engine's own cap (2000) is the real limit.
const RANGE_LIMIT = 2000;
const SPARKLINE_POINTS = 20;
const POLL_MS = 15_000;

// Shared between StatusTile's embedded CheckHistory (fixed "last 50", no
// range control — compact, space-constrained) and the standalone
// UptimeHistoryWidget (rangeHours from the widget's own persisted config),
// so the uptime-% math and sparkline-point selection live in exactly one
// place either way.
export function useCheckHistory(checkId: string, rangeHours?: number) {
  const [results, setResults] = useState<CheckResult[] | null>(null);

  useEffect(() => {
    if (!checkId) return;
    const load = () =>
      rangeHours
        ? api.checkResults(checkId, RANGE_LIMIT, rangeToSince(rangeHours)).then(setResults)
        : api.checkResults(checkId, HISTORY_LIMIT).then(setResults);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [checkId, rangeHours]);

  if (!results || results.length === 0) return { results: null, uptimePercent: null, latencies: [] as number[] };

  const upCount = results.filter((r) => r.status === "up").length;
  const uptimePercent = Math.round((upCount / results.length) * 1000) / 10;

  // API returns newest-first; sparkline reads left-to-right chronologically.
  const latencies = results
    .filter((r): r is CheckResult & { latencyMs: number } => r.latencyMs != null)
    .slice(0, SPARKLINE_POINTS)
    .reverse()
    .map((r) => r.latencyMs);

  return { results, uptimePercent, latencies };
}
