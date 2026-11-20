// API routes for the Looksee Android app's phones: register a phone for app
// notifications, list/rename/remove phones, a phone's recent notifications, and
// a test notification to one phone. The notification stream itself is a
// WebSocket, handled in services/appStream.ts rather than here.
//
// Who calls this: the app right after signing in (register), its Settings
// screen, and the dashboard's Security page (list/remove).
//
// Security: every route needs a signed-in session (the app's bearer session or
// the dashboard's cookie). Registering returns the phone's notification-only
// token exactly once; only its hash is stored. Registering and removing a phone
// are recorded as security events, and a new phone triggers a security
// notification, since a phone that receives alerts learns what's monitored.

import { Router } from "express";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { appDevices, appNotifications } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { isUuid } from "../lib/ids.js";
import { clientIp } from "../lib/ipMatch.js";
import { disconnectDevice, hashDeviceToken, isConnected, newDeviceToken } from "../services/appStream.js";
import { sendAppNotification } from "../services/notifications/app.js";
import { notifySecurity, recordSecurityEvent } from "../services/security.js";

export const appRouter = Router();
appRouter.use(requireAuth);

// Most phones one account may register; far more than one person needs, low
// enough that a runaway script can't fill the table.
const MAX_DEVICES = 20;

/** Trims a client-supplied text field to a safe length (empty → null). */
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** What the dashboard and app see of a phone: never the token or its hash. */
const view = (d: typeof appDevices.$inferSelect) => ({
  id: d.id,
  name: d.name,
  appVersion: d.appVersion,
  platform: d.platform,
  lastConnectedAt: d.lastConnectedAt,
  lastIp: d.lastIp,
  createdAt: d.createdAt,
  connected: isConnected(d.id),
});

/**
 * POST /api/app/devices — registers the calling phone.
 * In: { name, appVersion?, platform? }. Out: 201 { device, token }; the token
 * is shown only in this response. 400 without a name, 409 at MAX_DEVICES.
 */
appRouter.post("/devices", async (req, res) => {
  const name = text(req.body?.name, 100);
  if (!name) {
    res.status(400).json({ error: "A phone name is required" });
    return;
  }
  const existing = await db.select({ id: appDevices.id }).from(appDevices).where(eq(appDevices.userId, req.user!.id));
  if (existing.length >= MAX_DEVICES) {
    res.status(409).json({ error: `At most ${MAX_DEVICES} phones can be registered. Remove an old one on the Security page.` });
    return;
  }
  const token = newDeviceToken();
  const [device] = await db
    .insert(appDevices)
    .values({ userId: req.user!.id, name, tokenHash: hashDeviceToken(token), appVersion: text(req.body?.appVersion, 40), platform: text(req.body?.platform, 80), lastIp: clientIp(req) })
    .returning();
  await recordSecurityEvent("app_device_added", { req, detail: `${req.user!.email}: ${name}` });
  await notifySecurity("Security: phone registered for alerts", `The Looksee app on "${name}" was registered for alert notifications from ${clientIp(req)}. If that wasn't you, remove it on the Security page and change your password.`);
  res.status(201).json({ device: view(device), token });
});

/** GET /api/app/devices — this account's phones, newest first, with whether each is connected now. */
appRouter.get("/devices", async (req, res) => {
  const rows = await db.select().from(appDevices).where(eq(appDevices.userId, req.user!.id)).orderBy(desc(appDevices.createdAt));
  res.json(rows.map(view));
});

/**
 * Looks up one of the signed-in account's phones by the :id in the URL.
 * The userId filter is the ownership check: an ID that isn't this account's
 * phone is answered with 404, the same as one that doesn't exist.
 */
async function ownDevice(req: { params: Record<string, string>; user?: { id: string } }) {
  const id = String(req.params.id);
  if (!isUuid(id)) return undefined;
  return db.query.appDevices.findFirst({ where: and(eq(appDevices.id, id), eq(appDevices.userId, req.user!.id)) });
}

/** PATCH /api/app/devices/:id — renames a phone. In: { name }. */
appRouter.patch("/devices/:id", async (req, res) => {
  const device = await ownDevice(req);
  const name = text(req.body?.name, 100);
  if (!device) {
    res.status(404).json({ error: "Phone not found" });
    return;
  }
  if (!name) {
    res.status(400).json({ error: "A phone name is required" });
    return;
  }
  const [row] = await db.update(appDevices).set({ name }).where(eq(appDevices.id, device.id)).returning();
  res.json(view(row));
});

/**
 * DELETE /api/app/devices/:id — removes a phone. Its token stops working and
 * its open connection is closed at once; its queued notifications go with it.
 */
appRouter.delete("/devices/:id", async (req, res) => {
  const device = await ownDevice(req);
  if (device) {
    await db.delete(appDevices).where(eq(appDevices.id, device.id));
    disconnectDevice(device.id);
    await recordSecurityEvent("app_device_removed", { req, detail: `${req.user!.email}: ${device.name}` });
  }
  res.status(204).end();
});

/** GET /api/app/devices/:id/notifications — the phone's last 100 notifications, newest first. */
appRouter.get("/devices/:id/notifications", async (req, res) => {
  const device = await ownDevice(req);
  if (!device) {
    res.status(404).json({ error: "Phone not found" });
    return;
  }
  const rows = await db.select().from(appNotifications).where(eq(appNotifications.deviceId, device.id)).orderBy(desc(appNotifications.createdAt)).limit(100);
  res.json(rows.map((r) => ({ id: r.id, title: r.title, body: r.body, status: r.status, event: r.event, checkId: r.checkId, createdAt: r.createdAt, deliveredAt: r.deliveredAt })));
});

/** POST /api/app/devices/:id/test — sends a test notification to this one phone. */
appRouter.post("/devices/:id/test", async (req, res) => {
  const device = await ownDevice(req);
  if (!device) {
    res.status(404).json({ error: "Phone not found" });
    return;
  }
  await sendAppNotification({ title: "Looksee test notification", body: `Notifications reach "${device.name}".`, status: "UP", event: "test" }, [device.id]);
  res.json({ sent: true, connected: isConnected(device.id) });
});
