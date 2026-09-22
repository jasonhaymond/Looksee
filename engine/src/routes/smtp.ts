import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { smtpSettings } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { sendTestEmail } from "../services/notifications/email.js";
import { logger } from "../lib/logger.js";

export const smtpRouter = Router();
smtpRouter.use(requireAuth);

function publicSettings(row: typeof smtpSettings.$inferSelect) {
  const { password, ...rest } = row;
  return { ...rest, passwordSet: Boolean(password) };
}

smtpRouter.get("/settings", async (_req, res) => {
  const [row] = await db.insert(smtpSettings).values({ id: 1 }).onConflictDoNothing({ target: smtpSettings.id }).returning();
  const settings = row ?? (await db.select().from(smtpSettings).where(eq(smtpSettings.id, 1)).limit(1))[0];
  res.json({ settings: publicSettings(settings) });
});

smtpRouter.patch("/settings", async (req, res) => {
  const { host, port, user, password, from } = req.body ?? {};

  if (host !== undefined && host !== null && typeof host !== "string") {
    res.status(400).json({ error: "host must be a string, or null to clear" });
    return;
  }
  if (port !== undefined && port !== null && !Number.isInteger(port)) {
    res.status(400).json({ error: "port must be an integer, or null to clear" });
    return;
  }
  if (from !== undefined && from !== null && typeof from !== "string") {
    res.status(400).json({ error: "from must be a string, or null to clear" });
    return;
  }

  const updates: Partial<typeof smtpSettings.$inferInsert> = { updatedAt: new Date() };
  if (host !== undefined) updates.host = host;
  if (port !== undefined) updates.port = port;
  if (user !== undefined) updates.user = user;
  if (password) updates.password = password; // write-only: only ever set, never cleared by an empty string
  if (from !== undefined) updates.from = from;

  const [updated] = await db
    .insert(smtpSettings)
    .values({ id: 1, ...updates })
    .onConflictDoUpdate({ target: smtpSettings.id, set: updates })
    .returning();
  res.json({ settings: publicSettings(updated) });
});

smtpRouter.post("/test", async (req, res) => {
  const to = typeof req.body?.to === "string" ? req.body.to : "";
  if (!to) {
    res.status(400).json({ error: "to is required" });
    return;
  }
  try {
    await sendTestEmail(to);
    res.json({ sent: true });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("smtp", `Test email to ${to} failed: ${detail}`, "The test email couldn't be sent — check your SMTP settings.");
    res.status(502).json({ error: detail });
  }
});
