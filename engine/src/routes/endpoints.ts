import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { endpoints, hosts, checks, maintenanceWindows } from "../db/schema.js";
import { invalidateMaintenanceCache } from "../services/maintenance.js";
import { invalidateSiteIpCache } from "../services/receivers/index.js";
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
  const site = await siteFields(req.body);
  if ("error" in site) {
    res.status(400).json(site);
    return;
  }
  invalidateSiteIpCache();
  const [endpoint] = await db.insert(endpoints).values({ name, description, ...site }).returning();
  res.status(201).json(endpoint);
});

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;

// Shared by create and update: the site collector and the site's public IPs.
async function siteFields(body: Record<string, unknown> | undefined): Promise<{ error: string } | Partial<typeof endpoints.$inferInsert>> {
  const out: Partial<typeof endpoints.$inferInsert> = {};
  if (body?.collectorHostId !== undefined) {
    const hostId = body.collectorHostId ? String(body.collectorHostId) : null;
    if (hostId) {
      const host = await db.query.hosts.findFirst({ where: eq(hosts.id, hostId) });
      if (!host?.agentApiKey) return { error: "The site collector must be a host with an agent installed" };
    }
    out.collectorHostId = hostId;
  }
  if (body?.publicIps !== undefined) {
    const raw = Array.isArray(body.publicIps) ? body.publicIps : String(body.publicIps ?? "").split(/[\s,]+/);
    const ips = [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
    const bad = ips.find((ip) => !IP_RE.test(ip));
    if (bad) return { error: `"${bad}" isn't an IP address` };
    out.publicIps = ips;
  }
  return out;
}

endpointsRouter.patch("/:id", async (req, res) => {
  const site = await siteFields(req.body);
  if ("error" in site) {
    res.status(400).json(site);
    return;
  }
  const updates: Partial<typeof endpoints.$inferInsert> = { ...site };
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.description !== undefined) updates.description = req.body.description ? String(req.body.description) : null;
  invalidateSiteIpCache();
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
