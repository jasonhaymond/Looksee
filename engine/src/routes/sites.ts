import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { sites, endpoints, checks, locations, maintenanceWindows } from "../db/schema.js";
import { invalidateMaintenanceCache } from "../services/maintenance.js";
import { invalidateSiteIpCache } from "../services/receivers/index.js";
import { requireAuth } from "../middleware/auth.js";

export const sitesRouter = Router();
sitesRouter.use(requireAuth);

sitesRouter.get("/", async (_req, res) => {
  res.json(await db.query.sites.findMany({ orderBy: (e, { asc }) => asc(e.name) }));
});

sitesRouter.post("/", async (req, res) => {
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
  const [endpoint] = await db.insert(sites).values({ name, description, ...site }).returning();
  res.status(201).json(endpoint);
});

const IP_RE = /^(\d{1,3}(\.\d{1,3}){3}|[0-9a-f:]+)$/i;

// Shared by create and update: the site collector and the site's public IPs.
async function siteFields(body: Record<string, unknown> | undefined): Promise<{ error: string } | Partial<typeof sites.$inferInsert>> {
  const out: Partial<typeof sites.$inferInsert> = {};
  if (body?.collectorEndpointId !== undefined) {
    const endpointId = body.collectorEndpointId ? String(body.collectorEndpointId) : null;
    if (endpointId) {
      const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) });
      if (!host?.agentApiKey) return { error: "The site collector must be a host with an agent installed" };
    }
    out.collectorEndpointId = endpointId;
  }
  if (body?.locationId !== undefined) {
    const locationId = body.locationId ? String(body.locationId) : null;
    if (locationId && !(await db.query.locations.findFirst({ where: eq(locations.id, locationId) }))) return { error: "locationId not found" };
    out.locationId = locationId;
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

sitesRouter.patch("/:id", async (req, res) => {
  const site = await siteFields(req.body);
  if ("error" in site) {
    res.status(400).json(site);
    return;
  }
  const updates: Partial<typeof sites.$inferInsert> = { ...site };
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.description !== undefined) updates.description = req.body.description ? String(req.body.description) : null;
  invalidateSiteIpCache();
  const [endpoint] = await db.update(sites).set(updates).where(eq(sites.id, req.params.id)).returning();
  if (!endpoint) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json(endpoint);
});

sitesRouter.delete("/:id", async (req, res) => {
  await db.delete(sites).where(eq(sites.id, req.params.id));
  res.status(204).end();
});

// Multi-select actions from the sites list. "merge" moves every host
// and check into the target endpoint, then deletes the emptied ones.
sitesRouter.post("/bulk", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const action = String(req.body?.action ?? "");
  if (!ids.length) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  let affected = 0;
  switch (action) {
    case "delete":
      affected = (await db.delete(sites).where(inArray(sites.id, ids)).returning({ id: sites.id })).length;
      break;
    case "merge": {
      const targetId = String(req.body?.targetId ?? "");
      if (!targetId || ids.includes(targetId) || !(await db.query.sites.findFirst({ where: eq(sites.id, targetId) }))) {
        res.status(400).json({ error: "targetId must be an existing endpoint that isn't one of the ones being merged" });
        return;
      }
      await db.update(endpoints).set({ siteId: targetId }).where(inArray(endpoints.siteId, ids));
      await db.update(checks).set({ siteId: targetId }).where(inArray(checks.siteId, ids));
      affected = (await db.delete(sites).where(inArray(sites.id, ids)).returning({ id: sites.id })).length;
      break;
    }
    case "enable_checks":
    case "disable_checks":
      affected = (await db.update(checks).set({ enabled: action === "enable_checks" }).where(inArray(checks.siteId, ids)).returning({ id: checks.id })).length;
      break;
    case "set_location": {
      const locationId = req.body?.locationId ? String(req.body.locationId) : null;
      if (locationId && !(await db.query.locations.findFirst({ where: eq(locations.id, locationId) }))) {
        res.status(400).json({ error: "locationId not found" });
        return;
      }
      affected = (await db.update(sites).set({ locationId }).where(inArray(sites.id, ids)).returning({ id: sites.id })).length;
      break;
    }
    case "maintenance": {
      const minutes = Math.max(1, Number(req.body?.minutes) || 60);
      const now = new Date();
      await db.insert(maintenanceWindows).values({ name: String(req.body?.name || `Maintenance for ${ids.length} endpoint(s)`), scope: "site", targetIds: ids, startsAt: now, endsAt: new Date(now.getTime() + minutes * 60_000) });
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
