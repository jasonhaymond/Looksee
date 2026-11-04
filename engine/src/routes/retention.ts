// API routes behind the Data retention page: read the settings and current disk
// use, change them, and run the cleanup now.
//
// Security: every route requires a signed-in session. These settings decide when
// monitoring history is deleted, so every value is validated against a sensible
// range, and changes are written to the security audit log. A retention period
// can't go below one day (30 for the audit log itself, so a stolen session can't use
// this page to wipe recent evidence), and the "always keep" window can't go below one
// hour.

import path from "node:path";
import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { retentionSettings } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { DATA_KINDS, enforceFreeSpace, getRetention, pruneData, readDisk, retentionStatus } from "../services/retention.js";
import { recordSecurityEvent } from "../services/security.js";

export const retentionRouter = Router();
retentionRouter.use(requireAuth);

/** A number within a range, or null when it's anything else. */
const inRange = (v: unknown, min: number, max: number): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
};

// GET /api/retention: settings, disk use and each kind of data's size.
retentionRouter.get("/", async (_req, res) => {
  res.json(await retentionStatus());
});

// PATCH /api/retention: changes any of the settings; fields left out stay as they
// are. A retention period of null goes back to the default. Answers 400 without
// saving anything if any value is out of range.
retentionRouter.patch("/", async (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const u: Partial<typeof retentionSettings.$inferInsert> = { updatedAt: new Date() };

  if (body.rolloverEnabled !== undefined) u.rolloverEnabled = body.rolloverEnabled === true;
  if (body.minFreeMode !== undefined) {
    if (body.minFreeMode !== "gb" && body.minFreeMode !== "percent") {
      res.status(400).json({ error: "minFreeMode must be gb or percent" });
      return;
    }
    u.minFreeMode = body.minFreeMode;
  }
  if (body.minFreeGb !== undefined) {
    const n = inRange(body.minFreeGb, 0.5, 1_000_000);
    if (n == null) {
      res.status(400).json({ error: "Free space must be at least 0.5 GB" });
      return;
    }
    u.minFreeGb = n;
  }
  if (body.minFreePercent !== undefined) {
    const n = inRange(body.minFreePercent, 1, 90);
    if (n == null) {
      res.status(400).json({ error: "Free space must be between 1% and 90%" });
      return;
    }
    u.minFreePercent = n;
  }
  if (body.minKeepHours !== undefined) {
    const n = inRange(body.minKeepHours, 1, 8760);
    if (n == null || !Number.isInteger(n)) {
      res.status(400).json({ error: "Always keep must be a whole number of hours from 1 to 8760" });
      return;
    }
    u.minKeepHours = n;
  }
  if (body.storagePath !== undefined) {
    if (body.storagePath === null || body.storagePath === "") {
      u.storagePath = null;
    } else {
      // Only ever used to measure free space, never read or written. Measuring it
      // now means a typo is refused here, rather than silently turning the
      // protection off later.
      const p = String(body.storagePath);
      const measurable = path.isAbsolute(p) && (await readDisk(p).then(() => true, () => false));
      if (!measurable) {
        res.status(400).json({ error: "The disk path must exist and be written in full" });
        return;
      }
      u.storagePath = p;
    }
  }
  if (body.days !== undefined) {
    if (!body.days || typeof body.days !== "object" || Array.isArray(body.days)) {
      res.status(400).json({ error: "days must be an object" });
      return;
    }
    // Only known kinds are read, each by its own key, so nothing else in the
    // request can end up in the stored settings.
    const incoming = new Map(Object.entries(body.days as Record<string, unknown>));
    const next = new Map(Object.entries((await getRetention()).days ?? {}));
    for (const kind of DATA_KINDS) {
      if (!incoming.has(kind.key)) continue;
      const raw = incoming.get(kind.key);
      if (raw === null || raw === "") {
        next.delete(kind.key);
        continue;
      }
      const lowest = kind.minDays ?? 1;
      const n = inRange(raw, lowest, 36500);
      if (n == null || !Number.isInteger(n)) {
        res.status(400).json({ error: `${kind.label}: keep for a whole number of days, at least ${lowest}` });
        return;
      }
      next.set(kind.key, n);
    }
    u.days = Object.fromEntries(next);
  }

  await getRetention();
  await db.update(retentionSettings).set(u).where(eq(retentionSettings.id, 1));
  await recordSecurityEvent("settings_changed", { req, detail: `data retention: ${Object.keys(u).filter((k) => k !== "updatedAt").join(", ")}` });
  res.json(await retentionStatus());
});

// POST /api/retention/run: applies the retention periods and the free-space limit
// now rather than waiting for the schedule. Deletes data, so the page asks first.
retentionRouter.post("/run", async (req, res) => {
  await pruneData();
  const outcome = await enforceFreeSpace();
  await recordSecurityEvent("settings_changed", { req, detail: "data retention: cleanup run by hand" });
  res.json({ outcome, status: await retentionStatus() });
});
