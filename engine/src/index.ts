import "dotenv/config";
import { app } from "./app.js";
import { startScheduler } from "./services/scheduler.js";
import { initBackupScheduler } from "./services/backup.js";

const port = Number(process.env.PORT ?? 4100);

app.listen(port, () => {
  console.log(`Looksee engine listening on http://localhost:${port}`);
});

startScheduler();

initBackupScheduler().catch((err) => {
  console.error("Failed to initialize backup scheduler:", err);
});

// Backstop for async code running detached from the request lifecycle (see
// app.ts's express-async-errors import for the common in-request case) —
// keeps one stray rejection from taking down the whole process.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection outside the request lifecycle:", reason);
});
