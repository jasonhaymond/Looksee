import { eq, and, isNull, lt, or } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, AGENTLESS_CHECK_TYPES } from "../db/schema.js";
import { runProbe } from "./prober.js";
import { recordCheckResult } from "./alerting.js";
import { logger } from "../lib/logger.js";

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

  const dueAgentless = due.filter((c) => AGENTLESS_CHECK_TYPES.includes(c.type));
  logger.debug("scheduler", `Tick: ${dueAgentless.length} agentless check(s) due`, { checkIds: dueAgentless.map((c) => c.id) });

  for (const check of dueAgentless) {
    runOneCheck(check.id, check.type, (check.config as Record<string, unknown>) ?? {}).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(
        "scheduler",
        `Check ${check.id} (${check.type}) failed to run: ${detail}`,
        `The "${check.type}" check couldn't be run — see its recent results for detail.`,
        { checkId: check.id, checkType: check.type }
      );
    });
  }
}

async function runOneCheck(checkId: string, type: string, config: Record<string, unknown>) {
  await db.update(checks).set({ lastRunAt: new Date() }).where(eq(checks.id, checkId));
  const result = await runProbe(type, config);
  await recordCheckResult(checkId, result.status, result.latencyMs, result.message);
}
