import type { Check, CheckResult, Endpoint } from "../lib/api";
import { GroupSummary } from "./GroupSummary";

const DOT_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
};

export function GroupSummaryCard({
  endpoint,
  checks,
  latestByCheck,
}: {
  endpoint: Endpoint | undefined;
  checks: Check[];
  latestByCheck: Map<string, CheckResult>;
}) {
  if (!endpoint) {
    return (
      <p className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3 text-xs text-[var(--muted)]">
        Endpoint not found — it may have been deleted.
      </p>
    );
  }

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="mb-2 flex items-center gap-2">
        <h3 className="font-medium">{endpoint.name}</h3>
        <GroupSummary checks={checks} latestByCheck={latestByCheck} />
      </div>
      {checks.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No checks on this endpoint yet.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {checks.map((c) => {
            const status = latestByCheck.get(c.id)?.status ?? "unknown";
            return (
              <li key={c.id} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: DOT_COLOR[status] }} />
                <span>{c.name}</span>
                <span className="text-[var(--muted)]">{status.toUpperCase()}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
