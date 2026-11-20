// Browser push (Web Push): sends an alert to every browser that turned on
// push in the dashboard ("Enable push notifications"). Part of the
// "Notifications" channel, which also reaches the Android app
// (services/notifications/push.ts sends to both).
//
// Security: messages are signed with the server's VAPID key pair from .env
// (the private key never leaves the engine); each subscription's keys encrypt
// the message so only that browser can read it.

import webpush from "web-push";
import { db } from "../../db/index.js";
import { webPushSubscriptions } from "../../db/schema.js";
import { eq } from "drizzle-orm";
import { logger } from "../../lib/logger.js";

let configured = false;

/** Loads the VAPID keys once. Throws when they aren't set in .env. */
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

/**
 * Sends to every saved subscription (single-admin-user app, so "every
 * subscription" means every browser/device the admin turned push on in). A
 * subscription that's gone stale (uninstalled PWA, cleared site data) fails
 * with 404/410, which is a cue to delete it rather than a real error.
 *
 * In: the message body, title and the link it opens.
 * Out: how many browsers it was sent to (0 when none have push turned on; the
 * VAPID keys are only needed when there is at least one).
 */
export async function sendWebPush(message: string, title = "Looksee alert", url?: string): Promise<number> {
  const subscriptions = await db.query.webPushSubscriptions.findMany();
  if (!subscriptions.length) return 0;
  ensureConfigured();
  const payload = JSON.stringify({ title, body: message, url });

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
          const detail = err instanceof Error ? err.message : String(err);
          logger.error(
            "webpush",
            `Web push failed for subscription ${sub.id}: ${detail}`,
            "A push notification couldn't be delivered to one of your browsers/devices.",
            { subscriptionId: sub.id }
          );
        }
      }
    })
  );
  return subscriptions.length;
}
