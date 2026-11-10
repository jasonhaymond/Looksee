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
// repeating: daily, weekly, monthly on a day of the month, or monthly on a
// weekday ("2nd Tuesday"), optionally every N days/weeks/months and limited to
// a date range. A repeating window's start time and dates are read on the
// wall clock of the window's own time zone (the browser's, or UTC).

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { maintenanceWindows } from "../db/schema.js";
import { isValidTimeZone, localMidnight, serverTimeZone, wallClock } from "../lib/timeZone.js";
import { checkIdsForGroups } from "./groups.js";

// One stored window row, as Drizzle (the database library) returns it.
type Window = typeof maintenanceWindows.$inferSelect;
// What a window can apply to: a check, identified by itself, its site, the
// endpoint it's about, and the endpoint whose agent runs it (if pinned).
type Target = { id: string; siteId: string; endpointId: string | null; probeEndpointId?: string | null };

// Windows change rarely and every result consults them, so the enabled ones
// are cached in memory for 15 s instead of queried per result.
// routes/maintenance.ts calls invalidateMaintenanceCache() after any write so
// an edit takes effect immediately rather than up to 15 s later. Windows
// scoped to groups also cache each group's checks (resolved once per
// refresh), since a filter group's members can change at any time.
let cache: { at: number; rows: Window[]; groupChecks: Map<string, Set<string>> } | null = null;
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
async function activeWindows(): Promise<{ rows: Window[]; groupChecks: Map<string, Set<string>> }> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const rows = await db.query.maintenanceWindows.findMany({ where: eq(maintenanceWindows.enabled, true) });
    const groupIds = [...new Set(rows.filter((w) => w.scope === "group").flatMap((w) => w.targetIds ?? []))];
    cache = { at: Date.now(), rows, groupChecks: await checkIdsForGroups(groupIds) };
  }
  return cache;
}

// The timing fields of a window — all that the schedule functions below need.
// The 5.6 fields are optional so older callers and tests can pass a plain
// weekly window.
type Timing = Pick<Window, "startsAt" | "endsAt" | "daysOfWeek" | "startTime" | "durationMinutes" | "enabled"> &
  Partial<Pick<Window, "timeZone" | "recurrence" | "repeatEvery" | "dayOfMonth" | "weekOfMonth" | "startDate" | "endDate">>;

// The repeat types a window can have (see db/schema.ts).
export const RECURRENCES = ["daily", "weekly", "monthly_day", "monthly_weekday"] as const;
export type Recurrence = (typeof RECURRENCES)[number];

/**
 * How a window repeats. Weekly windows saved before 5.6 have days of the
 * week but no recurrence label; they are weekly.
 *
 * @returns the repeat type, or null for a one-off window
 */
export function recurrenceOf(w: Pick<Timing, "daysOfWeek"> & { recurrence?: string | null }): Recurrence | null {
  if (w.recurrence && (RECURRENCES as readonly string[]).includes(w.recurrence)) return w.recurrence as Recurrence;
  return w.daysOfWeek?.length ? "weekly" : null;
}

// Calendar arithmetic on "YYYY-MM-DD" dates. A date is turned into a day
// number (days since 1970-01-01) using UTC purely as a calendar, so no time
// zone or daylight-saving change is involved — the zone was already applied
// when the date was read off the window's wall clock.
const dayNumber = (date: string) => {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
};
const dateOf = (n: number) => new Date(n * 86_400_000).toISOString().slice(0, 10);
// 1970-01-01 was a Thursday (day 4 in Sunday = 0 numbering).
const weekdayOf = (n: number) => (((n + 4) % 7) + 7) % 7;

/**
 * Whether a repeating window has an occurrence that starts on a given
 * calendar date (in the window's zone). The time of day isn't looked at here.
 *
 * Rules: the date must be inside startDate..endDate when they're set. "Every
 * N" counts from startDate (days, Sunday-to-Saturday weeks, or months); with
 * no startDate every occurrence counts. A "monthly_day" of 29–31 falls on the
 * last day of a shorter month, so "the 31st" still happens in February.
 *
 * @param w the window's repeat settings
 * @param date the calendar date, "YYYY-MM-DD"
 * @returns true if an occurrence starts that day
 */
export function occursOn(w: Timing, date: string): boolean {
  const rec = recurrenceOf(w);
  if (!rec) return false;
  // "YYYY-MM-DD" strings compare correctly as plain text.
  if (w.startDate && date < w.startDate) return false;
  if (w.endDate && date > w.endDate) return false;
  const n = dayNumber(date);
  const weekday = weekdayOf(n);
  const every = Math.max(1, w.repeatEvery ?? 1);
  // The day "every N" counts from; only needed when N > 1.
  const anchor = w.startDate && every > 1 ? dayNumber(w.startDate) : null;
  const [y, m, d] = date.split("-").map(Number);
  // Day 0 of the next month is this month's last day.
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  // Whole months between the start date's month and this one, for monthly types.
  const monthsOk = () => {
    if (anchor === null) return true;
    const [ay, am] = w.startDate!.split("-").map(Number);
    return (y * 12 + m - (ay * 12 + am)) % every === 0;
  };
  switch (rec) {
    case "daily":
      return anchor === null || (n - anchor) % every === 0;
    case "weekly": {
      if (!w.daysOfWeek?.includes(weekday)) return false;
      if (anchor === null) return true;
      // Compare the Sundays that begin each week, so "every 2 weeks on Mon
      // and Thu" keeps both days in the same on-week.
      return ((n - weekday - (anchor - weekdayOf(anchor))) / 7) % every === 0;
    }
    case "monthly_day": {
      if (!w.dayOfMonth) return false;
      const target = w.dayOfMonth === -1 ? daysInMonth : Math.min(w.dayOfMonth, daysInMonth);
      return d === target && monthsOk();
    }
    case "monthly_weekday": {
      if (!w.daysOfWeek?.includes(weekday) || !w.weekOfMonth) return false;
      // The 1st Tuesday falls on days 1–7, the 2nd on 8–14, and so on; the
      // last one is the one with fewer than 7 days of the month after it.
      const which = w.weekOfMonth === -1 ? d + 7 > daysInMonth : Math.ceil(d / 7) === w.weekOfMonth;
      return which && monthsOk();
    }
  }
}

/**
 * The zone a repeating window's clock is read in. A zone that stopped being
 * valid (e.g. renamed in a tzdata update) falls back to the server's zone
 * rather than switching the window off; so does a window saved before zones
 * were recorded, which is what it always did.
 */
const zoneOf = (w: Timing) => (isValidTimeZone(w.timeZone) ? w.timeZone : serverTimeZone());

/** The start time "HH:MM" as minutes after midnight, or null if unusable. */
function startMinuteOf(w: Timing): number | null {
  if (!w.startTime) return null;
  const [h, m] = w.startTime.split(":").map((n) => parseInt(n, 10));
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

/**
 * Whether a window is in effect at a given moment.
 *
 * One-off windows compare absolute instants, so time zones don't matter.
 * Repeating windows read the wall clock in the window's own `timeZone`, so
 * "Sunday 02:00" means 02:00 where the person who set it is (or in UTC, if
 * they chose UTC), whatever zone the server runs in.
 *
 * Elapsed time is measured on the wall clock, so on the night clocks change
 * a window that spans the change runs an hour longer or shorter in real
 * time. That's accepted: it matches what a person reading the clock expects.
 *
 * @param w the window (only the timing fields are needed)
 * @param now the moment to test (a parameter so tests can fix it)
 * @returns true if results taken at `now` count as maintenance
 */
export function windowIsActive(w: Timing, now = new Date()): boolean {
  if (!w.enabled) return false;
  // One-off: active from the start instant up to (not including) the end.
  if (w.startsAt && w.endsAt) return now >= w.startsAt && now < w.endsAt;
  // Repeating: needs a repeat type, a start time and a length; anything less never runs.
  const startMinute = startMinuteOf(w);
  if (!recurrenceOf(w) || startMinute === null || !w.durationMinutes) return false;
  const clock = wallClock(now, zoneOf(w));
  const today = dayNumber(clock.date);
  // An occurrence can begin on an earlier day and still be running — e.g.
  // Saturday 23:00 for 3 hours is still on early Sunday — so every start day
  // the duration could reach back to is tried, not just today. daysAgo = 0
  // is today.
  const reach = Math.ceil(w.durationMinutes / 1440);
  for (let daysAgo = 0; daysAgo <= reach; daysAgo++) {
    if (!occursOn(w, dateOf(today - daysAgo))) continue;
    // Minutes from that day's start time until now on the local clock.
    const elapsed = clock.minuteOfDay + daysAgo * 1440 - startMinute;
    if (elapsed >= 0 && elapsed < w.durationMinutes) return true;
  }
  return false;
}

/**
 * When a window next starts, for the Maintenance page's "Next:" line.
 *
 * For a repeating window it searches forward up to about two and a half
 * years of dates (enough for "every 12 months" twice over). The instant is
 * that date's local midnight plus the start time, so on a daylight-saving
 * day it can be an hour off the wall clock — fine for a display hint.
 *
 * @param w the window
 * @param now the moment to search from
 * @returns the next start instant, or null if it never starts again (turned
 *          off, past its end date, or a one-off that has already begun)
 */
export function nextStart(w: Timing, now = new Date()): Date | null {
  if (!w.enabled) return null;
  if (w.startsAt && w.endsAt) return w.startsAt > now ? w.startsAt : null;
  const startMinute = startMinuteOf(w);
  if (!recurrenceOf(w) || startMinute === null) return null;
  const tz = zoneOf(w);
  const today = dayNumber(wallClock(now, tz).date);
  for (let i = 0; i < 900; i++) {
    const date = dateOf(today + i);
    // Past the end of the date range: nothing later can occur either.
    if (w.endDate && date > w.endDate) return null;
    if (!occursOn(w, date)) continue;
    const at = new Date(localMidnight(date, tz).getTime() + startMinute * 60_000);
    if (at > now) return at;
  }
  return null;
}

/**
 * Whether a window covers a particular check.
 *
 * @param w the window's scope ("all", "site", "endpoint", "check" or
 *          "group") and the IDs it names
 * @param target the check being tested
 * @param groupChecks for "group" windows: each group's check IDs
 * @returns true if the window applies to this check
 */
export function windowAppliesTo(w: Pick<Window, "scope" | "targetIds">, target: Target, groupChecks: Map<string, Set<string>> = new Map()): boolean {
  const ids = w.targetIds ?? [];
  switch (w.scope) {
    case "all":
      return true;
    case "site":
      return ids.includes(target.siteId);
    case "endpoint":
      // Either the endpoint the check is about, or the endpoint whose agent runs it.
      return (target.endpointId != null && ids.includes(target.endpointId)) || (target.probeEndpointId != null && ids.includes(target.probeEndpointId));
    case "group":
      return ids.some((g) => groupChecks.get(g)?.has(target.id));
    case "check":
      return ids.includes(target.id);
    default:
      // An unrecognised scope applies to nothing rather than everything.
      return false;
  }
}

/**
 * The windows in effect right now, with the check sets of any groups they
 * target — for list views that mark many checks "in maintenance" at once
 * (call once, then test each check with windowAppliesTo).
 *
 * @returns active windows and each targeted group's check IDs
 */
export async function activeMaintenance(now = new Date()): Promise<{ windows: Window[]; groupChecks: Map<string, Set<string>> }> {
  const windows = (await db.query.maintenanceWindows.findMany()).filter((w) => windowIsActive(w, now));
  const groupIds = [...new Set(windows.filter((w) => w.scope === "group").flatMap((w) => w.targetIds ?? []))];
  return { windows, groupChecks: await checkIdsForGroups(groupIds) };
}

/**
 * Whether any enabled window covers this check right now.
 *
 * @param target the check
 * @param now the moment to test
 * @returns true if the check is in maintenance
 */
export async function isInMaintenance(target: Target, now = new Date()): Promise<boolean> {
  const { rows, groupChecks } = await activeWindows();
  return rows.some((w) => windowAppliesTo(w, target, groupChecks) && windowIsActive(w, now));
}
