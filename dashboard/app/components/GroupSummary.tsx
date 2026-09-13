import type { Check, CheckResult } from "../lib/api";

export function GroupSummary({ checks, latestByCheck }: { checks: Check[]; latestByCheck: Map<string, CheckResult> }) {
  const total = checks.length;
  const up = checks.filter((c) => latestByCheck.get(c.id)?.status === "up").length;
  const allUp = total > 0 && up === total;
  return (
    <span
      className="rounded-full px-2 py-0.5 text-xs font-medium"
      style={{
        background: allUp ? "rgba(63,185,80,0.15)" : "rgba(248,81,73,0.15)",
        color: allUp ? "var(--up)" : "var(--down)",
      }}
    >
      {up}/{total} up
    </span>
  );
}
