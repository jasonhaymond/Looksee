import { Router } from "express";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts, hostMetrics, checks, AGENT_CHECK_TYPES, HOST_METRIC_CHECK_TYPES } from "../db/schema.js";
import { requireAgentAuth } from "../middleware/auth.js";
import { recordCheckResult } from "../services/alerting.js";
import { logger } from "../lib/logger.js";

export const agentRouter = Router();
agentRouter.use(requireAgentAuth);

// GET /api/agent/config
// Tells the agent which of its agent-driven checks it owns (id + type +
// config, e.g. { serviceName: "nginx" }) so it knows what to check locally
// and which checkId to report each result under. Includes `type` so the
// agent can tell an "agent_service" check (real OS service manager) apart
// from an "agent_process" check (process-list name match) — it never had
// to before this split, since there was only one kind. Polled periodically
// rather than pushed, so adding/removing a check from the dashboard takes
// effect on the agent's next poll with no agent restart needed.
agentRouter.get("/config", async (req, res) => {
  const hostId = req.agentHost!.id;
  const rows = await db.query.checks.findMany({
    where: (c, { and, eq, inArray }) => and(eq(c.hostId, hostId), inArray(c.type, AGENT_CHECK_TYPES), eq(c.enabled, true)),
  });

  // Push-to-update: one-shot — consumed (flipped back to false) as soon as
  // it's read, regardless of whether the agent actually manages to update.
  // A stuck/failed update just means clicking "Update agent" again; there's
  // no separate in-progress state to get out of sync.
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, hostId) });
  const updateAvailable = host?.updateRequested ?? false;
  if (updateAvailable) {
    await db.update(hosts).set({ updateRequested: false }).where(eq(hosts.id, hostId));
    logger.info("agent", `Host ${hostId} polled /config with an update pending — flag consumed`, `An agent update was requested for this host and has been handed off.`, { hostId });
  }

  logger.debug("agent", `Host ${hostId} polled /config, returned ${rows.length} check(s)`, { hostId, checkIds: rows.map((c) => c.id) });
  res.json({ checks: rows.map((c) => ({ id: c.id, type: c.type, config: c.config })), updateAvailable });
});

// POST /api/agent/report
// Body: { metrics?: {cpuPercent, memPercent, diskPercent, netRxBytes, netTxBytes},
//         services?: [{ checkId, running, message? }],
//         availableProcesses?: string[], availableServices?: string[] }
// One combined endpoint rather than separate calls — the agent already
// gathers all of this on the same tick, so one POST per report cycle keeps
// its HTTP client (and the engine's request logging) simple.
// availableProcesses/availableServices are a snapshot of what the agent
// actually found on this host, used to populate the check form's name
// suggestions (see hosts.availableProcesses/availableServices in
// schema.ts) — not something every agent build necessarily sends, so both
// are optional and only overwrite the stored snapshot when present.
agentRouter.post("/report", async (req, res) => {
  const hostId = req.agentHost!.id;
  const hostUpdate: Partial<typeof hosts.$inferInsert> = { lastSeenAt: new Date() };
  if (Array.isArray(req.body?.availableProcesses)) {
    hostUpdate.availableProcesses = req.body.availableProcesses.map(String);
  }
  if (Array.isArray(req.body?.availableServices)) {
    hostUpdate.availableServices = req.body.availableServices.map(String);
  }
  if (typeof req.body?.version === "string" && req.body.version) {
    hostUpdate.agentVersion = req.body.version;
  }
  await db.update(hosts).set(hostUpdate).where(eq(hosts.id, hostId));

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

    // OS threshold checks (host_cpu/host_memory/host_disk) — evaluated here
    // against the metrics this same report just carried, rather than a
    // separate poll cycle. The agent has sent this data every cycle since
    // v1.0.0; nothing alerted on it until now.
    const metricByType: Partial<Record<(typeof HOST_METRIC_CHECK_TYPES)[number], number | null>> = {
      host_cpu: numberOrNull(metrics.cpuPercent),
      host_memory: numberOrNull(metrics.memPercent),
      host_disk: numberOrNull(metrics.diskPercent),
    };
    const thresholdChecks = await db.query.checks.findMany({
      where: (c, { and, eq, inArray }) => and(eq(c.hostId, hostId), inArray(c.type, HOST_METRIC_CHECK_TYPES), eq(c.enabled, true)),
    });
    for (const check of thresholdChecks) {
      const value = metricByType[check.type as (typeof HOST_METRIC_CHECK_TYPES)[number]];
      if (value == null) continue;
      const { warnPercent, criticalPercent } = check.config as { warnPercent?: number; criticalPercent?: number };
      let status: "up" | "warn" | "down" = "up";
      if (criticalPercent != null && value >= criticalPercent) status = "down";
      else if (warnPercent != null && value >= warnPercent) status = "warn";
      await recordCheckResult(check.id, status, null, status !== "up" ? `${value}%` : null);
    }
  }

  const services = Array.isArray(req.body?.services) ? req.body.services : [];
  let accepted = 0;
  for (const svc of services) {
    const checkId = String(svc?.checkId ?? "");
    if (!checkId) continue;
    const check = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
    // Only accept results for agent-driven checks that actually belong to
    // this host — prevents one agent's token from writing another host's
    // check results.
    if (!check || check.hostId !== hostId || !(AGENT_CHECK_TYPES as readonly string[]).includes(check.type)) continue;
    await recordCheckResult(checkId, svc.running ? "up" : "down", null, svc.message ? String(svc.message) : null);
    accepted++;
  }
  logger.debug("agent", `Host ${hostId} reported ${services.length} service result(s), ${accepted} accepted`, { hostId, reported: services.length, accepted });

  res.json({ ok: true });
});

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
