import { and, eq, inArray, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, ENGINE_CHECK_TYPES } from "../db/schema.js";
import { runProbe, type ProbeResult } from "./prober.js";
import { recordCheckResult } from "./alerting.js";
import { logger } from "../lib/logger.js";

const TICK_MS = 10_000;

// Heavy probes get their own concurrency ceiling — twenty browser checks
// due on the same tick must not launch twenty Chromes at once.
const TYPE_LIMITS: Record<string, number> = { browser: 2, email_roundtrip: 3, traceroute: 4, dhcp: 1 };
const GLOBAL_LIMIT = 25;

const running = new Set<string>();
const runningByType = new Map<string, number>();

// Polls for due checks every TICK_MS rather than scheduling one timer per
// check — simpler, and naturally tolerant of checks being added, edited,
// or deleted between ticks with no rescheduling logic needed.
export function startScheduler() {
  const timer = setInterval(() => {
    runDueChecks().catch((err) => logger.error("scheduler", `Tick failed: ${err instanceof Error ? err.message : String(err)}`, "The check scheduler hit an error this cycle — it will retry on the next tick."));
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// While a check isn't "up" and has a retry interval, that shorter interval
// decides when it's due (L3).
const effectiveInterval = sql`(CASE WHEN ${checks.lastStatus} IS NOT NULL AND ${checks.lastStatus} <> 'up' AND ${checks.retryIntervalSeconds} IS NOT NULL THEN ${checks.retryIntervalSeconds} ELSE ${checks.intervalSeconds} END)`;

export async function runDueChecks() {
  const due = await db
    .select()
    .from(checks)
    .where(
      and(
        eq(checks.enabled, true),
        // Pinned to an agent (L9) — that agent runs it and reports back.
        isNull(checks.probeHostId),
        inArray(checks.type, ENGINE_CHECK_TYPES),
        or(isNull(checks.lastRunAt), lt(checks.lastRunAt, sql`now() - (${effectiveInterval} || ' seconds')::interval`))
      )
    );
  const ready = due.filter((c) => !running.has(c.id));
  logger.debug("scheduler", `Tick: ${ready.length} engine check(s) due`, { checkIds: ready.map((c) => c.id) });

  for (const check of ready) {
    if (running.size >= GLOBAL_LIMIT) break;
    const limit = TYPE_LIMITS[check.type];
    if (limit && (runningByType.get(check.type) ?? 0) >= limit) continue;
    runOneCheck(check).catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("scheduler", `Check ${check.id} (${check.type}) failed to run: ${detail}`, `The "${check.name}" check couldn't be run — see its recent results for detail.`, { checkId: check.id, checkType: check.type });
    });
  }
}

export async function runOneCheck(check: typeof checks.$inferSelect): Promise<ProbeResult> {
  running.add(check.id);
  runningByType.set(check.type, (runningByType.get(check.type) ?? 0) + 1);
  try {
    await db.update(checks).set({ lastRunAt: new Date() }).where(eq(checks.id, check.id));
    const outcome = await runProbe(check.type, (check.config as Record<string, unknown>) ?? {}, {
      checkId: check.id,
      hostId: check.hostId,
      intervalSeconds: check.intervalSeconds,
      state: (check.state as Record<string, unknown>) ?? {},
      createdAt: check.createdAt,
    });
    if (outcome.state) await db.update(checks).set({ state: outcome.state }).where(eq(checks.id, check.id));
    if (!outcome.skip) await recordCheckResult(check.id, outcome);
    return outcome;
  } finally {
    running.delete(check.id);
    runningByType.set(check.type, (runningByType.get(check.type) ?? 1) - 1);
  }
}
