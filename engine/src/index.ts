import "dotenv/config";
import cron from "node-cron";
import { app } from "./app.js";
import { startScheduler } from "./services/scheduler.js";
import { initBackupScheduler } from "./services/backup.js";
import { db } from "./db/index.js";
import { appMeta } from "./db/schema.js";
import { VERSION } from "./lib/version.js";
import { logger, pruneLogs } from "./lib/logger.js";

const port = Number(process.env.PORT ?? 4100);

app.listen(port, () => {
  logger.info("engine", `Looksee engine listening on http://localhost:${port}`, "Looksee engine started and is ready.");
});

// Upserted on every successful boot, not just deploys, so this reflects
// what's actually been running rather than what a deploy script assumed —
// see services/backup.ts's newArchiveName, which stamps backup filenames
// with this value.
db.insert(appMeta)
  .values({ id: 1, version: VERSION })
  .onConflictDoUpdate({ target: appMeta.id, set: { version: VERSION, updatedAt: new Date() } })
  .catch((err) => {
    logger.error("engine", `Failed to stamp app_meta with the running version: ${err instanceof Error ? err.message : String(err)}`, "Couldn't record the running app version in the database — backup filenames may fall back to the build-time version.");
  });

// Daily, off-peak-ish; exact time doesn't matter for a personal homelab tool.
cron.schedule("30 3 * * *", () => {
  pruneLogs().catch((err) => {
    logger.error("engine", `Log retention prune failed: ${err instanceof Error ? err.message : String(err)}`, "Old log entries weren't cleaned up — the logs table may grow larger than usual until the next attempt.");
  });
});

startScheduler();

initBackupScheduler().catch((err) => {
  logger.error("engine", `Failed to initialize backup scheduler: ${err instanceof Error ? err.message : String(err)}`, "Scheduled backups won't run until this is fixed — check your backup settings.");
});

// Backstop for async code running detached from the request lifecycle (see
// app.ts's express-async-errors import for the common in-request case) —
// keeps one stray rejection from taking down the whole process.
process.on("unhandledRejection", (reason) => {
  logger.error("engine", `Unhandled promise rejection outside the request lifecycle: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`, "Something failed in the background outside of a normal request — the process kept running, but this is worth a look.");
});
