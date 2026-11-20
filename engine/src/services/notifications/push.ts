// The "Notifications" channel (type ID web_push, kept from when it was
// browser-only): one alert goes to every browser with push turned on in the
// dashboard and to every phone signed in to the Looksee Android app. Nothing
// to configure on the channel itself; what receives it is decided by turning
// push on in a browser or signing in on a phone.
//
// Where this sits: services/alerting.ts deliverText() calls it for channels
// of type web_push (alerts, reminders, escalations, recoveries, "Send test",
// and security notifications).

import { sendWebPush } from "./webpush.js";
import { sendAppNotification } from "./app.js";
import { logger } from "../../lib/logger.js";

/**
 * Sends to browsers and phones together. One side failing doesn't stop the
 * other: if browser push can't be sent (e.g. VAPID keys not set) but phones
 * got it, that's logged and the send still counts as delivered.
 *
 * In: title, body, the link to open, and for the phone: status (decides how
 * loud the notification is), event, and the check it opens when tapped.
 * Throws when nothing received it, so "Send test" and the log say why.
 */
export async function sendNotifications(title: string, body: string, url: string | undefined, extra: { status?: string; event?: string; checkId?: string }) {
  const [web, phones] = await Promise.allSettled([sendWebPush(body, title, url), sendAppNotification({ title, body, ...extra })]);
  const browsers = web.status === "fulfilled" ? web.value : 0;
  const devices = phones.status === "fulfilled" ? phones.value : 0;
  if (browsers + devices > 0) {
    const failed = web.status === "rejected" ? web : phones.status === "rejected" ? phones : null;
    if (failed) {
      const detail = failed.reason instanceof Error ? failed.reason.message : String(failed.reason);
      logger.warn("notifications", `Notifications reached only part of their targets: ${detail}`, `A notification reached ${browsers ? "your browsers" : "your phones"}, but not ${browsers ? "your phones" : "your browsers"}: ${detail}`);
    }
    return;
  }
  // Nothing received it: report a real failure if there was one, else say what's missing.
  if (web.status === "rejected") throw web.reason;
  if (phones.status === "rejected") throw phones.reason;
  throw new Error('Nothing receives Notifications yet: click "Enable push" in the dashboard in a browser, or sign in on the Looksee Android app.');
}
