import { eq, and, isNull, lt, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks } from "../db/schema.js";
import { runProbe } from "./prober.js";
import { recordCheckResult } from "./alerting.js";

const AGENTLESS_TYPES = ["ping", "tcp", "http", "dns", "ssl_cert"] as const;
const TICK_MS = 10_000;

// Polls for due agentless checks every TICK_MS rather than scheduling one
// timer per check — simpler, and naturally tolerant of checks being added,
// edited, or deleted between ticks with no rescheduling logic needed.
export function startScheduler() {
  const timer = setInterval(runDueChecks, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

async function runDueChecks() {
  const due = await db.query.checks.findMany({
    where: and(
      eq(checks.enabled, true),
      or(
        isNull(checks.lastRunAt),
        lt(checks.lastRunAt, sql`now() - (checks.interval_seconds || ' seconds')::interval`)
      )
    ),
  });

  for (const check of due) {
    if (!(AGENTLESS_TYPES as readonly string[]).includes(check.type)) continue;
    runOneCheck(check.id, check.type, (check.config as Record<string, unknown>) ?? {}).catch((err) => {
      console.error(`Check ${check.id} (${check.type}) failed to run:`, err);
    });
  }
}

async function runOneCheck(checkId: string, type: string, config: Record<string, unknown>) {
  await db.update(checks).set({ lastRunAt: new Date() }).where(eq(checks.id, checkId));
  const result = await runProbe(type, config);
  await recordCheckResult(checkId, result.status, result.latencyMs, result.message);
}
