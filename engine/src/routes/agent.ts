import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts, hostMetrics, checks, AGENT_CHECK_TYPES, REPORT_CHECK_TYPES, REMOTE_PROBE_CHECK_TYPES } from "../db/schema.js";
import { minAgentVersionFor, versionAtLeast } from "../db/checkTypes.js";
import { requireAgentAuth } from "../middleware/auth.js";
import { recordCheckResult } from "../services/alerting.js";
import { applyThresholds, type Status } from "../services/thresholds.js";
import { evaluateChange, evaluateHostMetric, evaluateReboot, type Snapshot } from "../services/hostMetrics.js";
import { logger } from "../lib/logger.js";

export const agentRouter = Router();
agentRouter.use(requireAgentAuth);

const STATUSES = new Set(["up", "down", "warn", "unknown"]);

// GET /api/agent/config
// The checks this host's agent should run: its own agent_* checks plus any
// engine-type checks pinned to it as a remote probe (probeHostId). Polled
// every cycle, so dashboard edits take effect without an agent restart.
// Types newer than the running agent understands are withheld and recorded
// as a warn instead, so an old agent never reports them as "down".
agentRouter.get("/config", async (req, res) => {
  const hostId = req.agentHost!.id;
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, hostId) });
  const owned = await db.query.checks.findMany({
    where: and(eq(checks.hostId, hostId), inArray(checks.type, AGENT_CHECK_TYPES), eq(checks.enabled, true)),
  });
  const probes = await db.query.checks.findMany({
    where: and(eq(checks.probeHostId, hostId), inArray(checks.type, REMOTE_PROBE_CHECK_TYPES), eq(checks.enabled, true)),
  });
  const agentVersion = host?.agentVersion ?? null;
  const sendable: typeof owned = [];
  for (const c of [...owned, ...probes]) {
    const min = minAgentVersionFor(c.type) ?? (c.probeHostId === hostId ? "3.0.0" : undefined);
    if (min && !versionAtLeast(agentVersion, min)) {
      if (c.lastMessage?.startsWith("Needs agent") !== true || !c.lastCheckedAt || Date.now() - c.lastCheckedAt.getTime() > 600_000) {
        await recordCheckResult(c.id, { status: "warn", message: `Needs agent ${min}+ (this host runs ${agentVersion ?? "an unknown version"}) — use "Update agent" on the Hosts page` });
      }
      continue;
    }
    sendable.push(c);
  }

  // Push-to-update: one-shot — consumed (flipped back to false) as soon as
  // it's read, regardless of whether the agent actually manages to update.
  const updateAvailable = host?.updateRequested ?? false;
  if (updateAvailable) {
    await db.update(hosts).set({ updateRequested: false }).where(eq(hosts.id, hostId));
    logger.info("agent", `Host ${hostId} polled /config with an update pending — flag consumed`, `An agent update was requested for this host and has been handed off.`, { hostId });
  }

  logger.debug("agent", `Host ${hostId} polled /config, returned ${sendable.length} check(s)`, { hostId, checkIds: sendable.map((c) => c.id) });
  res.json({ checks: sendable.map((c) => ({ id: c.id, type: c.type, config: c.config, intervalSeconds: c.intervalSeconds })), updateAvailable });
});

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

type AgentResult = { checkId?: unknown; status?: unknown; running?: unknown; message?: unknown; value?: unknown; details?: unknown; latencyMs?: unknown };

// POST /api/agent/report
// Body (3.x): { metrics: {cpuPercent, memPercent, diskPercent, netRxBytes,
//   netTxBytes, extended?}, results?: [{checkId, status, message?, value?,
//   details?, latencyMs?}], inventory?, availableProcesses?, availableServices?,
//   availableContainers?, version }
// Pre-3.0 agents send `services: [{checkId, running, message?}]` instead of
// `results`; both are accepted.
agentRouter.post("/report", async (req, res) => {
  const hostId = req.agentHost!.id;
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, hostId) });
  const body = req.body ?? {};
  const hostUpdate: Partial<typeof hosts.$inferInsert> = { lastSeenAt: new Date() };
  if (Array.isArray(body.availableProcesses)) hostUpdate.availableProcesses = body.availableProcesses.map(String);
  if (Array.isArray(body.availableServices)) hostUpdate.availableServices = body.availableServices.map(String);
  if (typeof body.version === "string" && body.version) hostUpdate.agentVersion = body.version;
  if (body.inventory && typeof body.inventory === "object") hostUpdate.inventory = body.inventory;

  const metrics = body.metrics;
  const extended: Snapshot | null = metrics?.extended && typeof metrics.extended === "object" ? metrics.extended : null;
  if (extended) {
    // Container names ride along with the snapshot for the check form's
    // suggestions, the same way processes/services do.
    hostUpdate.lastSnapshot = { ...extended, availableContainers: Array.isArray(body.availableContainers) ? body.availableContainers.map(String) : undefined };
  }
  await db.update(hosts).set(hostUpdate).where(eq(hosts.id, hostId));

  if (metrics && typeof metrics === "object") {
    await db.insert(hostMetrics).values({
      hostId,
      cpuPercent: numberOrNull(metrics.cpuPercent),
      memPercent: numberOrNull(metrics.memPercent),
      diskPercent: numberOrNull(metrics.diskPercent),
      netRxBytes: numberOrNull(metrics.netRxBytes),
      netTxBytes: numberOrNull(metrics.netTxBytes),
      extended,
    });
    await evaluateReportChecks(hostId, metrics, extended, (hostUpdate.inventory ?? host?.inventory ?? null) as Record<string, unknown> | null);
  }

  const results: AgentResult[] = [...(Array.isArray(body.results) ? body.results : []), ...(Array.isArray(body.services) ? body.services : [])];
  let accepted = 0;
  for (const r of results) {
    const checkId = String(r?.checkId ?? "");
    if (!checkId) continue;
    const check = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
    // Only results for checks this host actually owns (or probes for) are
    // accepted — one agent's token can't write another host's results.
    const owns = check && ((check.hostId === hostId && (AGENT_CHECK_TYPES as readonly string[]).includes(check.type)) || (check.probeHostId === hostId && (REMOTE_PROBE_CHECK_TYPES as readonly string[]).includes(check.type)));
    if (!check || !owns) continue;
    const status: Status = typeof r.status === "string" && STATUSES.has(r.status) ? (r.status as Status) : r.running ? "up" : "down";
    const measured = applyThresholds(
      {
        status,
        latencyMs: numberOrNull(r.latencyMs),
        message: r.message ? String(r.message).slice(0, 2000) : null,
        value: numberOrNull(r.value),
        details: r.details ?? null,
      },
      (check.config as Record<string, unknown>) ?? {}
    );
    // Engine-side state for agent checks whose meaning depends on history
    // (a file checksum baseline, a service restart counter).
    const stateful = await applyAgentState(check, measured);
    await recordCheckResult(checkId, stateful);
    accepted++;
  }
  logger.debug("agent", `Host ${hostId} reported ${results.length} result(s), ${accepted} accepted`, { hostId, reported: results.length, accepted });
  res.json({ ok: true });
});

async function evaluateReportChecks(hostId: string, metrics: Record<string, unknown>, extended: Snapshot | null, inventory: Record<string, unknown> | null) {
  const reportChecks = await db.query.checks.findMany({
    where: and(eq(checks.hostId, hostId), inArray(checks.type, REPORT_CHECK_TYPES), eq(checks.enabled, true)),
  });
  for (const check of reportChecks) {
    const config = (check.config as Record<string, unknown>) ?? {};
    const state = (check.state as Record<string, unknown>) ?? {};
    if (check.type === "host_cpu" || check.type === "host_memory" || check.type === "host_disk") {
      const value = numberOrNull(check.type === "host_cpu" ? metrics.cpuPercent : check.type === "host_memory" ? metrics.memPercent : metrics.diskPercent);
      if (value == null) continue;
      const { warnPercent, criticalPercent } = config as { warnPercent?: number; criticalPercent?: number };
      let status: Status = "up";
      if (criticalPercent != null && value >= criticalPercent) status = "down";
      else if (warnPercent != null && value >= warnPercent) status = "warn";
      await recordCheckResult(check.id, { status, message: status !== "up" ? `${Math.round(value * 10) / 10}%` : null, value });
      continue;
    }
    // host_metric/host_reboot/host_change need the 3.x extended snapshot;
    // /config already records a "needs agent 3.0" warn for older agents.
    if (!extended) continue;
    if (check.type === "host_metric") {
      const result = evaluateHostMetric(extended, config);
      if (result) await recordCheckResult(check.id, result);
    } else if (check.type === "host_reboot") {
      const { result, state: next } = evaluateReboot(extended, config, state);
      await db.update(checks).set({ state: next }).where(eq(checks.id, check.id));
      await recordCheckResult(check.id, result);
    } else if (check.type === "host_change") {
      const { result, state: next } = evaluateChange(extended, inventory, config, state);
      await db.update(checks).set({ state: next }).where(eq(checks.id, check.id));
      await recordCheckResult(check.id, result);
    }
  }
}

type Measured = ReturnType<typeof applyThresholds<{ status: Status; latencyMs: number | null; message: string | null; value?: number | null; details?: unknown }>>;

async function applyAgentState(check: typeof checks.$inferSelect, result: Measured): Promise<Measured> {
  const config = (check.config as Record<string, unknown>) ?? {};
  const state = (check.state as Record<string, unknown>) ?? {};
  const hold = Number(config.holdMinutes ?? 15) * 60_000;
  const holdStatus: Status = String(config.severity ?? "warn") === "down" ? "down" : "warn";

  // D6: checksum drift. An explicit expected checksum wins; otherwise the
  // first value seen becomes the baseline.
  if (check.type === "agent_file" && config.mode === "checksum" && result.status === "up") {
    const sum = (result.details as { sha256?: string } | null)?.sha256;
    if (!sum) return result;
    const expected = String(config.expectedChecksum ?? "").toLowerCase();
    if (expected) return sum === expected ? result : { ...result, status: "down", message: `Checksum ${sum.slice(0, 16)}… doesn't match the expected value` };
    const next = { ...state, baseline: state.baseline ?? sum, changedAt: state.baseline && state.baseline !== sum && state.last !== sum ? Date.now() : state.changedAt, last: sum };
    await db.update(checks).set({ state: next }).where(eq(checks.id, check.id));
    if (next.baseline !== sum && next.changedAt && Date.now() - Number(next.changedAt) < hold) return { ...result, status: holdStatus, message: `File changed (sha256 ${sum.slice(0, 16)}…)` };
    if (next.baseline !== sum && bool(config.acceptNewBaseline)) await db.update(checks).set({ state: { ...next, baseline: sum } }).where(eq(checks.id, check.id));
    return result;
  }

  // F3: restarts since the previous report, from systemd's NRestarts.
  if (check.type === "agent_service" && config.maxRestarts !== undefined && config.maxRestarts !== "") {
    const restarts = (result.details as { restarts?: number } | null)?.restarts;
    if (restarts == null) return result;
    const prev = state.restarts as number | undefined;
    const delta = prev != null && restarts >= prev ? restarts - prev : 0;
    const window = ((state.window as { at: number; n: number }[] | undefined) ?? []).filter((w) => Date.now() - w.at < 3_600_000);
    if (delta > 0) window.push({ at: Date.now(), n: delta });
    await db.update(checks).set({ state: { restarts, window } }).where(eq(checks.id, check.id));
    const lastHour = window.reduce((a, w) => a + w.n, 0);
    if (lastHour > Number(config.maxRestarts)) return { ...result, status: "warn", message: `Restarted ${lastHour} time(s) in the last hour (systemd)`, value: lastHour };
    return { ...result, value: lastHour };
  }

  // D-watchdog / docker restart counter / other event-style results the
  // agent marks with details.event: hold the failing status for holdMinutes.
  if ((result.details as { event?: boolean } | null)?.event) {
    const next = { ...state, eventAt: Date.now(), eventMessage: result.message };
    await db.update(checks).set({ state: next }).where(eq(checks.id, check.id));
    return result;
  }
  if (state.eventAt && Date.now() - Number(state.eventAt) < hold && result.status === "up" && (check.type === "agent_file" || check.type === "agent_docker")) {
    return { ...result, status: holdStatus, message: `${state.eventMessage} (${Math.round((Date.now() - Number(state.eventAt)) / 60_000)} min ago)` };
  }
  return result;
}

const bool = (v: unknown) => v === true || v === "true";
