// API routes for locations (places that group sites): list, create, rename,
// delete, and "maintenance for N minutes" for everything at a location.
//
// Security: every route requires a signed-in session.

import { Router } from "express";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, sites, locations, maintenanceWindows } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { invalidateMaintenanceCache } from "../services/maintenance.js";

// Locations group sites (networks) by physical place. Hosts and checks
// belong to a location through their endpoint, so there's nothing to keep
// in sync below this level.
export const locationsRouter = Router();
locationsRouter.use(requireAuth);

const text = (v: unknown) => (v === undefined ? undefined : v ? String(v).trim() || null : null);

locationsRouter.get("/", async (_req, res) => {
  res.json(await db.query.locations.findMany({ orderBy: (l, { asc }) => asc(l.name) }));
});

locationsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const [location] = await db.insert(locations).values({ name, description: text(req.body?.description) ?? null, address: text(req.body?.address) ?? null }).returning();
  if (Array.isArray(req.body?.siteIds) && req.body.siteIds.length) {
    await db.update(sites).set({ locationId: location.id }).where(inArray(sites.id, req.body.siteIds.map(String)));
  }
  res.status(201).json(location);
});

locationsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof locations.$inferInsert> = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) {
      res.status(400).json({ error: "name can't be empty" });
      return;
    }
    updates.name = name;
  }
  if (req.body?.description !== undefined) updates.description = text(req.body.description);
  if (req.body?.address !== undefined) updates.address = text(req.body.address);
  const [location] = Object.keys(updates).length
    ? await db.update(locations).set(updates).where(eq(locations.id, req.params.id)).returning()
    : await db.select().from(locations).where(eq(locations.id, req.params.id));
  if (!location) {
    res.status(404).json({ error: "Location not found" });
    return;
  }
  // siteIds, when sent, is the complete membership list.
  if (Array.isArray(req.body?.siteIds)) {
    const ids: string[] = req.body.siteIds.map(String);
    await db.update(sites).set({ locationId: null }).where(eq(sites.locationId, location.id));
    if (ids.length) await db.update(sites).set({ locationId: location.id }).where(inArray(sites.id, ids));
  }
  res.json(location);
});

// Deleting a location leaves its sites in place, just unassigned.
locationsRouter.delete("/:id", async (req, res) => {
  await db.delete(locations).where(eq(locations.id, req.params.id));
  res.status(204).end();
});

locationsRouter.post("/:id/maintenance", async (req, res) => {
  const location = await db.query.locations.findFirst({ where: eq(locations.id, req.params.id) });
  if (!location) {
    res.status(404).json({ error: "Location not found" });
    return;
  }
  const eps = await db.query.sites.findMany({ where: eq(sites.locationId, location.id) });
  if (!eps.length) {
    res.status(400).json({ error: "This location has no sites yet" });
    return;
  }
  const minutes = Math.max(1, Number(req.body?.minutes) || 60);
  const now = new Date();
  await db.insert(maintenanceWindows).values({ name: `Maintenance: ${location.name}`, scope: "site", targetIds: eps.map((e) => e.id), startsAt: now, endsAt: new Date(now.getTime() + minutes * 60_000) });
  invalidateMaintenanceCache();
  const affected = await db.select({ id: checks.id }).from(checks).where(inArray(checks.siteId, eps.map((e) => e.id)));
  res.json({ sites: eps.length, checks: affected.length });
});
