import webpush from "web-push";
import { db } from "../../db/index.js";
import { webPushSubscriptions } from "../../db/schema.js";
import { eq } from "drizzle-orm";

let configured = false;

function ensureConfigured() {
  if (configured) return;
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    throw new Error("VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not configured");
  }
  webpush.setVapidDetails(process.env.VAPID_SUBJECT ?? "mailto:admin@example.com", publicKey, privateKey);
  configured = true;
}

// Sends to every saved subscription (single-admin-user app, so "every
// subscription" effectively means "every browser/device Jason has signed
// in on and granted permission") — a subscription that's gone stale
// (uninstalled PWA, cleared site data) fails with 404/410, which we treat
// as a cue to delete it rather than a real error.
export async function sendWebPush(_config: unknown, message: string) {
  ensureConfigured();
  const subscriptions = await db.query.webPushSubscriptions.findMany();
  const payload = JSON.stringify({ title: "Looksee alert", body: message });

  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload
        );
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          await db.delete(webPushSubscriptions).where(eq(webPushSubscriptions.id, sub.id));
        } else {
          console.error(`Web push failed for subscription ${sub.id}:`, err);
        }
      }
    })
  );
}
