// The Express application: every API route, the security middleware in
// front of them, and the error handler behind them.
//
// Where this sits: index.ts imports this and starts the HTTP server; the tests
// import it directly (supertest) without opening a port. Express is the web
// framework; "middleware" are functions that run on every request before (or
// after) the route that answers it.
//
// Security: securityGate runs first on every request (IP blocks, the optional
// allowlist), security headers are added to every response, request bodies are
// size-limited and cleaned of characters the database can't store, CORS only
// allows the configured dashboard origin, and each router applies its own
// sign-in check (requireAuth / requireAgentAuth). Errors are logged without
// request data or query values.

import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pool } from "./db/index.js";
import { VERSION } from "./lib/version.js";
import { readAgentVersion } from "./lib/agentVersion.js";
import { logger } from "./lib/logger.js";
import { authRouter } from "./routes/auth.js";
import { sitesRouter } from "./routes/sites.js";
import { endpointsRouter } from "./routes/endpoints.js";
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
import { maintenanceRouter } from "./routes/maintenance.js";
import { statusPagesRouter } from "./routes/statusPages.js";
import { publicRouter } from "./routes/public.js";
import { insightsRouter } from "./routes/insights.js";
import { collectorRouter } from "./routes/collector.js";
import { locationsRouter } from "./routes/locations.js";
import { groupsRouter } from "./routes/groups.js";
import { treeRouter } from "./routes/tree.js";
import { exclusionsRouter } from "./routes/exclusions.js";
import { snmpTemplatesRouter } from "./routes/snmpTemplates.js";
import { securityRouter } from "./routes/security.js";
import { watchdogRouter } from "./routes/watchdog.js";
import { notFoundHandler, securityGate, securityHeaders } from "./middleware/securityGate.js";
import { requireAgentAuth } from "./middleware/auth.js";
import { stripNulBody } from "./lib/stripNul.js";
import { describeError, stackFrames } from "./lib/errorDetail.js";

// Largest request body accepted (express.json's "limit"). A first report
// from a busy machine — every process, service and installed program — is
// the biggest thing sent here.
const REPORT_LIMIT = "4mb";

const allowedOrigins = (process.env.CORS_ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

// Doesn't call app.listen() — that lives in index.ts — so tests can import
// this directly with supertest without binding a real port.
export const app = express();
app.disable("x-powered-by");
// Which X-Forwarded-For hops to believe for the client IP (blocks, the
// allowlist, lockouts and the event log all key on it). The default trusts
// proxies on private/loopback addresses — set TRUST_PROXY to the reverse
// proxy's exact IP in production (see .env.example).
app.set("trust proxy", process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal");
app.use(securityHeaders);

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(cookieParser());
// After CORS so a 403 still carries CORS headers the dashboard can read.
app.use(securityGate);
// Agents and site collectors are identified (by their bearer key) before
// their request body is read, so if the body is rejected — too large,
// malformed — the error below can still say which endpoint sent it. The
// routers check the key again; that second check returns immediately.
app.use(["/api/agent", "/api/collector"], requireAgentAuth);
// Agent reports carry a full metrics snapshot plus process/service lists;
// the 100 KB default is too small for a busy host.
app.use(express.json({ limit: REPORT_LIMIT }));
app.use(express.urlencoded({ extended: false }));
// Removes NUL characters (and half-characters) from every string in the
// parsed body: PostgreSQL refuses to store them, and one in an agent's
// software list used to make its whole report fail (lib/stripNul.ts).
app.use(stripNulBody);

app.use("/api/auth", authRouter);
app.use("/api/sites", sitesRouter);
app.use("/api/locations", locationsRouter);
app.use("/api/groups", groupsRouter);
app.use("/api/tree", treeRouter);
app.use("/api/exclusion-lists", exclusionsRouter);
app.use("/api/snmp-templates", snmpTemplatesRouter);
app.use("/api/security", securityRouter);
app.use("/api/watchdog", watchdogRouter);
app.use("/api/endpoints", endpointsRouter);
app.use("/api/checks", checksRouter);
app.use("/api/channels", channelsRouter);
app.use("/api/alert-rules", alertRulesRouter);
app.use("/api/agent", agentRouter);
app.use("/api/push", pushRouter);
app.use("/api/backups", backupsRouter);
app.use("/api/dashboards", dashboardsRouter);
app.use("/api/logs", logsRouter);
app.use("/api/smtp", smtpRouter);
app.use("/api/maintenance", maintenanceRouter);
app.use("/api/status-pages", statusPagesRouter);
app.use("/api/insights", insightsRouter);
app.use("/api/collector", collectorRouter);
// Unauthenticated: /api/hb/<token> (heartbeat/push URLs) and
// /api/public/status/<slug> (public status pages).
app.use("/api", publicRouter);
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

app.use(notFoundHandler);

// The error handler: Express sends here anything a route or middleware
// threw. Body-parser rejections (a body over REPORT_LIMIT, or JSON that
// doesn't parse) get their own 413/400 answer — the agent recognises 413 and
// resends a smaller report — instead of looking like a server fault.
// Everything else is logged and answered with a generic 500 that reveals
// nothing internal. Log lines name the agent's endpoint when there is one,
// and never include database query values (lib/errorDetail.ts).
app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
  const agent = req.agentEndpoint;
  const who = agent ? ` from endpoint "${agent.name}"${agent.hostname ? ` (${agent.hostname})` : ""}` : "";
  const meta = { method: req.method, path: req.originalUrl, ...(agent ? { endpointId: agent.id, endpointName: agent.name, hostname: agent.hostname } : {}) };
  // body-parser marks its own errors with a `type` and an HTTP `status`.
  const type = (err as { type?: unknown } | null)?.type;
  if (type === "entity.too.large" || type === "entity.parse.failed") {
    const tooLarge = type === "entity.too.large";
    logger.warn(
      "http",
      `${req.method} ${req.originalUrl}${who} rejected: ${tooLarge ? `body larger than ${REPORT_LIMIT}` : "body isn't valid JSON"}`,
      tooLarge ? `A request${who} was larger than the ${REPORT_LIMIT} limit and was refused.` : `A request${who} contained malformed JSON and was refused.`,
      meta
    );
    if (!res.headersSent) res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "Request body too large" : "Malformed JSON" });
    return;
  }
  logger.error(
    "http",
    `Unhandled error on ${req.method} ${req.originalUrl}${who}: ${describeError(err)}
${stackFrames(err)}`,
    `A request${who} failed unexpectedly — see the technical detail for what broke.`,
    meta
  );
  if (res.headersSent) {
    next(err);
    return;
  }
  res.status(500).json({ error: "Internal server error" });
});
