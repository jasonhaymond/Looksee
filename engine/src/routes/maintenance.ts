import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { maintenanceWindows } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { invalidateMaintenanceCache, windowIsActive } from "../services/maintenance.js";

export const maintenanceRouter = Router();
maintenanceRouter.use(requireAuth);

const SCOPES = new Set(["all", "endpoint", "host", "check"]);

function parse(body: Record<string, unknown>): { values?: Partial<typeof maintenanceWindows.$inferInsert>; error?: string } {
  const values: Partial<typeof maintenanceWindows.$inferInsert> = {};
  if (body.name !== undefined) values.name = String(body.name).trim();
  if (body.scope !== undefined) {
    if (!SCOPES.has(String(body.scope))) return { error: "scope must be all, endpoint, host, or check" };
    values.scope = String(body.scope);
  }
  if (body.targetIds !== undefined) values.targetIds = Array.isArray(body.targetIds) ? body.targetIds.map(String) : [];
  if (body.enabled !== undefined) values.enabled = Boolean(body.enabled);
  if (body.startsAt !== undefined) values.startsAt = body.startsAt ? new Date(String(body.startsAt)) : null;
  if (body.endsAt !== undefined) values.endsAt = body.endsAt ? new Date(String(body.endsAt)) : null;
  if (body.daysOfWeek !== undefined) values.daysOfWeek = Array.isArray(body.daysOfWeek) ? body.daysOfWeek.map(Number).filter((d) => d >= 0 && d <= 6) : null;
  if (body.startTime !== undefined) {
    if (body.startTime && !/^\d{1,2}:\d{2}$/.test(String(body.startTime))) return { error: "startTime must be HH:MM" };
    values.startTime = body.startTime ? String(body.startTime) : null;
  }
  if (body.durationMinutes !== undefined) values.durationMinutes = body.durationMinutes ? Math.max(1, Number(body.durationMinutes)) : null;
  if (values.startsAt && values.endsAt && values.endsAt <= values.startsAt) return { error: "endsAt must be after startsAt" };
  return { values };
}

maintenanceRouter.get("/", async (_req, res) => {
  const rows = await db.query.maintenanceWindows.findMany({ orderBy: desc(maintenanceWindows.createdAt) });
  res.json(rows.map((w) => ({ ...w, active: windowIsActive(w) })));
});

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

// Ends a running one-off window now rather than deleting its record.
maintenanceRouter.post("/:id/end", async (req, res) => {
  const [row] = await db.update(maintenanceWindows).set({ endsAt: new Date(), enabled: false }).where(eq(maintenanceWindows.id, req.params.id)).returning();
  invalidateMaintenanceCache();
  res.json(row ?? null);
});

maintenanceRouter.delete("/:id", async (req, res) => {
  await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, req.params.id));
  invalidateMaintenanceCache();
  res.status(204).end();
});
