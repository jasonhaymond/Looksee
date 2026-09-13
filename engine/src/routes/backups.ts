import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import cron from "node-cron";
import { db } from "../db/index.js";
import { backupRuns, backupSettings } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import {
  checkBorgAvailable,
  ensureBackupSshKey,
  getCurrentOperation,
  listArchives,
  rescheduleBackupCron,
  restoreBackup,
  runBackup,
} from "../services/backup.js";

export const backupsRouter = Router();
backupsRouter.use(requireAuth);

function publicSettings(row: typeof backupSettings.$inferSelect) {
  const { passphrase, ...rest } = row;
  return { ...rest, passphraseSet: Boolean(passphrase) };
}

backupsRouter.get("/settings", async (_req, res) => {
  const [row] = await db
    .insert(backupSettings)
    .values({ id: 1 })
    .onConflictDoNothing({ target: backupSettings.id })
    .returning();
  const settings = row ?? (await db.select().from(backupSettings).where(eq(backupSettings.id, 1)).limit(1))[0];
  const borgVersion = await checkBorgAvailable();
  res.json({ settings: publicSettings(settings), borgAvailable: Boolean(borgVersion), borgVersion });
});

backupsRouter.patch("/settings", async (req, res) => {
  const { repoUrl, passphrase, schedule, retentionCount } = req.body ?? {};

  if (repoUrl !== undefined && typeof repoUrl !== "string") {
    res.status(400).json({ error: "repoUrl must be a string" });
    return;
  }
  if (passphrase !== undefined && typeof passphrase !== "string") {
    res.status(400).json({ error: "passphrase must be a string" });
    return;
  }
  if (schedule !== undefined && schedule !== null && (typeof schedule !== "string" || !cron.validate(schedule))) {
    res.status(400).json({ error: "schedule must be a valid 5-field cron expression, or null to disable" });
    return;
  }
  if (retentionCount !== undefined && retentionCount !== null && !Number.isInteger(retentionCount)) {
    res.status(400).json({ error: "retentionCount must be an integer, or null for no automatic pruning" });
    return;
  }

  const [updated] = await db
    .insert(backupSettings)
    .values({
      id: 1,
      repoUrl: repoUrl || null,
      passphrase: passphrase || null,
      schedule: schedule ?? null,
      retentionCount: retentionCount ?? null,
    })
    .onConflictDoUpdate({
      target: backupSettings.id,
      set: {
        ...(repoUrl !== undefined && { repoUrl: repoUrl || null }),
        ...(passphrase !== undefined && { passphrase: passphrase || null }),
        ...(schedule !== undefined && { schedule }),
        ...(retentionCount !== undefined && { retentionCount }),
        updatedAt: new Date(),
      },
    })
    .returning();

  if (schedule !== undefined) rescheduleBackupCron(updated.schedule);
  res.json({ settings: publicSettings(updated) });
});

backupsRouter.get("/ssh-public-key", async (_req, res) => {
  try {
    res.json({ publicKey: await ensureBackupSshKey() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not generate/read the SSH key" });
  }
});

backupsRouter.get("/status", async (_req, res) => {
  const borgVersion = await checkBorgAvailable();
  res.json({ borgAvailable: Boolean(borgVersion), borgVersion, currentOperation: getCurrentOperation() });
});

backupsRouter.get("/runs", async (_req, res) => {
  const rows = await db.select().from(backupRuns).orderBy(desc(backupRuns.startedAt)).limit(50);
  res.json({ runs: rows });
});

backupsRouter.get("/archives", async (_req, res) => {
  try {
    res.json({ archives: await listArchives() });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : "Could not list archives" });
  }
});

backupsRouter.post("/run", async (_req, res) => {
  if (getCurrentOperation()) {
    res.status(409).json({ error: `A ${getCurrentOperation()!.kind} is already in progress.` });
    return;
  }
  runBackup().catch((err) => {
    console.error("Backup failed:", err instanceof Error ? err.message : err);
  });
  res.status(202).json({ started: true });
});

// Requires confirmArchiveName to exactly match archiveName as a server-side
// backstop — this can overwrite the live database, so it never trusts
// client-side typed-confirmation UI alone.
backupsRouter.post("/restore", async (req, res) => {
  const { archiveName, confirmArchiveName, restoreDb, restoreConfig } = req.body ?? {};

  if (typeof archiveName !== "string" || !archiveName) {
    res.status(400).json({ error: "archiveName is required" });
    return;
  }
  if (confirmArchiveName !== archiveName) {
    res.status(400).json({ error: "confirmArchiveName must exactly match archiveName" });
    return;
  }
  if (!restoreDb && !restoreConfig) {
    res.status(400).json({ error: "Select at least one of restoreDb or restoreConfig" });
    return;
  }
  if (getCurrentOperation()) {
    res.status(409).json({ error: `A ${getCurrentOperation()!.kind} is already in progress.` });
    return;
  }

  restoreBackup(archiveName, { restoreDb: Boolean(restoreDb), restoreConfig: Boolean(restoreConfig) }).catch((err) => {
    console.error("Restore failed:", err instanceof Error ? err.message : err);
  });
  res.status(202).json({ started: true });
});
