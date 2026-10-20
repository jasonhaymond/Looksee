// The check scheduler: every 10 seconds, finds checks that are due, hands
// checks in collector sites to their collector, runs the rest (with limits so
// heavy checks can't all start at once), and recovers pushed values that are set
// to recover on their own.

import { and, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, sites, endpoints, ENGINE_CHECK_TYPES } from "../db/schema.js";
import { COLLECTOR_CHECK_TYPES } from "../db/checkTypes.js";
import { runProbe, type ProbeResult } from "./prober.js";
import { recordCheckResult, resolveCheck } from "./alerting.js";
import { prepareConfig } from "./checkConfig.js";
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
    autoRecoverPushed().catch((err) => logger.error("scheduler", `Auto-recovery sweep failed: ${err instanceof Error ? err.message : String(err)}`, "Pushed-value checks set to recover on their own couldn't be checked this cycle."));
  }, TICK_MS);
  timer.unref();
  return () => clearInterval(timer);
}

// Pushed-value checks only change when something pushes to them, so a
// failure pushed in would otherwise stay until the next push. With
// config.autoRecoverMinutes set, one that has had no new result for that
// long is marked recovered. (Trap/syslog checks recover through their own
// probe — services/probes/internal.ts — since they're re-evaluated on a
// schedule.) The JSON path config->>'autoRecoverMinutes' reads that setting
// as text inside the query.
export async function autoRecoverPushed() {
  const stale = await db
    .select({ id: checks.id, config: checks.config, lastCheckedAt: checks.lastCheckedAt })
    .from(checks)
    .where(and(eq(checks.enabled, true), eq(checks.type, "push_value"), inArray(checks.lastStatus, ["down", "warn"]), sql`(${checks.config}->>'autoRecoverMinutes') IS NOT NULL`));
  for (const c of stale) {
    const minutes = Number((c.config as Record<string, unknown>).autoRecoverMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0 || !c.lastCheckedAt) continue;
    if (Date.now() - c.lastCheckedAt.getTime() >= minutes * 60_000) {
      await resolveCheck(c.id, `Auto-recovered: no new failure pushed for ${minutes} min`, "auto");
    }
  }
}

// While a check isn't "up" and has a retry interval, that shorter interval
// decides when it's due (L3).
const effectiveInterval = sql`(CASE WHEN ${checks.lastStatus} IS NOT NULL AND ${checks.lastStatus} <> 'up' AND ${checks.retryIntervalSeconds} IS NOT NULL THEN ${checks.retryIntervalSeconds} ELSE ${checks.intervalSeconds} END)`;

// When the scheduler last completed its query for due checks — the
// watchdog's evidence that the engine isn't just running, but working.
let lastTickAt = Date.now();
export const schedulerLastTick = () => lastTickAt;

export async function runDueChecks() {
  const due = await db
    .select()
    .from(checks)
    .where(
      and(
        eq(checks.enabled, true),
        // Pinned to an agent (L9) — that agent runs it and reports back.
        isNull(checks.probeEndpointId),
        inArray(checks.type, ENGINE_CHECK_TYPES),
        or(isNull(checks.lastRunAt), lt(checks.lastRunAt, sql`now() - (${effectiveInterval} || ' seconds')::interval`))
      )
    );
  lastTickAt = Date.now();
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
  const collectorSites = await db.query.sites.findMany({ where: isNotNull(sites.collectorEndpointId) });
  if (!collectorSites.length) return due;
  const collectorBySite = new Map<string, string>(collectorSites.map((e) => [e.id, e.collectorEndpointId!]));
  const collectorEndpoints = await db.query.endpoints.findMany({ where: inArray(endpoints.id, [...collectorBySite.values()]) });
  const engineRuns: T[] = [];
  for (const c of due) {
    const collectorEndpointId = collectorBySite.get(c.siteId);
    if (!collectorEndpointId || !COLLECTOR_TYPES.has(c.type) || c.probeEndpointId) {
      engineRuns.push(c);
      continue;
    }
    const collector = collectorEndpoints.find((h) => h.id === collectorEndpointId);
    const silentFor = collector?.collectorLastSeenAt ? (Date.now() - collector.collectorLastSeenAt.getTime()) / 1000 : Infinity;
    if (silentFor > Math.max(COLLECTOR_GRACE_SECONDS, c.intervalSeconds * 3)) {
      await db.update(checks).set({ lastRunAt: new Date() }).where(eq(checks.id, c.id));
      const name = collector?.name ?? "the collector host";
      const message = collector?.collectorLastSeenAt
        ? `Site collector on ${name} is offline since ${collector.collectorLastSeenAt.toISOString()}`
        : `Waiting for the site collector on ${name} to start — its agent needs to be 3.2.0 or newer (see the Endpoints page)`;
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
    // The check's own exclusions plus any reusable exclusion lists that
    // apply, and a referenced check's latest value (services/checkConfig.ts).
    const outcome = await runProbe(check.type, await prepareConfig(check), {
      checkId: check.id,
      endpointId: check.endpointId,
      siteId: check.siteId,
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
