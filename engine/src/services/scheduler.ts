import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, endpoints, hosts, ENGINE_CHECK_TYPES } from "../db/schema.js";
import { COLLECTOR_CHECK_TYPES } from "../db/checkTypes.js";
import { runProbe, type ProbeResult } from "./prober.js";
import { recordCheckResult } from "./alerting.js";
import { logger } from "../lib/logger.js";

const TICK_MS = 10_000;

// Heavy probes get their own concurrency ceiling — twenty browser checks
// due on the same tick must not launch twenty Chromes at once.
const TYPE_LIMITS: Record<string, number> = { browser: 2, email_roundtrip: 3, traceroute: 4, dhcp: 1 };
const GLOBAL_LIMIT = 25;
const COLLECTOR_TYPES = new Set<string>(COLLECTOR_CHECK_TYPES);
// How long a site collector may be silent before its checks show unknown.
const COLLECTOR_GRACE_SECONDS = 180;

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
  const ready = (await takeCollectorChecks(due)).filter((c) => !running.has(c.id));
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

// Checks in an endpoint with a site collector are that collector's job, so
// they're removed from the engine's due list. The engine only steps in when
// the collector has gone quiet, recording "unknown" (once per interval) so
// stale results don't look current.
export async function takeCollectorChecks<T extends typeof checks.$inferSelect>(due: T[]): Promise<T[]> {
  const collectorEndpoints = await db.query.endpoints.findMany({ where: isNotNull(endpoints.collectorHostId) });
  if (!collectorEndpoints.length) return due;
  const collectorByEndpoint = new Map<string, string>(collectorEndpoints.map((e) => [e.id, e.collectorHostId!]));
  const collectorHosts = await db.query.hosts.findMany({ where: inArray(hosts.id, [...collectorByEndpoint.values()]) });
  const engineRuns: T[] = [];
  for (const c of due) {
    const collectorHostId = collectorByEndpoint.get(c.endpointId);
    if (!collectorHostId || !COLLECTOR_TYPES.has(c.type) || c.probeHostId) {
      engineRuns.push(c);
      continue;
    }
    const collector = collectorHosts.find((h) => h.id === collectorHostId);
    const silentFor = collector?.collectorLastSeenAt ? (Date.now() - collector.collectorLastSeenAt.getTime()) / 1000 : Infinity;
    if (silentFor > Math.max(COLLECTOR_GRACE_SECONDS, c.intervalSeconds * 3)) {
      await db.update(checks).set({ lastRunAt: new Date() }).where(eq(checks.id, c.id));
      const name = collector?.name ?? "the collector host";
      const message = collector?.collectorLastSeenAt
        ? `Site collector on ${name} is offline since ${collector.collectorLastSeenAt.toISOString()}`
        : `Waiting for the site collector on ${name} to start — its agent needs to be 3.2.0 or newer (see the Hosts page)`;
      await recordCheckResult(c.id, { status: "unknown", message });
    }
  }
  return engineRuns;
}

export async function runOneCheck(check: typeof checks.$inferSelect): Promise<ProbeResult> {
  running.add(check.id);
  runningByType.set(check.type, (runningByType.get(check.type) ?? 0) + 1);
  try {
    await db.update(checks).set({ lastRunAt: new Date() }).where(eq(checks.id, check.id));
    const outcome = await runProbe(check.type, (check.config as Record<string, unknown>) ?? {}, {
      checkId: check.id,
      hostId: check.hostId,
      endpointId: check.endpointId,
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
