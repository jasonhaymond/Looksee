/**
 * Backup/restore orchestration via the `borg` CLI, covering the Postgres
 * database and the two secret-bearing env files (engine/.env,
 * dashboard/.env). Assumes the deployment shape in
 * docs/deployment-guide.md: Postgres in the `postgres` docker-compose
 * service, reached via `docker compose exec`, with this engine process
 * running directly on the host (not itself containerized).
 *
 * The `borg`/`docker compose` command shapes here (including the
 * `borg list --json` field names in listArchives) were verified against a
 * real installed `borg 1.2.4` binary in an isolated container during
 * development — init/create/list/extract/info/prune all confirmed working
 * with these exact flags. What's NOT been exercised is the full pipeline
 * integrated with this app's own Postgres/env files on a real Linux
 * deployment — do one real backup + restore there before trusting it with
 * data that matters, the same way scripts/restore.sh's plain-pg_dump path
 * was smoke-tested for real (see CHANGELOG).
 */
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import cron from "node-cron";
import { db } from "../db/index.js";
import { backupRuns, backupSettings } from "../db/schema.js";
import { run } from "../lib/shell.js";
import { VERSION } from "../lib/version.js";
import { logger } from "../lib/logger.js";

type BackupSettingsRow = typeof backupSettings.$inferSelect;

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const engineEnvPath = path.join(repoRoot, "engine", ".env");
const dashboardEnvPath = path.join(repoRoot, "dashboard", ".env");

// A dedicated SSH keypair for reaching a remote Borg repository, kept
// separate from any ambient SSH identity this host's user account has — an
// admin authorizes backups on a remote server by adding just this one
// public key, without handing over whatever else that user's key can reach.
const sshKeyDir = path.join(repoRoot, "engine", ".backup-ssh");
const sshPrivateKeyPath = path.join(sshKeyDir, "id_ed25519");
const sshPublicKeyPath = `${sshPrivateKeyPath}.pub`;

export async function ensureBackupSshKey(): Promise<string> {
  await fsp.mkdir(sshKeyDir, { recursive: true });
  if (!fs.existsSync(sshPrivateKeyPath)) {
    await run("ssh-keygen", ["-t", "ed25519", "-f", sshPrivateKeyPath, "-N", "", "-C", "looksee-backup"]);
  }
  return (await fsp.readFile(sshPublicKeyPath, "utf8")).trim();
}

function sshEnv(): NodeJS.ProcessEnv {
  return {
    BORG_RSH: `ssh -i ${sshPrivateKeyPath} -o StrictHostKeyChecking=accept-new -o BatchMode=yes`,
  };
}

export async function checkBorgAvailable(): Promise<string | null> {
  try {
    return (await run("borg", ["--version"])).trim();
  } catch {
    return null;
  }
}

async function getSettings(): Promise<BackupSettingsRow> {
  const [row] = await db
    .insert(backupSettings)
    .values({ id: 1 })
    .onConflictDoNothing({ target: backupSettings.id })
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(backupSettings).where(eq(backupSettings.id, 1)).limit(1);
  return existing;
}

function dbConnInfo(): { user: string; dbName: string } {
  const url = new URL(process.env.DATABASE_URL ?? "");
  return { user: decodeURIComponent(url.username), dbName: decodeURIComponent(url.pathname.replace(/^\//, "")) };
}

// Stamps the archive with the version actually running when it was taken —
// read from app_meta (upserted on every boot in index.ts), not package.json,
// since that's what can drift from what's actually running. Falls back to
// the in-process VERSION only if the row hasn't been populated yet (e.g. a
// backup triggered in the same instant as a very first boot).
async function newArchiveName(): Promise<string> {
  const meta = await db.query.appMeta.findFirst({ where: (m, { eq }) => eq(m.id, 1) });
  const version = meta?.version ?? VERSION;
  return `looksee-v${version}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

// Process-local, single-instance-scale guard against two operations
// clobbering the same staging directory/Postgres connection at once.
let currentOperation: { kind: "backup" | "restore"; startedAt: Date } | null = null;

export function getCurrentOperation() {
  return currentOperation;
}

export async function runBackup(): Promise<void> {
  if (currentOperation) throw new Error(`A ${currentOperation.kind} is already in progress.`);
  const settings = await getSettings();
  if (!settings.repoUrl || !settings.passphrase) {
    throw new Error("Backup repository and passphrase must be configured before running a backup.");
  }

  currentOperation = { kind: "backup", startedAt: new Date() };
  const archiveName = await newArchiveName();
  const [runRow] = await db.insert(backupRuns).values({ kind: "backup", archiveName }).returning();
  const stagingDir = await fsp.mkdtemp(path.join(os.tmpdir(), "looksee-backup-"));

  try {
    const { user, dbName } = dbConnInfo();
    await run("docker", ["compose", "exec", "-T", "postgres", "pg_dump", "-U", user, "-Fc", dbName], {
      cwd: repoRoot,
      stdoutFile: path.join(stagingDir, "db.dump"),
    });

    await fsp.copyFile(engineEnvPath, path.join(stagingDir, "engine.env")).catch(() => {});
    await fsp.copyFile(dashboardEnvPath, path.join(stagingDir, "dashboard.env")).catch(() => {});

    await ensureRepoInitialized(settings.repoUrl, settings.passphrase);
    await run("borg", ["create", "--compression", "zstd", `${settings.repoUrl}::${archiveName}`, "."], {
      cwd: stagingDir,
      env: { BORG_PASSPHRASE: settings.passphrase, ...sshEnv() },
    });

    if (settings.retentionCount) {
      await run("borg", ["prune", "--keep-last", String(settings.retentionCount), settings.repoUrl], {
        env: { BORG_PASSPHRASE: settings.passphrase, ...sshEnv() },
      });
    }

    await db
      .update(backupRuns)
      .set({ status: "success", message: "Backup completed.", finishedAt: new Date() })
      .where(eq(backupRuns.id, runRow.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(backupRuns).set({ status: "error", message, finishedAt: new Date() }).where(eq(backupRuns.id, runRow.id));
    throw err;
  } finally {
    currentOperation = null;
    await fsp.rm(stagingDir, { recursive: true, force: true });
  }
}

/**
 * Says why an archive's *database* can't be restored into the running
 * version, or null when it can.
 *
 * A database backup only fits the code version that made it: restoring,
 * say, a 4.3 backup into a running 5.0 engine would put back tables 5.0
 * renamed, leaving a database neither version can use (pg_restore's --clean
 * only replaces objects that are in the backup). So the in-app restore only
 * accepts a backup from the same MAJOR.MINOR version as the running code;
 * a different version is rolled back with scripts/restore.sh and
 * scripts/update.sh, which change the code and the database together.
 * Archives are named looksee-v<version>-<timestamp>; one without a version
 * in its name comes from before 4.0 and is refused too.
 *
 * @param archiveName the Borg archive name, e.g. "looksee-v5.0.0-2026-…"
 * @param running the running version (defaults to this build's)
 */
export function restoreVersionProblem(archiveName: string, running: string = VERSION): string | null {
  // Matches the "MAJOR.MINOR." at the start of the version in the name —
  // e.g. "looksee-v4.3.1-2026-10-19T…" gives 4 and 3.
  const from = /^looksee-v(\d+)\.(\d+)\./.exec(archiveName);
  const [major, minor] = running.split(".");
  if (from && from[1] === major && from[2] === minor) return null;
  const was = from ? `v${from[1]}.${from[2]}` : "an unknown version (before 4.0)";
  return `This backup's database is from ${was}, but this server runs v${running}. Restoring it here would mix two database layouts. To go back to that version, follow the deployment guide → Rolling back (scripts/restore.sh, then scripts/update.sh). Restoring only the config files is still possible here.`;
}

/**
 * Restores a Borg archive: its database dump and/or its env files.
 * Runs in the background (the route answers 202 straight away); progress
 * and the outcome are recorded in backup_runs. Destructive — the route
 * requires the archive name to be typed again to confirm.
 *
 * @param archiveName the archive to restore
 * @param options restoreDb replaces the live database's contents;
 *   restoreConfig overwrites engine/.env and dashboard/.env
 * @param repo repository and passphrase (defaults to the saved settings)
 * @throws if another backup/restore is running, the repository isn't set,
 *   or the database is from another version (see restoreVersionProblem)
 */
export async function restoreBackup(
  archiveName: string,
  options: { restoreDb: boolean; restoreConfig: boolean },
  repo?: { repoUrl: string; passphrase: string }
): Promise<void> {
  if (currentOperation) throw new Error(`A ${currentOperation.kind} is already in progress.`);
  const { repoUrl, passphrase } = repo ?? (await getSettings());
  if (!repoUrl || !passphrase) {
    throw new Error("A backup repository and passphrase are required to restore.");
  }

  // Checked here as well as in the route, so no caller can skip it.
  const versionProblem = options.restoreDb ? restoreVersionProblem(archiveName) : null;
  if (versionProblem) throw new Error(versionProblem);

  currentOperation = { kind: "restore", startedAt: new Date() };
  const [runRow] = await db.insert(backupRuns).values({ kind: "restore", archiveName }).returning();
  const extractDir = await fsp.mkdtemp(path.join(os.tmpdir(), "looksee-restore-"));

  try {
    await run("borg", ["extract", `${repoUrl}::${archiveName}`], {
      cwd: extractDir,
      env: { BORG_PASSPHRASE: passphrase, ...sshEnv() },
    });

    if (options.restoreDb) {
      const { user, dbName } = dbConnInfo();
      const dumpPath = path.join(extractDir, "db.dump");
      await fsp.access(dumpPath).catch(() => {
        throw new Error(`Archive "${archiveName}" doesn't contain a db.dump file — nothing to restore.`);
      });
      await run(
        "docker",
        ["compose", "exec", "-T", "postgres", "pg_restore", "-U", user, "--clean", "--if-exists", "-d", dbName],
        { cwd: repoRoot, stdinFile: dumpPath }
      );
    }

    if (options.restoreConfig) {
      await fsp.copyFile(path.join(extractDir, "engine.env"), engineEnvPath).catch(() => {});
      await fsp.copyFile(path.join(extractDir, "dashboard.env"), dashboardEnvPath).catch(() => {});
    }

    const successMessage = [
      options.restoreDb && "database restored",
      options.restoreConfig && "config files restored (restart the app to pick up any changes)",
    ]
      .filter(Boolean)
      .join("; ");
    await db
      .update(backupRuns)
      .set({ status: "success", message: successMessage, finishedAt: new Date() })
      .where(eq(backupRuns.id, runRow.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(backupRuns).set({ status: "error", message, finishedAt: new Date() }).where(eq(backupRuns.id, runRow.id));
    throw err;
  } finally {
    currentOperation = null;
    await fsp.rm(extractDir, { recursive: true, force: true });
  }
}

async function ensureRepoInitialized(repoUrl: string, passphrase: string): Promise<void> {
  try {
    await run("borg", ["info", repoUrl], { env: { BORG_PASSPHRASE: passphrase, ...sshEnv() } });
  } catch {
    await run("borg", ["init", "--encryption", "repokey-blake2", repoUrl], {
      env: { BORG_PASSPHRASE: passphrase, ...sshEnv() },
    });
  }
}

export type ArchiveInfo = { name: string; time: string };

export async function listArchives(repo?: { repoUrl: string; passphrase: string }): Promise<ArchiveInfo[]> {
  const { repoUrl, passphrase } = repo ?? (await getSettings());
  if (!repoUrl || !passphrase) return [];
  const out = await run("borg", ["list", "--json", repoUrl], {
    env: { BORG_PASSPHRASE: passphrase, ...sshEnv() },
  });
  const parsed: { archives?: { name: string; time?: string; start?: string }[] } = JSON.parse(out);
  return (parsed.archives ?? [])
    .map((a) => ({ name: a.name, time: a.time ?? a.start ?? "" }))
    .sort((a, b) => b.time.localeCompare(a.time));
}

let scheduledTask: ReturnType<typeof cron.schedule> | null = null;

export function rescheduleBackupCron(cronExpression: string | null): void {
  if (scheduledTask) {
    scheduledTask.stop();
    scheduledTask = null;
  }
  if (!cronExpression) return;
  scheduledTask = cron.schedule(cronExpression, () => {
    runBackup().catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error("backup", `Scheduled backup failed: ${detail}`, "A scheduled backup didn't complete — check the Backups page and your repository/passphrase settings.");
    });
  });
}

export async function initBackupScheduler(): Promise<void> {
  const settings = await getSettings();
  rescheduleBackupCron(settings.schedule);
}
