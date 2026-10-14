// Time-zone helpers for the few places the engine has to think in a calendar
// rather than in absolute instants.
//
// Where this sits: the engine stores and compares every timestamp in UTC,
// which needs no time zone at all. Two features do need one, because they are
// defined by a wall clock: a weekly maintenance window ("every Sunday at
// 02:00" means 02:00 where the person who set it lives — see
// services/maintenance.ts), and a public status page's daily uptime bars
// (where "a day" starts at the viewer's midnight — see routes/public.ts).
// Zone names are IANA names such as "America/Los_Angeles", sent by the
// dashboard from the browser.
//
// Security note: a zone name arrives from the browser (and, for status
// pages, from anonymous visitors), so it is always checked with
// `isValidTimeZone` before use. Zone names never reach SQL: all calendar
// arithmetic happens here in Node, and only absolute instants are sent to
// the database.

/**
 * Whether a string is a time zone name this server understands. Node's
 * built-in `Intl` (internationalization API) throws a RangeError for an
 * unknown zone, which is used here as the test.
 *
 * @param tz a candidate zone name, e.g. "Europe/Berlin"
 * @returns true for a known IANA zone (or "UTC"), false for anything else
 */
export function isValidTimeZone(tz: unknown): tz is string {
  // Length cap: real zone names are short; refuse anything that isn't.
  if (typeof tz !== "string" || !tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * The engine machine's own zone, used for maintenance windows saved before
 * windows remembered a zone (they always ran in this zone).
 *
 * @returns e.g. "Etc/UTC" or "America/Chicago"
 */
export function serverTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// Maps Intl's short weekday names to JavaScript's day numbers (Sunday = 0),
// the numbering maintenance windows store in daysOfWeek.
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * What a wall clock in a given zone reads at a given instant.
 *
 * @param at the instant to look at
 * @param tz a zone name already checked with isValidTimeZone
 * @returns the calendar date ("YYYY-MM-DD"), the day of the week (0 = Sunday)
 *          and the minutes since that local midnight (0–1439)
 */
export function wallClock(at: Date, tz: string): { date: string; weekday: number; minuteOfDay: number } {
  // formatToParts splits a formatted date into labeled pieces ({type: "hour",
  // value: "14"}, ...), so nothing depends on how a locale orders them.
  // hourCycle "h23" gives 00–23 rather than 1–12 AM/PM.
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(at);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    weekday: WEEKDAY[get("weekday")] ?? 0,
    minuteOfDay: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/**
 * The instant a calendar date begins in a zone — its local midnight, as an
 * absolute time. Worked out in Node rather than in Postgres because the two
 * carry different zone databases: browsers still report legacy names such as
 * "Asia/Calcutta" or "Europe/Kiev", which Node accepts but some Postgres
 * builds reject.
 *
 * Method: start from midnight UTC on that date, see what the zone's clock
 * reads then, and shift by the difference; a second pass corrects for an
 * offset that changed in between (daylight saving). In the rare zone where
 * midnight itself is skipped by a clock change, this lands on the first
 * moment that day exists, which is the right boundary anyway.
 *
 * @param date a calendar date, "YYYY-MM-DD"
 * @param tz a zone name already checked with isValidTimeZone
 * @returns the instant that date's local midnight happens
 */
export function localMidnight(date: string, tz: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const target = Date.UTC(y, m - 1, d);
  let t = target;
  for (let pass = 0; pass < 2; pass++) {
    const clock = wallClock(new Date(t), tz);
    const [cy, cm, cd] = clock.date.split("-").map(Number);
    // What the zone's clock shows at instant t, expressed as if it were UTC.
    const shown = Date.UTC(cy, cm - 1, cd) + clock.minuteOfDay * 60_000;
    // Move t by however far the shown time is from the midnight we want.
    t += target - shown;
  }
  return new Date(t);
}

/**
 * The last `count` calendar dates in a zone, oldest first, ending today —
 * the x-axis of a status page's daily uptime bars.
 *
 * Steps through the calendar rather than subtracting 24 hours at a time, so a
 * daylight-saving change (a 23- or 25-hour day) can't skip or repeat a date.
 *
 * @param count how many days, e.g. 90
 * @param tz a zone name already checked with isValidTimeZone
 * @param now the current instant (a parameter so tests can fix it)
 * @returns dates as "YYYY-MM-DD" strings
 */
export function recentDates(count: number, tz: string, now = new Date()): string[] {
  const [y, m, d] = wallClock(now, tz).date.split("-").map(Number);
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    // Date.UTC handles month/year rollover (day 0 = last day of the previous
    // month); UTC is used only as plain calendar arithmetic here.
    out.push(new Date(Date.UTC(y, m - 1, d - i)).toISOString().slice(0, 10));
  }
  return out;
}
