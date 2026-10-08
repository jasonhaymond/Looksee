import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { maintenanceWindows } from "../db/schema.js";

type Window = typeof maintenanceWindows.$inferSelect;
type Target = { id: string; endpointId: string; hostId: string | null; probeHostId?: string | null };

// Windows change rarely and every result consults them, so they're cached
// briefly; routes/maintenance.ts calls invalidate() after any write.
let cache: { at: number; rows: Window[] } | null = null;
const CACHE_MS = 15_000;

export function invalidateMaintenanceCache() {
  cache = null;
}

async function activeWindows(): Promise<Window[]> {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    cache = { at: Date.now(), rows: await db.query.maintenanceWindows.findMany({ where: eq(maintenanceWindows.enabled, true) }) };
  }
  return cache.rows;
}

// Weekly windows are evaluated in the engine's local time, and one that
// starts late on Saturday and runs past midnight still counts on Sunday —
// so yesterday's start is checked too.
export function windowIsActive(w: Pick<Window, "startsAt" | "endsAt" | "daysOfWeek" | "startTime" | "durationMinutes" | "enabled">, now = new Date()): boolean {
  if (!w.enabled) return false;
  if (w.startsAt && w.endsAt) return now >= w.startsAt && now < w.endsAt;
  if (!w.daysOfWeek?.length || !w.startTime || !w.durationMinutes) return false;
  const [h, m] = w.startTime.split(":").map((n) => parseInt(n, 10));
  if (!Number.isFinite(h) || !Number.isFinite(m)) return false;
  for (const dayOffset of [0, -1, -2, -3, -4, -5, -6]) {
    const start = new Date(now);
    start.setDate(start.getDate() + dayOffset);
    start.setHours(h, m, 0, 0);
    if (!w.daysOfWeek.includes(start.getDay())) continue;
    const end = new Date(start.getTime() + w.durationMinutes * 60_000);
    if (now >= start && now < end) return true;
  }
  return false;
}

export function windowAppliesTo(w: Pick<Window, "scope" | "targetIds">, target: Target): boolean {
  const ids = w.targetIds ?? [];
  switch (w.scope) {
    case "all":
      return true;
    case "endpoint":
      return ids.includes(target.endpointId);
    case "host":
      return (target.hostId != null && ids.includes(target.hostId)) || (target.probeHostId != null && ids.includes(target.probeHostId));
    case "check":
      return ids.includes(target.id);
    default:
      return false;
  }
}

export async function isInMaintenance(target: Target, now = new Date()): Promise<boolean> {
  return (await activeWindows()).some((w) => windowAppliesTo(w, target) && windowIsActive(w, now));
}
