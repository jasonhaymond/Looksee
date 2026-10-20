// API routes for maintenance windows: /api/maintenance (list, create, edit,
// end early, delete).
//
// Where this sits: called by the dashboard's Maintenance page (and the
// "maintenance for N minutes" shortcut on locations, which lives in
// routes/locations.ts). Rows go into the `maintenance_windows` table; whether
// a window is in effect is worked out by services/maintenance.ts, whose cache
// is cleared after every write here so changes apply immediately.
//
// Security: every route requires a signed-in session (requireAuth below). A
// router is Express's way of grouping routes under one path prefix; `use`
// runs a function (middleware) before each of them.

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { maintenanceWindows } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { invalidateMaintenanceCache, windowIsActive } from "../services/maintenance.js";
import { isValidTimeZone } from "../lib/timeZone.js";

export const maintenanceRouter = Router();
// Without this, anyone who can reach the server could pause alerting for
// every check by creating a window.
maintenanceRouter.use(requireAuth);

// What a window can be limited to; see windowAppliesTo in services/maintenance.ts.
const SCOPES = new Set(["all", "site", "endpoint", "check", "group"]);

/**
 * Validates a create/edit request body and converts it to column values.
 * Only fields present in the body are returned, so the same function serves
 * both create (all fields) and edit (just the changed ones).
 *
 * @param body the JSON request body
 * @returns `values` to write, or `error` (a message for a 400 response)
 */
function parse(body: Record<string, unknown>): { values?: Partial<typeof maintenanceWindows.$inferInsert>; error?: string } {
  const values: Partial<typeof maintenanceWindows.$inferInsert> = {};
  if (body.name !== undefined) values.name = String(body.name).trim();
  if (body.scope !== undefined) {
    if (!SCOPES.has(String(body.scope))) return { error: "scope must be all, site, endpoint, check or group" };
    values.scope = String(body.scope);
  }
  if (body.targetIds !== undefined) values.targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String) : [];
  if (body.enabled !== undefined) values.enabled = Boolean(body.enabled);
  // One-off windows: ISO timestamps from the browser, which already carry the
  // browser's offset, so they're stored as the exact instants the admin meant.
  if (body.startsAt !== undefined) values.startsAt = body.startsAt ? new Date(String(body.startsAt)) : null;
  if (body.endsAt !== undefined) values.endsAt = body.endsAt ? new Date(String(body.endsAt)) : null;
  // Weekly windows: day numbers 0 (Sunday) to 6 (Saturday); anything else is dropped.
  if (body.daysOfWeek !== undefined) values.daysOfWeek = Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number).filter((d) => d >= 0 && d <= 6) : null;
  if (body.startTime !== undefined) {
    // The regex accepts "H:MM" or "HH:MM", e.g. "2:30" or "02:30".
    if (body.startTime && !/^\d{1,2}:\d{2}$/.test(String(body.startTime))) return { error: "startTime must be HH:MM" };
    values.startTime = body.startTime ? String(body.startTime) : null;
  }
  if (body.durationMinutes !== undefined) values.durationMinutes = body.durationMinutes ? Math.max(1, Number(body.durationMinutes)) : null;
  // The zone a weekly window's start time is read in. Checked against the
  // zones this server knows, so a typo can't silently shift the window.
  if (body.timeZone !== undefined) {
    if (body.timeZone !== null && !isValidTimeZone(body.timeZone)) return { error: `Unknown time zone "${String(body.timeZone).slice(0, 64)}"` };
    values.timeZone = (body.timeZone as string | null) ?? null;
  }
  if (values.startsAt && values.endsAt && values.endsAt <= values.startsAt) return { error: "endsAt must be after startsAt" };
  return { values };
}

// GET /api/maintenance — every window, newest first, each with `active`
// (whether it's in effect right now) worked out for the list's status badge.
maintenanceRouter.get("/", async (_req, res) => {
  const rows = await db.query.maintenanceWindows.findMany({ orderBy: desc(maintenanceWindows.createdAt) });
  res.json(rows.map((w) => ({ ...w, active: windowIsActive(w) })));
});

// POST /api/maintenance — create a window. Needs a name and either a
// complete one-off range or a complete weekly schedule.
maintenanceRouter.post("/", async (req, res) => {
  const { values, error } = parse(req.body ?? {});
  if (error || !values?.name) {
    res.status(400).json({ error: error ?? "name is required" });
    return;
  }
  const oneOff = values.startsAt && values.endsAt;
  const weekly = values.daysOfWeek?.length && values.startTime && values.durationMinutes;
  if (!oneOff && !weekly) {
    res.status(400).json({ error: "Give either startsAt + endsAt, or daysOfWeek + startTime + durationMinutes" });
    return;
  }
  const [row] = await db.insert(maintenanceWindows).values(values as typeof maintenanceWindows.$inferInsert).returning();
  invalidateMaintenanceCache();
  res.status(201).json({ ...row, active: windowIsActive(row) });
});

// PATCH /api/maintenance/:id — change some fields of a window.
maintenanceRouter.patch("/:id", async (req, res) => {
  const { values, error } = parse(req.body ?? {});
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [row] = await db.update(maintenanceWindows).set(values!).where(eq(maintenanceWindows.id, req.params.id)).returning();
  if (!row) {
    res.status(404).json({ error: "Maintenance window not found" });
    return;
  }
  invalidateMaintenanceCache();
  res.json({ ...row, active: windowIsActive(row) });
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
