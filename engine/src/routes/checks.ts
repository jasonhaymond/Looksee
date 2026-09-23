import { Router } from "express";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults, HOST_SCOPED_CHECK_TYPES } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const checksRouter = Router();
checksRouter.use(requireAuth);

const VALID_TYPES = [
  "ping",
  "tcp",
  "http",
  "dns",
  "ssl_cert",
  "agent_service",
  "agent_process",
  "host_cpu",
  "host_memory",
  "host_disk",
  "snmp",
] as const;

checksRouter.get("/", async (req, res) => {
  const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
  const rows = await db.query.checks.findMany({
    where: endpointId ? eq(checks.endpointId, endpointId) : undefined,
    orderBy: (c, { asc }) => asc(c.name),
  });
  res.json(rows);
});

checksRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const endpointId = String(req.body?.endpointId ?? "");
  const type = req.body?.type;
  if (!name || !endpointId || !VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `name, endpointId, and a valid type (${VALID_TYPES.join(", ")}) are required` });
    return;
  }
  const hostId = req.body?.hostId ? String(req.body.hostId) : null;
  // Results for this type only ever arrive via the agent's push, gated on
  // hostId matching a real host (see routes/agent.ts's /config filter) — a
  // null hostId here means the check silently never gets polled by any
  // agent, with no error anywhere. Reject it up front instead.
  if ((HOST_SCOPED_CHECK_TYPES as readonly string[]).includes(type) && !hostId) {
    res.status(400).json({ error: `${type} checks require a hostId` });
    return;
  }
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  const intervalSeconds = Number.isFinite(req.body?.intervalSeconds) ? Number(req.body.intervalSeconds) : 60;

  const [check] = await db
    .insert(checks)
    .values({ name, endpointId, hostId, type, config, intervalSeconds })
    .returning();
  res.status(201).json(check);
});

checksRouter.patch("/:id", async (req, res) => {
  const existing = await db.query.checks.findFirst({ where: eq(checks.id, req.params.id) });
  if (!existing) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  const updates: Partial<typeof checks.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.hostId !== undefined) updates.hostId = req.body.hostId ? String(req.body.hostId) : null;
  if (req.body?.config !== undefined) updates.config = req.body.config;
  if (req.body?.intervalSeconds !== undefined) updates.intervalSeconds = Number(req.body.intervalSeconds);
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  const nextHostId = "hostId" in updates ? updates.hostId : existing.hostId;
  if ((HOST_SCOPED_CHECK_TYPES as readonly string[]).includes(existing.type) && !nextHostId) {
    res.status(400).json({ error: `${existing.type} checks require a hostId` });
    return;
  }
  const [check] = await db.update(checks).set(updates).where(eq(checks.id, req.params.id)).returning();
  res.json(check);
});

checksRouter.delete("/:id", async (req, res) => {
  await db.delete(checks).where(eq(checks.id, req.params.id));
  res.status(204).end();
});

// Recent result history for one check, used by the dashboard's uptime %/
// latency-sparkline widgets. `since` (ISO timestamp) narrows to a time
// window; `limit` stays in effect as a safety ceiling even within a
// window, not just as the old "last N" default when since is omitted.
checksRouter.get("/:id/results", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 2000);
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const validSince = since && !Number.isNaN(since.getTime()) ? since : undefined;
  const rows = await db.query.checkResults.findMany({
    where: validSince ? and(eq(checkResults.checkId, req.params.id), gte(checkResults.checkedAt, validSince)) : eq(checkResults.checkId, req.params.id),
    orderBy: desc(checkResults.checkedAt),
    limit,
  });
  res.json(rows);
});
