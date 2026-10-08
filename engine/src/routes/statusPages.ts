import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { statusPages } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const statusPagesRouter = Router();
statusPagesRouter.use(requireAuth);

const slugify = (s: string) =>
  s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

statusPagesRouter.get("/", async (_req, res) => {
  res.json(await db.query.statusPages.findMany({ orderBy: asc(statusPages.title) }));
});

statusPagesRouter.post("/", async (req, res) => {
  const title = String(req.body?.title ?? "").trim();
  const slug = slugify(String(req.body?.slug || title));
  if (!title || !slug) {
    res.status(400).json({ error: "title is required" });
    return;
  }
  if (await db.query.statusPages.findFirst({ where: eq(statusPages.slug, slug) })) {
    res.status(409).json({ error: `A status page already uses /status/${slug}` });
    return;
  }
  const [row] = await db
    .insert(statusPages)
    .values({ title, slug, description: req.body?.description ? String(req.body.description) : null, checkIds: Array.isArray(req.body?.checkIds) ? req.body.checkIds.map(String) : [], published: req.body?.published !== false })
    .returning();
  res.status(201).json(row);
});

statusPagesRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof statusPages.$inferInsert> = {};
  if (req.body?.title !== undefined) updates.title = String(req.body.title).trim();
  if (req.body?.slug !== undefined) updates.slug = slugify(String(req.body.slug));
  if (req.body?.description !== undefined) updates.description = req.body.description ? String(req.body.description) : null;
  if (Array.isArray(req.body?.checkIds)) updates.checkIds = req.body.checkIds.map(String);
  if (req.body?.published !== undefined) updates.published = Boolean(req.body.published);
  try {
    const [row] = await db.update(statusPages).set(updates).where(eq(statusPages.id, req.params.id)).returning();
    if (!row) {
      res.status(404).json({ error: "Status page not found" });
      return;
    }
    res.json(row);
  } catch {
    res.status(409).json({ error: "That slug is already in use" });
  }
});

statusPagesRouter.delete("/:id", async (req, res) => {
  await db.delete(statusPages).where(eq(statusPages.id, req.params.id));
  res.status(204).end();
});
