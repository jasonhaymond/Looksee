// API routes for notification channels (email, webhook, web push, Slack,
// Teams, Telegram…): list, create, edit, message templates and preview, send a
// test, delete.
//
// Security: every route requires a signed-in session; a channel's delivery
// settings (webhook URLs, bot tokens) are write-only — they're never sent back
// to the dashboard after saving.

import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationChannels } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { deliver } from "../services/alerting.js";
import { ALERT_EVENTS, DEFAULT_TEMPLATES, TEMPLATE_VARIABLES, renderFor, sampleContext, type Templates } from "../services/notifications/templates.js";
import { own, setOwn } from "../lib/own.js";

export const channelsRouter = Router();
channelsRouter.use(requireAuth);

const VALID_TYPES = ["email", "webhook", "web_push", "sms", "telegram", "slack", "teams"] as const;

// Keeps only known events and string title/body, trimmed to sane sizes.
function cleanTemplates(raw: unknown): Templates {
  const out: Templates = {};
  if (!raw || typeof raw !== "object") return out;
  for (const ev of ALERT_EVENTS) {
    const t = own(raw as Record<string, unknown>, ev);
    if (!t || typeof t !== "object") continue;
    const title = typeof (t as { title?: unknown }).title === "string" ? (t as { title: string }).title.slice(0, 500) : "";
    const body = typeof (t as { body?: unknown }).body === "string" ? (t as { body: string }).body.slice(0, 4000) : "";
    if (title.trim() || body.trim()) setOwn(out, ev, { ...(title.trim() ? { title } : {}), ...(body.trim() ? { body } : {}) });
  }
  return out;
}

// config may hold secrets (webhook URLs with tokens, bot tokens) — write-
// only from the admin UI once saved, per the security baseline. Templates
// aren't secret and come back so they can be edited.
const publicView = (row: typeof notificationChannels.$inferSelect) => {
  const view: Partial<typeof notificationChannels.$inferSelect> = { ...row };
  delete view.config;
  return view;
};

channelsRouter.get("/", async (_req, res) => {
  const rows = await db.query.notificationChannels.findMany({ orderBy: (c, { asc }) => asc(c.name) });
  res.json(rows.map(publicView));
});

// Defaults and variable list for the template editor.
channelsRouter.get("/templates", (_req, res) => {
  res.json({ events: ALERT_EVENTS, defaults: DEFAULT_TEMPLATES, variables: TEMPLATE_VARIABLES });
});

// Renders templates against sample data, for the editor's live preview.
channelsRouter.post("/preview", (req, res) => {
  const templates = cleanTemplates(req.body?.templates);
  const ctx = sampleContext();
  res.json(Object.fromEntries(ALERT_EVENTS.map((ev) => [ev, renderFor(templates, { ...ctx, event: ev, status: ev === "resolved" ? "UP" : "DOWN" })])));
});

channelsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const type = req.body?.type;
  if (!name || !VALID_TYPES.includes(type)) {
    res.status(400).json({ error: `name and a valid type (${VALID_TYPES.join(", ")}) are required` });
    return;
  }
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  const [channel] = await db.insert(notificationChannels).values({ name, type, config, templates: cleanTemplates(req.body?.templates) }).returning();
  res.status(201).json(publicView(channel));
});

channelsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof notificationChannels.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.config !== undefined) updates.config = req.body.config;
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.templates !== undefined) updates.templates = cleanTemplates(req.body.templates);
  const [channel] = await db.update(notificationChannels).set(updates).where(eq(notificationChannels.id, req.params.id)).returning();
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  res.json(publicView(channel));
});

// Sends a sample alert through the channel's real sender and templates.
channelsRouter.post("/:id/test", async (req, res) => {
  const channel = await db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, req.params.id) });
  if (!channel) {
    res.status(404).json({ error: "Channel not found" });
    return;
  }
  try {
    await deliver(channel, sampleContext());
    res.json({ sent: true });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

channelsRouter.delete("/:id", async (req, res) => {
  await db.delete(notificationChannels).where(eq(notificationChannels.id, req.params.id));
  res.status(204).end();
});
