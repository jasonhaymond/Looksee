// Keeps Looksee's stored data, and the disk it lives on, under control.
//
// Two separate jobs:
//   - pruneData (nightly): deletes data older than its retention period. The
//     periods come from the Data retention page, then the *_RETENTION_DAYS
//     environment settings, then the defaults below.
//   - enforceFreeSpace (every 5 minutes): when the disk holding the database runs
//     low, rolls over the oldest data early, even if its retention period hasn't
//     run out, so the disk never fills up. A full disk stops Postgres, and with it
//     all monitoring.
//
// Where this sits: index.ts schedules both; routes/retention.ts is the page's API.
//
// The Postgres detail this design depends on: DELETE doesn't give disk space back
// to the operating system. The freed room stays inside the table for new rows to
// reuse, so free space on the disk doesn't rise. A plain "delete until the disk
// has 3 GB free" loop would therefore delete everything and still see a full disk.
// So after deleting, enforceFreeSpace compacts the table with VACUUM FULL, which
// does return the space but needs room for a temporary copy of the table and blocks
// writes to it meanwhile. When there isn't room for the copy it runs a plain VACUUM
// instead, and remembers roughly how much is now reusable inside the database
// (reusableBytes), counting that as free so it doesn't keep deleting for space it
// has already made.
//
// Safety limits: rows newer than minKeepHours are never rolled over, however low
// the disk is, and the security audit log is never rolled over (filling a disk must
// not be a way to erase evidence of an attack). Reaching those limits is logged as
// an error rather than deleting more.

import fs from "node:fs";
import { and, eq, getTableName, isNotNull, lt, sql, type Column } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool } from "../db/index.js";
import { checkResults, endpointMetrics, events, flowRecords, ipBlocks, loginChallenges, logs, retentionSettings, securityEvents, sessions, softwareHistory } from "../db/schema.js";
import { logger } from "../lib/logger.js";

/** One kind of time-stamped data with a retention period. */
export type DataKind = {
  key: string;
  label: string;
  help: string;
  table: PgTable;
  time: Column;
  env: string;
  defaultDays: number;
  // Whether low disk space may delete it before its retention period is over.
  rollover: boolean;
  // The shortest period the page accepts (1 day when left out).
  minDays?: number;
};

// In rollover order: when the disk runs low, the most disposable data goes first.
// Check results come last because SLA reports and uptime history are built on them.
export const DATA_KINDS: DataKind[] = [
  { key: "flows", label: "Network flows", help: "NetFlow/sFlow conversations behind Top talkers.", table: flowRecords, time: flowRecords.bucket, env: "FLOW_RETENTION_DAYS", defaultDays: 7, rollover: true },
  { key: "metrics", label: "Endpoint metrics", help: "The agent's full report history, behind the charts. Usually the largest table.", table: endpointMetrics, time: endpointMetrics.recordedAt, env: "HOST_METRICS_RETENTION_DAYS", defaultDays: 30, rollover: true },
  { key: "events", label: "Traps and syslog", help: "Received SNMP traps and syslog messages.", table: events, time: events.receivedAt, env: "EVENT_RETENTION_DAYS", defaultDays: 30, rollover: true },
  { key: "logs", label: "Application logs", help: "What the Logs page shows.", table: logs, time: logs.createdAt, env: "LOOKSEE_LOG_RETENTION_DAYS", defaultDays: 30, rollover: true },
  { key: "softwareHistory", label: "Software history", help: "Programs installed, removed and updated on endpoints.", table: softwareHistory, time: softwareHistory.detectedAt, env: "SOFTWARE_HISTORY_RETENTION_DAYS", defaultDays: 730, rollover: true },
  { key: "checkResults", label: "Check results", help: "Every check's history. SLA reports read this, so keep it for as long as you report on.", table: checkResults, time: checkResults.checkedAt, env: "CHECK_RESULT_RETENTION_DAYS", defaultDays: 400, rollover: true },
  // Its 30-day minimum means a stolen session can't erase recent evidence from the
  // Data retention page. The environment setting can go lower: that takes server access.
  { key: "securityEvents", label: "Security events", help: "The sign-in and settings audit log. Never rolled over early.", table: securityEvents, time: securityEvents.createdAt, env: "SECURITY_EVENT_RETENTION_DAYS", defaultDays: 180, rollover: false, minDays: 30 },
];

// Bulky details on check results (interface tables, hop lists) are dropped sooner
// than the results themselves.
const DETAILS_KEEP_DAYS = 7;
// Rows removed per DELETE, so a large rollover doesn't hold one enormous
// transaction or block new results for long.
const DELETE_BATCH = 20_000;
// Delete a little more than the shortfall: size estimates are rough, and this
// avoids a new rollover every few minutes while the disk hovers at the limit.
const OVERSHOOT = 1.25;
// Room VACUUM FULL must leave free beyond its temporary copy of the table.
const VACUUM_MARGIN_BYTES = 256e6;

export type RetentionSettings = typeof retentionSettings.$inferSelect;

/** The settings row, created with defaults the first time it's needed. */
export async function getRetention(): Promise<RetentionSettings> {
  let [row] = await db.select().from(retentionSettings).where(eq(retentionSettings.id, 1));
  if (!row) [row] = await db.insert(retentionSettings).values({ id: 1 }).onConflictDoNothing().returning();
  return row ?? (await db.select().from(retentionSettings).where(eq(retentionSettings.id, 1)))[0];
}

/**
 * How many days a kind of data is kept: the page's setting, else its environment
 * setting, else the built-in default.
 */
export function effectiveDays(kind: DataKind, settings: RetentionSettings): number {
  const saved = new Map(Object.entries(settings.days ?? {})).get(kind.key);
  if (saved && saved > 0) return Math.max(saved, kind.minDays ?? 1);
  const fromEnv = Number(process.env[kind.env]);
  return Number.isFinite(fromEnv) && fromEnv > 0 ? fromEnv : kind.defaultDays;
}

const ago = (ms: number) => new Date(Date.now() - ms);
const DAY_MS = 86_400_000;

/**
 * The nightly cleanup: deletes every kind of data past its retention period, plus
 * expired sign-in sessions, login challenges and IP blocks.
 *
 * Side effects: deletes rows. Autovacuum later makes the room reusable.
 */
export async function pruneData() {
  const settings = await getRetention();
  for (const kind of DATA_KINDS) {
    await db.delete(kind.table).where(lt(kind.time, ago(effectiveDays(kind, settings) * DAY_MS)));
  }
  await db.update(checkResults).set({ details: null }).where(and(lt(checkResults.checkedAt, ago(DETAILS_KEEP_DAYS * DAY_MS)), isNotNull(checkResults.details)));
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
  await db.delete(loginChallenges).where(lt(loginChallenges.expiresAt, new Date()));
  await db.delete(ipBlocks).where(and(isNotNull(ipBlocks.until), lt(ipBlocks.until, ago(DAY_MS))));
}

// ---- free-space enforcement ----

/** Free and total bytes of a disk. */
export type DiskSpace = { freeBytes: number; totalBytes: number };

/**
 * Which folder's disk to measure. The page's setting wins, then DATA_DISK_PATH.
 * Otherwise it's Docker's data folder when it exists (the database runs in a Docker
 * volume, which may be on a different disk from the app), else the app's own
 * folder, which is the same disk when Postgres is installed directly.
 */
export function storagePath(settings: RetentionSettings): string {
  if (settings.storagePath) return settings.storagePath;
  if (process.env.DATA_DISK_PATH) return process.env.DATA_DISK_PATH;
  return fs.existsSync("/var/lib/docker") ? "/var/lib/docker" : process.cwd();
}

/** Reads a disk's free and total bytes. Space reserved for root doesn't count as free. */
export async function readDisk(path: string): Promise<DiskSpace> {
  const s = await fs.promises.statfs(path);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}

/** The free-space limit in bytes for a disk of this size, by GB or by percentage. */
export function minFreeBytes(settings: RetentionSettings, totalBytes: number): number {
  return settings.minFreeMode === "percent" ? (settings.minFreePercent / 100) * totalBytes : settings.minFreeGb * 1e9;
}

/** Size of a table with its indexes and large-value storage, in bytes. */
async function tableBytes(table: PgTable): Promise<number> {
  const { rows } = await db.execute<{ size: string }>(sql`SELECT pg_total_relation_size(${getTableName(table)}::regclass) AS size`);
  return Number(rows[0].size);
}

/** Rows in a table, and how many are older than a time. */
async function rowCounts(kind: DataKind, before: Date): Promise<{ total: number; old: number }> {
  const { rows } = await db.execute<{ total: string; old: string }>(sql`SELECT count(*) AS total, count(*) FILTER (WHERE ${kind.time} < ${before.toISOString()}) AS old FROM ${kind.table}`);
  return { total: Number(rows[0].total), old: Number(rows[0].old) };
}

/**
 * Deletes up to `limit` of the oldest rows older than `before`, in batches.
 * Rows are picked by their physical location (ctid), which every table has whatever
 * its primary key is.
 *
 * @returns how many rows were deleted
 */
async function deleteOldest(kind: DataKind, before: Date, limit: number): Promise<number> {
  let deleted = 0;
  while (deleted < limit) {
    const batch = Math.min(DELETE_BATCH, limit - deleted);
    const { rowCount } = await db.execute(sql`DELETE FROM ${kind.table} WHERE ctid = ANY(ARRAY(SELECT ctid FROM ${kind.table} WHERE ${kind.time} < ${before.toISOString()} ORDER BY ${kind.time} LIMIT ${batch}))`);
    const n = rowCount ?? 0;
    deleted += n;
    if (n < batch) break;
  }
  return deleted;
}

/**
 * Tries to give a table's freed space back to the disk with VACUUM FULL, which
 * writes a new copy of the table and swaps it in. Skipped when the copy wouldn't
 * fit. Falls back to a plain VACUUM, which only makes the room reusable inside the
 * table. Both are safe to run on a live database; VACUUM FULL holds up writes to
 * this one table while it runs.
 *
 * @returns whether the space went back to the disk
 */
async function reclaim(kind: DataKind, liveBytes: number, freeBytes: number): Promise<boolean> {
  if (liveBytes * 1.2 + VACUUM_MARGIN_BYTES < freeBytes) {
    // VACUUM FULL needs the table to itself. The 30-second limit stops it waiting
    // behind a long query with every new write queued up behind it. One connection
    // for both statements, because the limit only applies to the connection that
    // sets it; it's cleared again before going back to the pool.
    const client = await pool.connect();
    try {
      await client.query("SET lock_timeout = '30s'");
      await drizzle(client).execute(sql`VACUUM FULL ${kind.table}`);
      return true;
    } catch (err) {
      logger.warn("retention", `VACUUM FULL ${getTableName(kind.table)} failed: ${err instanceof Error ? err.message : String(err)}`, `Couldn't compact ${kind.label.toLowerCase()} just now. The freed room can still be reused by new data.`);
    } finally {
      await client.query("RESET lock_timeout").catch(() => undefined);
      client.release();
    }
  }
  await db.execute(sql`VACUUM ${kind.table}`);
  return false;
}

/** The outcome of one free-space pass, shown on the page and returned to tests. */
export type RolloverOutcome = { action: "disabled" | "ok" | "rolled_over" | "at_limit" | "disk_unreadable"; message: string; deleted: { key: string; rows: number }[] };

// Estimated bytes freed inside the database by deletes that couldn't be compacted.
// Kept in memory: after a restart it starts at 0, which at worst rolls over one
// extra slice of old data. lastFree is what lets it shrink as the disk fills again.
let reusableBytes = 0;
let lastFree: number | null = null;
let running = false;
// Don't repeat the same "can't free more" error every 5 minutes.
let lastLimitLog = 0;

/** Clears what's remembered between passes (tests). */
export function resetFreeSpaceState() {
  reusableBytes = 0;
  lastFree = null;
  running = false;
  lastLimitLog = 0;
}

/** Estimated bytes of reusable room inside the database (shown on the page). */
export const reusableEstimate = () => reusableBytes;

/**
 * One free-space pass: if the disk is under the limit, rolls over the oldest data,
 * most disposable kind first, until the shortfall should be covered.
 *
 * @param readDiskSpace how to measure the disk; tests pass a fake one
 * @returns what it did
 *
 * Side effects: deletes rows, runs VACUUM, writes logs, and records the result in
 * retention_settings.
 */
export async function enforceFreeSpace(readDiskSpace: (path: string) => Promise<DiskSpace> = readDisk): Promise<RolloverOutcome> {
  // Passes can't overlap: a slow VACUUM FULL may outlast the 5-minute schedule.
  if (running) return { action: "ok", message: "A pass is already running.", deleted: [] };
  running = true;
  try {
    const settings = await getRetention();
    if (!settings.rolloverEnabled) return { action: "disabled", message: "Automatic rollover is off.", deleted: [] };

    let disk: DiskSpace;
    try {
      disk = await readDiskSpace(storagePath(settings));
    } catch (err) {
      const message = `Can't read free space on ${storagePath(settings)}: ${err instanceof Error ? err.message : String(err)}`;
      if (Date.now() - lastLimitLog > 3_600_000) {
        lastLimitLog = Date.now();
        logger.error("retention", message, "Looksee can't measure its disk, so it can't protect it from filling up. Check the disk path on the Data retention page.");
      }
      return { action: "disk_unreadable", message, deleted: [] };
    }

    // Any fall in free space means the reusable room has been used up (or the disk
    // is filling with something else, in which case it's no help anyway).
    if (lastFree != null) reusableBytes = Math.max(0, reusableBytes - Math.max(0, lastFree - disk.freeBytes));
    lastFree = disk.freeBytes;

    const limit = minFreeBytes(settings, disk.totalBytes);
    if (disk.freeBytes + reusableBytes >= limit) return { action: "ok", message: "Enough free space.", deleted: [] };

    let shortfall = limit - disk.freeBytes - reusableBytes;
    const keepFrom = ago(settings.minKeepHours * 3_600_000);
    const deleted: RolloverOutcome["deleted"] = [];

    for (const kind of DATA_KINDS.filter((k) => k.rollover)) {
      if (shortfall <= 0) break;
      const { total, old } = await rowCounts(kind, keepFrom);
      if (old === 0) continue;
      const bytes = await tableBytes(kind.table);
      // Rows are assumed to be about the same size, which is close enough here: the
      // next pass measures the disk again and corrects any error.
      const wanted = Math.ceil((total * Math.min(1, (shortfall * OVERSHOOT) / Math.max(bytes, 1))));
      const rows = await deleteOldest(kind, keepFrom, Math.min(old, wanted));
      if (rows === 0) continue;
      deleted.push({ key: kind.key, rows });
      const freed = bytes * (rows / total);

      const freeNow = (await readDiskSpace(storagePath(settings))).freeBytes;
      const compacted = await reclaim(kind, bytes - freed, freeNow);
      if (compacted) {
        const after = (await readDiskSpace(storagePath(settings))).freeBytes;
        shortfall -= Math.max(0, after - freeNow);
        lastFree = after;
      } else {
        reusableBytes += freed;
        shortfall -= freed;
      }
    }

    const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
    let outcome: RolloverOutcome;
    if (deleted.length) {
      const what = deleted.map((d) => `${d.rows.toLocaleString("en-US")} ${DATA_KINDS.find((k) => k.key === d.key)?.label.toLowerCase()}`).join(", ");
      const message = `Low disk space (${gb(disk.freeBytes)} free, limit ${gb(limit)}): rolled over the oldest ${what}.`;
      logger.warn("retention", message, "Looksee deleted its oldest monitoring data early to keep the disk from filling up. Consider a larger disk or shorter retention periods.");
      outcome = { action: "rolled_over", message, deleted };
    } else {
      const message = `Low disk space (${gb(disk.freeBytes)} free, limit ${gb(limit)}), but only data from the last ${settings.minKeepHours} h is left to roll over. Something else may be filling this disk.`;
      if (Date.now() - lastLimitLog > 3_600_000) {
        lastLimitLog = Date.now();
        logger.error("retention", message, "The disk is still low and Looksee has rolled over everything it may. Free up space on this disk or make it larger.");
      }
      outcome = { action: "at_limit", message, deleted };
    }
    await db.update(retentionSettings).set({ lastRolloverAt: new Date(), lastRolloverMessage: outcome.message }).where(eq(retentionSettings.id, 1));
    return outcome;
  } finally {
    running = false;
  }
}

/**
 * Everything the Data retention page shows: settings, the disk, and each kind of
 * data's period, size and oldest row.
 */
export async function retentionStatus() {
  const settings = await getRetention();
  const path = storagePath(settings);
  let disk: DiskSpace | null = null;
  let diskError: string | null = null;
  try {
    disk = await readDisk(path);
  } catch (err) {
    diskError = err instanceof Error ? err.message : String(err);
  }
  const kinds = await Promise.all(
    DATA_KINDS.map(async (kind) => {
      const { rows } = await db.execute<{ oldest: string | null }>(sql`SELECT min(${kind.time}) AS oldest FROM ${kind.table}`);
      return { key: kind.key, label: kind.label, help: kind.help, rollover: kind.rollover, days: effectiveDays(kind, settings), saved: new Map(Object.entries(settings.days ?? {})).get(kind.key) ?? null, defaultDays: kind.defaultDays, minDays: kind.minDays ?? 1, bytes: await tableBytes(kind.table), oldest: rows[0].oldest };
    })
  );
  const { rows: size } = await db.execute<{ size: string }>(sql`SELECT pg_database_size(current_database()) AS size`);
  return {
    rolloverEnabled: settings.rolloverEnabled,
    minFreeMode: settings.minFreeMode,
    minFreeGb: settings.minFreeGb,
    minFreePercent: settings.minFreePercent,
    minKeepHours: settings.minKeepHours,
    storagePath: settings.storagePath,
    effectivePath: path,
    disk,
    diskError,
    limitBytes: disk ? minFreeBytes(settings, disk.totalBytes) : null,
    reusableBytes,
    databaseBytes: Number(size[0].size),
    lastRolloverAt: settings.lastRolloverAt,
    lastRolloverMessage: settings.lastRolloverMessage,
    kinds,
  };
}
