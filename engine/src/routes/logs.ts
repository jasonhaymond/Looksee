// API route for the dashboard's Logs page: GET /api/logs returns the engine's
// own activity log (the `logs` table, written by lib/logger.ts), newest first.
//
// Security: requireAuth — only the signed-in admin can read logs, since they
// hold internal detail (error text, endpoint names and addresses). Filters are
// validated before use and passed to the database as parameters, never
// spliced into SQL text.

import { Router } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { logs, logLevel } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const logsRouter = Router();
logsRouter.use(requireAuth);

const VALID_LEVELS = logLevel.enumValues;
// Regex: a UUID in its usual text form, e.g.
// "3f2b8c1e-9a4d-4e7f-8b21-0c5d6e7f8a9b" (hex digits in 8-4-4-4-12 groups).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/logs?level=&limit=&endpointId=
// level: only entries of that level. limit: how many (default 100, max
// 1000). endpointId: only entries about that endpoint — the ones whose
// metadata carries its ID (agent reports, body-size rejections…), which is
// what the Logs page's "only this endpoint" link uses.
logsRouter.get("/", async (req, res) => {
  const level = typeof req.query.level === "string" ? req.query.level : undefined;
  if (level && !(VALID_LEVELS as readonly string[]).includes(level)) {
    res.status(400).json({ error: `level must be one of ${VALID_LEVELS.join(", ")}` });
    return;
  }
  const endpointId = typeof req.query.endpointId === "string" && req.query.endpointId ? req.query.endpointId : undefined;
  if (endpointId && !UUID.test(endpointId)) {
    res.status(400).json({ error: "endpointId must be an endpoint ID" });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = await db.query.logs.findMany({
    where: and(
      level ? eq(logs.level, level as (typeof VALID_LEVELS)[number]) : undefined,
      // jsonb "->>" reads one field of the metadata as text; the ID is
      // sent as a query parameter ($1), not pasted into the SQL.
      endpointId ? sql`${logs.metadata} ->> 'endpointId' = ${endpointId}` : undefined
    ),
    orderBy: desc(logs.createdAt),
    limit,
  });
  res.json(rows);
});
