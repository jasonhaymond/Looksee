import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { endpoints, hosts, checks, maintenanceWindows } from "../db/schema.js";
import { invalidateMaintenanceCache } from "../services/maintenance.js";
import { requireAuth } from "../middleware/auth.js";

export const endpointsRouter = Router();
endpointsRouter.use(requireAuth);

endpointsRouter.get("/", async (_req, res) => {
  res.json(await db.query.endpoints.findMany({ orderBy: (e, { asc }) => asc(e.name) }));
});

endpointsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const description = req.body?.description ? String(req.body.description) : null;
  const [endpoint] = await db.insert(endpoints).values({ name, description }).returning();
  res.status(201).json(endpoint);
});

endpointsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof endpoints.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.description !== undefined) updates.description = req.body.description ? String(req.body.description) : null;
  const [endpoint] = await db.update(endpoints).set(updates).where(eq(endpoints.id, req.params.id)).returning();
  if (!endpoint) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json(endpoint);
});

endpointsRouter.delete("/:id", async (req, res) => {
  await db.delete(endpoints).where(eq(endpoints.id, req.params.id));
  res.status(204).end();
});

// Multi-select actions from the endpoints list. "merge" moves every host
// and check into the target endpoint, then deletes the emptied ones.
endpointsRouter.post("/bulk", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const action = String(req.body?.action ?? "");
  if (!ids.length) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  let affected = 0;
  switch (action) {
    case "delete":
      affected = (await db.delete(endpoints).where(inArray(endpoints.id, ids)).returning({ id: endpoints.id })).length;
      break;
    case "merge": {
      const targetId = String(req.body?.targetId ?? "");
      if (!targetId || ids.includes(targetId) || !(await db.query.endpoints.findFirst({ where: eq(endpoints.id, targetId) }))) {
        res.status(400).json({ error: "targetId must be an existing endpoint that isn't one of the ones being merged" });
        return;
      }
      await db.update(hosts).set({ endpointId: targetId }).where(inArray(hosts.endpointId, ids));
      await db.update(checks).set({ endpointId: targetId }).where(inArray(checks.endpointId, ids));
      affected = (await db.delete(endpoints).where(inArray(endpoints.id, ids)).returning({ id: endpoints.id })).length;
      break;
    }
    case "enable_checks":
    case "disable_checks":
      affected = (await db.update(checks).set({ enabled: action === "enable_checks" }).where(inArray(checks.endpointId, ids)).returning({ id: checks.id })).length;
      break;
    case "maintenance": {
      const minutes = Math.max(1, Number(req.body?.minutes) || 60);
      const now = new Date();
      await db.insert(maintenanceWindows).values({ name: String(req.body?.name || `Maintenance for ${ids.length} endpoint(s)`), scope: "endpoint", targetIds: ids, startsAt: now, endsAt: new Date(now.getTime() + minutes * 60_000) });
      invalidateMaintenanceCache();
      affected = ids.length;
      break;
    }
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
  }
  res.json({ affected, errors: [] });
});
