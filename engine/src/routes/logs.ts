import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { logs, logLevel } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const logsRouter = Router();
logsRouter.use(requireAuth);

const VALID_LEVELS = logLevel.enumValues;

logsRouter.get("/", async (req, res) => {
  const level = typeof req.query.level === "string" ? req.query.level : undefined;
  if (level && !(VALID_LEVELS as readonly string[]).includes(level)) {
    res.status(400).json({ error: `level must be one of ${VALID_LEVELS.join(", ")}` });
    return;
  }
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  const rows = await db.query.logs.findMany({
    where: level ? eq(logs.level, level as (typeof VALID_LEVELS)[number]) : undefined,
    orderBy: desc(logs.createdAt),
    limit,
  });
  res.json(rows);
});
