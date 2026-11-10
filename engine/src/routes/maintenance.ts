// API routes for maintenance windows: /api/maintenance (list, create, edit,
// end early, delete).
//
// Where this sits: called by the dashboard's Maintenance page (create and
// edit use the same dialog) and by the "maintenance for N minutes" shortcuts
// on groups, multi-selections and locations (the location one lives in
// routes/locations.ts). Rows go into the `maintenance_windows` table; whether
// a window is in effect is worked out by services/maintenance.ts, whose cache
// is cleared after every write here so changes apply immediately.
//
// Security: every route requires a signed-in session (requireAuth below). A
// router is Express's way of grouping routes under one path prefix; `use`
// runs a function (middleware) before each of them. Every field is
// validated before it is stored, so a malformed window can't be saved that
// would either never end or break the maintenance check that every result
// passes through.

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { maintenanceWindows } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { invalidateMaintenanceCache, nextStart, recurrenceOf, RECURRENCES, windowIsActive } from "../services/maintenance.js";
import { isValidTimeZone } from "../lib/timeZone.js";

export const maintenanceRouter = Router();
// Without this, anyone who can reach the server could pause alerting for
// every check by creating a window.
maintenanceRouter.use(requireAuth);

type Row = typeof maintenanceWindows.$inferSelect;
type Values = Partial<typeof maintenanceWindows.$inferInsert>;

// What a window can be limited to; see windowAppliesTo in services/maintenance.ts.
const SCOPES = new Set(["all", "site", "endpoint", "check", "group"]);
// Longest single occurrence: 31 days. Longer quiet periods are a one-off
// window (or turning checks off), not a repeating one.
const MAX_DURATION = 31 * 1440;
// The fields that make up a repeating schedule; cleared when a window is
// changed to one-off, so stale values can't linger.
const RECURRING_FIELDS: Values = { recurrence: null, repeatEvery: 1, daysOfWeek: null, dayOfMonth: null, weekOfMonth: null, startTime: null, durationMinutes: null, startDate: null, endDate: null };

/**
 * Whether a string is a real calendar date "YYYY-MM-DD" (the regex matches
 * e.g. "2026-11-09"; the round trip through Date rejects "2026-02-30").
 */
function isDate(v: unknown): v is string {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/**
 * Reads an optional timestamp.
 *
 * @returns the instant, null for empty/null, or undefined if unparseable
 */
function instant(v: unknown): Date | null | undefined {
  if (!v) return null;
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/**
 * Reads an optional whole number within a range.
 *
 * @returns the number, null for empty/null, or undefined if invalid
 */
function intIn(v: unknown, min: number, max: number, alsoAllow?: number): number | null | undefined {
  if (v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isInteger(n)) return undefined;
  if (n === alsoAllow) return n;
  return n >= min && n <= max ? n : undefined;
}

/**
 * Validates a create/edit request body and converts it to column values.
 * Only fields present in the body are returned, so the same function serves
 * both create (all fields) and edit (just the changed ones). Whether the
 * result is a complete schedule is checked separately by `incomplete`.
 *
 * @param body the JSON request body
 * @returns `values` to write, or `error` (a message for a 400 response)
 */
function parse(body: Record<string, unknown>): { values?: Values; error?: string } {
  const values: Values = {};
  if (body.name !== undefined) values.name = String(body.name).trim().slice(0, 200);
  if (body.scope !== undefined) {
    if (!SCOPES.has(String(body.scope))) return { error: "scope must be all, site, endpoint, check or group" };
    values.scope = String(body.scope);
  }
  if (body.targetIds !== undefined) values.targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String) : [];
  if (body.enabled !== undefined) values.enabled = Boolean(body.enabled);
  // One-off windows: ISO timestamps from the browser, which already carry an
  // offset (the browser's, or Z for UTC), so they're stored as the exact
  // instants the admin meant.
  if (body.startsAt !== undefined) {
    const d = instant(body.startsAt);
    if (d === undefined) return { error: "startsAt is not a valid date and time" };
    values.startsAt = d;
  }
  if (body.endsAt !== undefined) {
    const d = instant(body.endsAt);
    if (d === undefined) return { error: "endsAt is not a valid date and time" };
    values.endsAt = d;
  }
  if (body.recurrence !== undefined) {
    if (body.recurrence !== null && !(RECURRENCES as readonly string[]).includes(String(body.recurrence))) return { error: `recurrence must be one of ${RECURRENCES.join(", ")}` };
    values.recurrence = (body.recurrence as string | null) ?? null;
  }
  if (body.repeatEvery !== undefined) {
    const n = intIn(body.repeatEvery, 1, 99);
    if (n === undefined) return { error: "repeatEvery must be a whole number from 1 to 99" };
    values.repeatEvery = n ?? 1;
  }
  // Day numbers 0 (Sunday) to 6 (Saturday); anything else is dropped, and
  // repeats are removed.
  if (body.daysOfWeek !== undefined) values.daysOfWeek = Array.isArray(body.daysOfWeek) ? [...new Set(body.daysOfWeek.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))].sort() : null;
  if (body.dayOfMonth !== undefined) {
    const n = intIn(body.dayOfMonth, 1, 31, -1);
    if (n === undefined) return { error: "dayOfMonth must be 1 to 31, or -1 for the last day" };
    values.dayOfMonth = n;
  }
  if (body.weekOfMonth !== undefined) {
    const n = intIn(body.weekOfMonth, 1, 4, -1);
    if (n === undefined) return { error: "weekOfMonth must be 1 to 4, or -1 for the last" };
    values.weekOfMonth = n;
  }
  if (body.startTime !== undefined) {
    // The regex accepts "H:MM" or "HH:MM" from 0:00 to 23:59, e.g. "2:30" or "02:30".
    if (body.startTime && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(body.startTime))) return { error: "startTime must be HH:MM (00:00 to 23:59)" };
    values.startTime = body.startTime ? String(body.startTime) : null;
  }
  if (body.durationMinutes !== undefined) {
    const n = intIn(body.durationMinutes, 1, MAX_DURATION);
    if (n === undefined) return { error: `durationMinutes must be a whole number from 1 to ${MAX_DURATION} (31 days)` };
    values.durationMinutes = n;
  }
  if (body.startDate !== undefined) {
    if (body.startDate && !isDate(body.startDate)) return { error: "startDate must be a date, YYYY-MM-DD" };
    values.startDate = (body.startDate as string) || null;
  }
  if (body.endDate !== undefined) {
    if (body.endDate && !isDate(body.endDate)) return { error: "endDate must be a date, YYYY-MM-DD" };
    values.endDate = (body.endDate as string) || null;
  }
  // The zone the window's times are read in (repeating) or were entered in
  // (one-off). Checked against the zones this server knows, so a typo can't
  // silently shift the window.
  if (body.timeZone !== undefined) {
    if (body.timeZone !== null && !isValidTimeZone(body.timeZone)) return { error: `Unknown time zone "${String(body.timeZone).slice(0, 64)}"` };
    values.timeZone = (body.timeZone as string | null) ?? null;
  }
  return { values };
}

/**
 * Checks that a window, as it will be stored, is a complete schedule.
 *
 * @param w the merged values (for an edit: the stored row plus the changes)
 * @returns an error message, or null if the window is complete
 */
function incomplete(w: Values): string | null {
  if (!w.name) return "name is required";
  if (w.scope && w.scope !== "all" && !w.targetIds?.length) return "Choose at least one target, or apply the window to everything";
  const rec = recurrenceOf({ recurrence: w.recurrence, daysOfWeek: w.daysOfWeek ?? null });
  if (!rec) {
    if (!w.startsAt || !w.endsAt) return "Give either startsAt + endsAt, or a repeating schedule (recurrence + startTime + durationMinutes)";
    if (w.endsAt <= w.startsAt) return "endsAt must be after startsAt";
    return null;
  }
  if (!w.startTime || !w.durationMinutes) return "A repeating window needs a startTime and durationMinutes";
  if ((rec === "weekly" || rec === "monthly_weekday") && !w.daysOfWeek?.length) return "Choose at least one day of the week";
  if (rec === "monthly_day" && !w.dayOfMonth) return "Choose a day of the month";
  if (rec === "monthly_weekday" && !w.weekOfMonth) return "Choose which week of the month";
  // "Every N" needs a day to count from.
  if ((w.repeatEvery ?? 1) > 1 && !w.startDate) return "A start date is needed to repeat every 2 or more";
  if (w.startDate && w.endDate && w.endDate < w.startDate) return "endDate can't be before startDate";
  return null;
}

/**
 * Makes a window one kind or the other: a one-off has no repeat fields, a
 * repeating window has no start/end instants. Without this, switching a
 * window's kind in the edit dialog could leave both sets of fields stored,
 * and the one-off fields would win (see windowIsActive).
 *
 * @param values the changes about to be written (modified in place)
 */
function settleKind(values: Values) {
  if (values.recurrence || values.daysOfWeek?.length) {
    // Becoming (or staying) repeating: drop any one-off instants. A window
    // given days of the week but no repeat type is weekly, as before 5.6.
    values.startsAt = null;
    values.endsAt = null;
    if (!values.recurrence) values.recurrence = "weekly";
  } else if (values.startsAt && values.endsAt) {
    Object.assign(values, RECURRING_FIELDS);
  }
}

/** A row as the API returns it: plus whether it's running and when it next starts. */
const present = (row: Row) => ({ ...row, active: windowIsActive(row), next: nextStart(row)?.toISOString() ?? null });

// GET /api/maintenance — every window, newest first, each with `active`
// (whether it's in effect right now) and `next` (its next start).
maintenanceRouter.get("/", async (_req, res) => {
  const rows = await db.query.maintenanceWindows.findMany({ orderBy: desc(maintenanceWindows.createdAt) });
  res.json(rows.map(present));
});

// POST /api/maintenance — create a window. Needs a name and either a
// complete one-off range or a complete repeating schedule.
maintenanceRouter.post("/", async (req, res) => {
  const { values, error } = parse(req.body ?? {});
  if (error || !values) {
    res.status(400).json({ error });
    return;
  }
  settleKind(values);
  const problem = incomplete(values);
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const [row] = await db.insert(maintenanceWindows).values(values as typeof maintenanceWindows.$inferInsert).returning();
  invalidateMaintenanceCache();
  res.status(201).json(present(row));
});

// PATCH /api/maintenance/:id — change some or all fields of a window (the
// Maintenance page's Edit dialog sends them all). The result must still be a
// complete schedule.
maintenanceRouter.patch("/:id", async (req, res) => {
  const { values, error } = parse(req.body ?? {});
  if (error || !values) {
    res.status(400).json({ error });
    return;
  }
  const existing = await db.query.maintenanceWindows.findFirst({ where: eq(maintenanceWindows.id, req.params.id) });
  if (!existing) {
    res.status(404).json({ error: "Maintenance window not found" });
    return;
  }
  // Only settle the kind when this edit touches the schedule — turning a
  // window on or off, or renaming it, leaves its schedule as it is.
  if (["startsAt", "endsAt", "recurrence", "daysOfWeek"].some((k) => k in values)) settleKind(values);
  const problem = incomplete({ ...existing, ...values });
  if (problem) {
    res.status(400).json({ error: problem });
    return;
  }
  const [row] = await db.update(maintenanceWindows).set(values).where(eq(maintenanceWindows.id, req.params.id)).returning();
  invalidateMaintenanceCache();
  res.json(present(row));
});

// POST /api/maintenance/:id/end — ends a running one-off window now (and
// disables it) rather than deleting its record, so it stays in the list.
maintenanceRouter.post("/:id/end", async (req, res) => {
  const [row] = await db.update(maintenanceWindows).set({ endsAt: new Date(), enabled: false }).where(eq(maintenanceWindows.id, req.params.id)).returning();
  invalidateMaintenanceCache();
  res.json(row ?? null);
});

// DELETE /api/maintenance/:id — removes a window entirely.
maintenanceRouter.delete("/:id", async (req, res) => {
  await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, req.params.id));
  invalidateMaintenanceCache();
  res.status(204).end();
});
