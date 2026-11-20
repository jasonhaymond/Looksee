// Android app notifications: queues one notification per phone in
// app_notifications and pushes it straight away to phones that are connected
// (services/appStream.ts). Phones that aren't connected get it when they
// reconnect, within APP_QUEUE_HOURS.
//
// Where this sits: the "Notifications" channel (services/notifications/push.ts)
// calls this for every phone, alongside browser push; routes/app.ts calls it
// for one phone's "Send test".

import { inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { appDevices, appNotifications } from "../../db/schema.js";
import { isUuid } from "../../lib/ids.js";
import { pushPending } from "../appStream.js";

/** The parts of a notification the phone shows and acts on. */
export type AppMessage = { title: string; body: string; status?: string; event?: string; checkId?: string };

/**
 * Queues a notification for each phone (or only the given phones) and sends
 * it to the connected ones.
 *
 * In: the message (title cut to 200, body to 2000 characters, the sizes a
 * phone notification shows), and optionally which phones.
 * Out: how many phones it was queued for (0 when none are registered).
 * Side effects: inserts app_notifications rows.
 */
export async function sendAppNotification(message: AppMessage, deviceIds?: string[]): Promise<number> {
  const devices = await db
    .select({ id: appDevices.id })
    .from(appDevices)
    .where(deviceIds ? inArray(appDevices.id, deviceIds.filter(isUuid)) : undefined);
  if (!devices.length) return 0;
  await db.insert(appNotifications).values(
    devices.map((d) => ({
      deviceId: d.id,
      title: message.title.slice(0, 200),
      body: message.body.slice(0, 2000),
      status: message.status?.slice(0, 20) ?? null,
      event: message.event?.slice(0, 20) ?? null,
      checkId: message.checkId && isUuid(message.checkId) ? message.checkId : null,
    }))
  );
  await Promise.all(devices.map((d) => pushPending(d.id)));
  return devices.length;
}
