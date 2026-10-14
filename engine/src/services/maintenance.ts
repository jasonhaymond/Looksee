// Maintenance windows: deciding whether a check is "in maintenance" right now.
//
// Where this sits: every check result passes through here (via
// services/alerting.ts and the scheduler) before alerts are considered. A
// result taken during an active window is recorded but flagged, so it doesn't
// alert and doesn't count toward or against uptime. Windows are created and
// edited on the dashboard's Maintenance page through routes/maintenance.ts,
// and stored in the `maintenance_windows` table (see db/schema.ts).
//
// A window is either one-off (startsAt..endsAt, two absolute instants) or
// weekly (daysOfWeek + startTime + durationMinutes, read on the wall clock of
// the window's own time zone).

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { maintenanceWindows } from "../db/schema.js";
import { isValidTimeZone, serverTimeZone, wallClock } from "../lib/timeZone.js";

// One stored window row, as Drizzle (the database library) returns it.
type Window = typeof maintenanceWindows.$inferSelect;
// What a window can apply to: a check, identified by itself, its endpoint,
// and the host(s) it runs on or about.
type Target = { id: string; endpointId: string; hostId: string | null; probeHostId?: string | null };

// Windows change rarely and every result consults them, so the enabled ones
// are cached in memory for 15 s instead of queried per result.
// routes/maintenance.ts calls invalidateMaintenanceCache() after any write so
// an edit takes effect immediately rather than up to 15 s later.
let cache: { at: number; rows: Window[] } | null = null;
const CACHE_MS = 15_000;

/** Drops the cached window list so the next lookup re-reads the database. */
export function invalidateMaintenanceCache() {
  cache = null;
}

/**
 * The enabled maintenance windows, from the cache when it's fresh.
 *
 * @returns every window with enabled = true (active or not)
 */
async function activeWindows(): Promise<Window[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), rows: await db.query.maintenanceWindows.findMany({ where: eq(maintenanceWindows.enabled, true) }) };
  }
  return cache.rows;
}

/**
 * Whether a window is in effect at a given moment.
 *
 * One-off windows compare absolute instants, so time zones don't matter.
 * Weekly windows read the wall clock in the window's own `timeZone` — the
 * zone of the browser that saved it — so "Sunday 02:00" means 02:00 where the
 * person who set it is, whatever zone the server runs in. Windows saved
 * before zones were recorded have no zone and use the server's, which is
 * what they always did.
 *
 * Elapsed time is measured on the wall clock, so on the night clocks change
 * a window that spans the change runs an hour longer or shorter in real
 * time. That's accepted: it matches what a person reading the clock expects.
 *
 * @param w the window (only the timing fields are needed)
 * @param now the moment to test (a parameter so tests can fix it)
 * @returns true if results taken at `now` count as maintenance
 */
export function windowIsActive(
  w: Pick<Window, "startsAt" | "endsAt" | "daysOfWeek" | "startTime" | "durationMinutes" | "enabled"> & Partial<Pick<Window, "timeZone">>,
  now = new Date()
): boolean {
  if (!w.enabled) return false;
  // One-off: active from the start instant up to (not including) the end.
  if (w.startsAt && w.endsAt) return now >= w.startsAt && now < w.endsAt;
  // Weekly: needs days, a start time and a length; anything less never runs.
  if (!w.daysOfWeek?.length || !w.startTime || !w.durationMinutes) return false;
  const [h, m] = w.startTime.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  // A zone that stopped being valid (e.g. renamed in a tzdata update) falls
  // back to the server's zone rather than switching the window off.
  const tz = isValidTimeZone(w.timeZone) ? w.timeZone : serverTimeZone();
  const clock = wallClock(now, tz);
  const startMinute = h * 60 + m;
  // A window can begin on an earlier day and still be running — e.g. Saturday
  // 23:00 for 3 hours is still on early Sunday — so each of the last 7 days'
  // start is tried, not just today's. daysAgo = 0 is today.
  for (let daysAgo = 0; daysAgo < 7; daysAgo++) {
    const startDay = (clock.weekday - daysAgo + 7) % 7;
    if (!w.daysOfWeek.includes(startDay)) continue;
    // Minutes from that day's start time until now on the local clock.
    const elapsed = clock.minuteOfDay + daysAgo * 1440 - startMinute;
    if (elapsed >= 0 && elapsed < w.durationMinutes) return true;
  }
  return false;
}

/**
 * Whether a window covers a particular check.
 *
 * @param w the window's scope ("all", "endpoint", "host" or "check") and the
 *          IDs it names
 * @param target the check being tested
 * @returns true if the window applies to this check
 */
export function windowAppliesTo(w: Pick<Window, "scope" | "targetIds">, target: Target): boolean {
  const ids = w.targetIds ?? [];
  switch (w.scope) {
    case "all":
      return true;
    case "endpoint":
      return ids.includes(target.endpointId);
    case "host":
      // Either the host the check is about, or the agent host that runs it.
      return (target.hostId != null && ids.includes(target.hostId)) || (target.probeHostId != null && ids.includes(target.probeHostId));
    case "check":
      return ids.includes(target.id);
    default:
      // An unrecognised scope applies to nothing rather than everything.
      return false;
  }
}

/**
 * Whether any enabled window covers this check right now.
 *
 * @param target the check
 * @param now the moment to test
 * @returns true if the check is in maintenance
 */
export async function isInMaintenance(target: Target, now = new Date()): Promise<boolean> {
  return (await activeWindows()).some((w) => windowAppliesTo(w, target) && windowIsActive(w, now));
}
