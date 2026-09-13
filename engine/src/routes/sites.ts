import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { sites } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const sitesRouter = Router();
sitesRouter.use(requireAuth);

sitesRouter.get("/", async (_req, res) => {
  res.json(await db.query.sites.findMany({ orderBy: (s, { asc }) => asc(s.name) }));
});

sitesRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const description = req.body?.description ? String(req.body.description) : null;
  const [site] = await db.insert(sites).values({ name, description }).returning();
  res.status(201).json(site);
});

sitesRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof sites.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.description !== undefined) updates.description = req.body.description ? String(req.body.description) : null;
  const [site] = await db.update(sites).set(updates).where(eq(sites.id, req.params.id)).returning();
  if (!site) {
    res.status(404).json({ error: "Site not found" });
    return;
  }
  res.json(site);
});

sitesRouter.delete("/:id", async (req, res) => {
  await db.delete(sites).where(eq(sites.id, req.params.id));
  res.status(204).end();
});
