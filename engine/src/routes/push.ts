import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { webPushSubscriptions } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const pushRouter = Router();
pushRouter.use(requireAuth);

// Public key only — the private key never leaves the engine. The dashboard
// needs this to call pushManager.subscribe(applicationServerKey: ...).
pushRouter.get("/vapid-public-key", (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    res.status(503).json({ error: "Web push is not configured on this engine" });
    return;
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

pushRouter.post("/subscribe", async (req, res) => {
  const { endpoint, keys } = req.body ?? {};
  if (!endpoint || !keys?.p256dh || !keys?.auth) {
    res.status(400).json({ error: "endpoint and keys.{p256dh,auth} are required" });
    return;
  }
  await db
    .insert(webPushSubscriptions)
    .values({ userId: req.user!.id, endpoint, p256dh: keys.p256dh, auth: keys.auth })
    .onConflictDoNothing({ target: webPushSubscriptions.endpoint });
  res.status(201).json({ ok: true });
});

pushRouter.post("/unsubscribe", async (req, res) => {
  const endpoint = String(req.body?.endpoint ?? "");
  if (endpoint) await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.endpoint, endpoint));
  res.json({ ok: true });
});
