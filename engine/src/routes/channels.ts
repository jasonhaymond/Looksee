import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationChannels } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const VALID_TYPES = ["email", "webhook", "web_push", "sms"] as const;

channelsRouter.get("/", async (_req, res) => {
  // config may hold secrets (webhook URLs with tokens, SMS API keys) —
  // write-only from the admin UI once saved, per the security baseline.
  const rows = await db.query.notificationChannels.findMany({ orderBy: (c, { asc }) => asc(c.name) });
  res.json(rows.map(({ config, ...rest }) => rest));
});

channelsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const type = req.body?.type;
  if (!name || !VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `name and a valid type (${VALID_TYPES.join(", ")}) are required` });
    return;
  }
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  const [channel] = await db.insert(notificationChannels).values({ name, type, config }).returning();
  const { config: _omit, ...rest } = channel;
  res.status(201).json(rest);
});

channelsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof notificationChannels.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.config !== undefined) updates.config = req.body.config;
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  const [channel] = await db
    .update(notificationChannels)
    .set(updates)
    .where(eq(notificationChannels.id, req.params.id))
    .returning();
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  const { config: _omit, ...rest } = channel;
  res.json(rest);
});

channelsRouter.delete("/:id", async (req, res) => {
  await db.delete(notificationChannels).where(eq(notificationChannels.id, req.params.id));
  res.status(204).end();
});
