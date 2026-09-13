import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const checksRouter = Router();
checksRouter.use(requireAuth);

const VALID_TYPES = ["ping", "tcp", "http", "dns", "ssl_cert", "agent_service"] as const;

checksRouter.get("/", async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const rows = await db.query.checks.findMany({
    where: siteId ? eq(checks.siteId, siteId) : undefined,
    orderBy: (c, { asc }) => asc(c.name),
  });
  res.json(rows);
});

checksRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const siteId = String(req.body?.siteId ?? "");
  const type = req.body?.type;
  if (!name || !siteId || !VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `name, siteId, and a valid type (${VALID_TYPES.join(", ")}) are required` });
    return;
  }
  const hostId = req.body?.hostId ? String(req.body.hostId) : null;
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  const intervalSeconds = Number.isFinite(req.body?.intervalSeconds) ? Number(req.body.intervalSeconds) : 60;

  const [check] = await db
    .insert(checks)
    .values({ name, siteId, hostId, type, config, intervalSeconds })
    .returning();
  res.status(201).json(check);
});

checksRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof checks.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.config !== undefined) updates.config = req.body.config;
  if (req.body?.intervalSeconds !== undefined) updates.intervalSeconds = Number(req.body.intervalSeconds);
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  const [check] = await db.update(checks).set(updates).where(eq(checks.id, req.params.id)).returning();
  if (!check) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  res.json(check);
});

checksRouter.delete("/:id", async (req, res) => {
  await db.delete(checks).where(eq(checks.id, req.params.id));
  res.status(204).end();
});

// Recent result history for one check, used by the dashboard's uptime %/
// latency-sparkline widgets.
checksRouter.get("/:id/results", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = await db.query.checkResults.findMany({
    where: eq(checkResults.checkId, req.params.id),
    orderBy: desc(checkResults.checkedAt),
    limit,
  });
  res.json(rows);
});
