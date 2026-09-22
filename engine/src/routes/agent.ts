import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts, hostMetrics, checks } from "../db/schema.js";
import { requireAgentAuth } from "../middleware/auth.js";
import { recordCheckResult } from "../services/alerting.js";
import { logger } from "../lib/logger.js";

export const agentRouter = Router();
agentRouter.use(requireAgentAuth);

// GET /api/agent/config
// Tells the agent which agent_service checks it owns (id + config, e.g.
// { serviceName: "nginx" }) so it knows what to check locally and which
// checkId to report each result under. Polled periodically rather than
// pushed, so adding/removing a service check from the dashboard takes
// effect on the agent's next poll with no agent restart needed.
agentRouter.get("/config", async (req, res) => {
  const hostId = req.agentHost!.id;
  const rows = await db.query.checks.findMany({
    where: (c, { and, eq }) => and(eq(c.hostId, hostId), eq(c.type, "agent_service"), eq(c.enabled, true)),
  });
  logger.debug("agent", `Host ${hostId} polled /config, returned ${rows.length} agent_service check(s)`, { hostId, checkIds: rows.map((c) => c.id) });
  res.json({ checks: rows.map((c) => ({ id: c.id, config: c.config })) });
});

// POST /api/agent/report
// Body: { metrics?: {cpuPercent, memPercent, diskPercent, netRxBytes, netTxBytes},
//         services?: [{ checkId, running, message? }] }
// One combined endpoint rather than separate metrics/services calls — the
// agent already gathers both on the same tick, so one POST per report cycle
// keeps its HTTP client (and the engine's request logging) simple.
agentRouter.post("/report", async (req, res) => {
  const hostId = req.agentHost!.id;
  await db.update(hosts).set({ lastSeenAt: new Date() }).where(eq(hosts.id, hostId));

  const metrics = req.body?.metrics;
  if (metrics && typeof metrics === "object") {
    await db.insert(hostMetrics).values({
      hostId,
      cpuPercent: numberOrNull(metrics.cpuPercent),
      memPercent: numberOrNull(metrics.memPercent),
      diskPercent: numberOrNull(metrics.diskPercent),
      netRxBytes: numberOrNull(metrics.netRxBytes),
      netTxBytes: numberOrNull(metrics.netTxBytes),
    });
  }

  const services = Array.isArray(req.body?.services) ? req.body.services : [];
  let accepted = 0;
  for (const svc of services) {
    const checkId = String(svc?.checkId ?? "");
    if (!checkId) continue;
    const check = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
    // Only accept results for agent_service checks that actually belong to
    // this host — prevents one agent's token from writing another host's
    // check results.
    if (!check || check.hostId !== hostId || check.type !== "agent_service") continue;
    await recordCheckResult(checkId, svc.running ? "up" : "down", null, svc.message ? String(svc.message) : null);
    accepted++;
  }
  logger.debug("agent", `Host ${hostId} reported ${services.length} service result(s), ${accepted} accepted`, { hostId, reported: services.length, accepted });

  res.json({ ok: true });
});

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
