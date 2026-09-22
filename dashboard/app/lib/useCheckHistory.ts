import { useEffect, useState } from "react";
import { api, type CheckResult } from "./api";

const HISTORY_LIMIT = 50;
const SPARKLINE_POINTS = 20;
const POLL_MS = 15_000;

// Shared between StatusTile's embedded CheckHistory and the standalone
// UptimeHistoryWidget, so the uptime-% math and sparkline-point selection
// live in exactly one place.
export function useCheckHistory(checkId: string) {
  const [results, setResults] = useState<CheckResult[] | null>(null);

  useEffect(() => {
    if (!checkId) return;
    const load = () => api.checkResults(checkId, HISTORY_LIMIT).then(setResults);
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [checkId]);

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
