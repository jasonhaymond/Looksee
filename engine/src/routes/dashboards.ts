import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { dashboards, dashboardWidgets } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const dashboardsRouter = Router();
dashboardsRouter.use(requireAuth);

const VALID_WIDGET_TYPES = ["status_tile", "group_summary", "host_metrics", "uptime_history", "note"] as const;

dashboardsRouter.get("/", async (_req, res) => {
  res.json(await db.query.dashboards.findMany({ orderBy: (d, { asc }) => asc(d.createdAt) }));
});

dashboardsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const [dashboard] = await db.insert(dashboards).values({ name }).returning();
  res.status(201).json(dashboard);
});

dashboardsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof dashboards.$inferInsert> = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    updates.name = name;
  }
  if (req.body?.refreshSeconds !== undefined) {
    const refreshSeconds = Number(req.body.refreshSeconds);
    if (!Number.isInteger(refreshSeconds) || refreshSeconds < 5) {
      res.status(400).json({ error: "refreshSeconds must be an integer of at least 5" });
      return;
    }
    updates.refreshSeconds = refreshSeconds;
  }
  const [dashboard] = await db.update(dashboards).set(updates).where(eq(dashboards.id, req.params.id)).returning();
  if (!dashboard) {
    res.status(404).json({ error: "Dashboard not found" });
    return;
  }
  res.json(dashboard);
});

dashboardsRouter.delete("/:id", async (req, res) => {
  await db.delete(dashboards).where(eq(dashboards.id, req.params.id));
  res.status(204).end();
});

dashboardsRouter.get("/:id/widgets", async (req, res) => {
  res.json(await db.query.dashboardWidgets.findMany({ where: eq(dashboardWidgets.dashboardId, req.params.id) }));
});

dashboardsRouter.post("/:id/widgets", async (req, res) => {
  const type = req.body?.type;
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  if (!VALID_WIDGET_TYPES.includes(type)) {
    res.status(400).json({ error: `type must be one of: ${VALID_WIDGET_TYPES.join(", ")}` });
    return;
  }
  const x = Number.isFinite(req.body?.x) ? Number(req.body.x) : 0;
  const y = Number.isFinite(req.body?.y) ? Number(req.body.y) : 0;
  const w = Number.isFinite(req.body?.w) ? Number(req.body.w) : 4;
  const h = Number.isFinite(req.body?.h) ? Number(req.body.h) : 3;

  const [widget] = await db
    .insert(dashboardWidgets)
    .values({ dashboardId: req.params.id, type, config, x, y, w, h })
    .returning();
  res.status(201).json(widget);
});

// Widget-level updates (position/size from a drag or resize, or a config
// change) are addressed by widget id directly rather than nested under a
// dashboard id — react-grid-layout's onLayoutChange callback only ever
// hands back widget ids, not which dashboard they belong to.
dashboardsRouter.patch("/widgets/:widgetId", async (req, res) => {
  const updates: Partial<typeof dashboardWidgets.$inferInsert> = {};
  for (const key of ["x", "y", "w", "h"] as const) {
    if (Number.isFinite(req.body?.[key])) updates[key] = Number(req.body[key]);
  }
  if (req.body?.config !== undefined) updates.config = req.body.config;
  const [widget] = await db
    .update(dashboardWidgets)
    .set(updates)
    .where(eq(dashboardWidgets.id, req.params.widgetId))
    .returning();
  if (!widget) {
    res.status(404).json({ error: "Widget not found" });
    return;
  }
  res.json(widget);
});

dashboardsRouter.delete("/widgets/:widgetId", async (req, res) => {
  await db.delete(dashboardWidgets).where(eq(dashboardWidgets.id, req.params.widgetId));
  res.status(204).end();
});
