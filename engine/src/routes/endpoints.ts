import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { endpoints } from "../db/schema.js";
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
