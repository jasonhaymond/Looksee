import express from "express";
import "express-async-errors";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pool } from "./db/index.js";
import { VERSION } from "./lib/version.js";
import { readAgentVersion } from "./lib/agentVersion.js";
import { logger } from "./lib/logger.js";
import { authRouter } from "./routes/auth.js";
import { sitesRouter } from "./routes/sites.js";
import { hostsRouter } from "./routes/hosts.js";
import { checksRouter } from "./routes/checks.js";
import { channelsRouter } from "./routes/channels.js";
import { alertRulesRouter } from "./routes/alertRules.js";
import { agentRouter } from "./routes/agent.js";
import { pushRouter } from "./routes/push.js";
import { backupsRouter } from "./routes/backups.js";
import { dashboardsRouter } from "./routes/dashboards.js";
import { installRouter } from "./routes/install.js";
import { logsRouter } from "./routes/logs.js";
import { smtpRouter } from "./routes/smtp.js";

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Doesn't call app.listen() — that lives in index.ts — so tests can import
// this directly with supertest without binding a real port.
export const app = express();
app.disable("x-powered-by");

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(cookieParser());
app.use(express.json());

app.use("/api/auth", authRouter);
app.use("/api/sites", sitesRouter);
app.use("/api/hosts", hostsRouter);
app.use("/api/checks", checksRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/alert-rules", alertRulesRouter);
app.use("/api/agent", agentRouter);
app.use("/api/push", pushRouter);
app.use("/api/backups", backupsRouter);
app.use("/api/dashboards", dashboardsRouter);
app.use("/api/logs", logsRouter);
app.use("/api/smtp", smtpRouter);
// Outside /api on purpose — meant for plain curl, not the JSON API, and
// deliberately unauthenticated (see routes/install.ts for why).
app.use("/install", installRouter);

// Verifies the process can actually reach Postgres, not just that it's up —
// the more useful signal for deploy/update scripts and any future uptime
// monitor pointed at this endpoint. Unauthenticated by design: external
// monitors need to reach it without credentials.
app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", db: "connected", version: VERSION, agentVersion: readAgentVersion() });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    logger.error("http", `Health check DB query failed: ${detail}`, "The engine can't reach its database right now.");
    res.status(500).json({ status: "error", db: "unreachable", version: VERSION, agentVersion: readAgentVersion() });
  }
});

app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  logger.error(
    "http",
    `Unhandled error on ${req.method} ${req.originalUrl}: ${detail}`,
    "A request failed unexpectedly — see the technical detail for what broke.",
    { method: req.method, path: req.originalUrl }
  );
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});
