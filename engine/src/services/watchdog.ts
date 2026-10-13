import { eq } from "drizzle-orm";
import { db, pool } from "../db/index.js";
import { watchdogSettings } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { schedulerLastTick } from "./scheduler.js";

export type Watchdog = typeof watchdogSettings.$inferSelect;

export async function getWatchdog(): Promise<Watchdog> {
  let [row] = await db.select().from(watchdogSettings).where(eq(watchdogSettings.id, 1));
  if (!row) [row] = await db.insert(watchdogSettings).values({ id: 1 }).onConflictDoNothing().returning();
  return row ?? (await db.select().from(watchdogSettings).where(eq(watchdogSettings.id, 1)))[0];
}

// What "healthy" means for the ping: the database answers and the check
// scheduler has completed a pass in the last two minutes.
export async function selfCheck(): Promise<{ ok: boolean; reason: string }> {
  try {
    await pool.query("SELECT 1");
  } catch (err) {
    return { ok: false, reason: `database unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }
  const since = Date.now() - schedulerLastTick();
  if (since > 120_000) return { ok: false, reason: `check scheduler hasn't run for ${Math.round(since / 1000)} s` };
  return { ok: true, reason: "ok" };
}

// Shown in the UI and the API instead of the URL itself (its path holds the
// service's token).
export function describeUrl(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/…`;
  } catch {
    return "invalid URL";
  }
}

export async function pingNow(w?: Watchdog): Promise<{ sent: boolean; healthy: boolean; detail: string }> {
  const s = w ?? (await getWatchdog());
  if (!s.url) return { sent: false, healthy: false, detail: "No watchdog URL set" };
  const health = await selfCheck();
  const target = health.ok ? s.url : (s.failUrl ?? null);
  let error: string | null = null;
  if (target) {
    try {
      // POST body carries the reason for a failure ping (Healthchecks.io
      // shows it); services that only look at the request ignore it.
      const res = await fetch(target, { method: health.ok ? "GET" : "POST", body: health.ok ? undefined : `Looksee self-check failed: ${health.reason}`, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) error = `HTTP ${res.status}`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
  }
  const result = health.ok ? "healthy — pinged" : target ? `unhealthy (${health.reason}) — sent failure ping` : `unhealthy (${health.reason}) — no ping sent`;
  await db.update(watchdogSettings).set({ lastPingAt: new Date(), lastResult: result, lastError: error }).where(eq(watchdogSettings.id, 1));
  if (error) logger.warn("watchdog", `Watchdog ping to ${describeUrl(target)} failed: ${error}`, "Looksee couldn't reach your external uptime service — if this continues, that service will report Looksee as down.");
  if (!health.ok) logger.error("watchdog", `Self-check failed: ${health.reason}`, `Looksee's self-check failed (${health.reason}).`);
  return { sent: Boolean(target) && !error, healthy: health.ok, detail: error ?? result };
}

// Checked every 15 s; pings once each interval while enabled.
export function startWatchdog() {
  let last = 0;
  const timer = setInterval(async () => {
    try {
      const w = await getWatchdog();
      if (!w.enabled || !w.url) return;
      if (Date.now() - last < w.intervalSeconds * 1000 - 5_000) return;
      last = Date.now();
      await pingNow(w);
    } catch (err) {
      logger.error("watchdog", `Watchdog tick failed: ${err instanceof Error ? err.message : String(err)}`, "The external uptime ping couldn't run this time.");
    }
  }, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
