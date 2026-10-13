import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { watchdogSettings } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { describeUrl, getWatchdog, pingNow, selfCheck } from "../services/watchdog.js";
import { recordSecurityEvent } from "../services/security.js";

export const watchdogRouter = Router();
watchdogRouter.use(requireAuth);

const view = async () => {
  const w = await getWatchdog();
  const { url, failUrl, ...rest } = w;
  return { ...rest, urlSet: Boolean(url), url: describeUrl(url), failUrlSet: Boolean(failUrl), failUrl: describeUrl(failUrl), selfCheck: await selfCheck() };
};

const httpUrl = (v: unknown): string | null | { error: string } => {
  if (v === null || v === "") return null;
  try {
    const u = new URL(String(v));
    if (u.protocol !== "https:" && u.protocol !== "http:") return { error: "Use an http(s) URL" };
    return u.toString();
  } catch {
    return { error: `"${String(v)}" isn't a URL` };
  }
};

watchdogRouter.get("/", async (_req, res) => {
  res.json(await view());
});

// URLs are write-only: send one to replace it, null to clear it, or leave
// it out to keep the saved one.
watchdogRouter.patch("/", async (req, res) => {
  await getWatchdog();
  const u: Partial<typeof watchdogSettings.$inferInsert> = { updatedAt: new Date() };
  for (const key of ["url", "failUrl"] as const) {
    if (req.body?.[key] === undefined) continue;
    const v = httpUrl(req.body[key]);
    if (v && typeof v === "object") {
      res.status(400).json(v);
      return;
    }
    u[key] = v;
  }
  if (req.body?.enabled !== undefined) u.enabled = Boolean(req.body.enabled);
  if (req.body?.intervalSeconds !== undefined) u.intervalSeconds = Math.min(3600, Math.max(30, Math.round(Number(req.body.intervalSeconds) || 60)));
  const current = await getWatchdog();
  if ((u.enabled ?? current.enabled) && !(u.url !== undefined ? u.url : current.url)) {
    res.status(400).json({ error: "Set the ping URL before turning the watchdog on" });
    return;
  }
  await db.update(watchdogSettings).set(u).where(eq(watchdogSettings.id, 1));
  await recordSecurityEvent("settings_changed", { req, detail: `watchdog: ${Object.keys(u).filter((k) => k !== "updatedAt").join(", ")}` });
  res.json(await view());
});

watchdogRouter.post("/test", async (_req, res) => {
  const r = await pingNow();
  res.status(r.sent ? 200 : 502).json(r);
});
