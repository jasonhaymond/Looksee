// API routes the Looksee agent calls: /api/agent/config (which checks to run,
// watchdog and software-scan settings, update and site-collector requests) and
// /api/agent/report (metrics, check results, inventories, software and
// watchdog status).
//
// Security: every route needs the agent's bearer key (requireAgentAuth), and an
// agent can only report results for checks that belong to its own endpoint (or
// that are pinned to it as a remote probe) — one agent's key can't write
// another endpoint's results. Reported data is size-limited and cleaned before
// it's stored.

import { Router } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { sites, endpoints, endpointMetrics, checks, AGENT_CHECK_TYPES, REPORT_CHECK_TYPES, REMOTE_PROBE_CHECK_TYPES } from "../db/schema.js";
import { minAgentVersionFor, versionAtLeast } from "../db/checkTypes.js";
import { requireAgentAuth } from "../middleware/auth.js";
import { recordCheckResult } from "../services/alerting.js";
import { applyThresholds, type Status } from "../services/thresholds.js";
import { evaluateChange, evaluateEndpointMetric, evaluateReboot, type Snapshot } from "../services/endpointMetrics.js";
import { logger } from "../lib/logger.js";
import { collectorManifest } from "../services/sites.js";
import { recordFromSnapshot } from "../services/addresses.js";
import { evaluateScriptOutput } from "../services/scriptOutput.js";
import { withExclusions } from "../services/exclusions.js";
import { cleanWatchdogStatus, watchdogSpecFor } from "../services/watchdogAgents.js";
import { cleanSoftware, evaluatePackages, evaluateSoftwareChange, lockfilesFrom, type SoftwareReport } from "../services/software.js";
import { own } from "../lib/own.js";

// Inventory rows the 4.0 agent sends every few cycles; anything else in the
// array is dropped so a malformed report can't bloat the endpoints table.
function cleanInventory(raw: unknown, keys: string[], max = 5000): Record<string, unknown>[] | null {
  if (!Array.isArray(raw)) return null;
  return raw.slice(0, max).filter((r) => r && typeof r === "object").map((r) => Object.fromEntries(keys.filter((k) => own(r as Record<string, unknown>, k) !== undefined).map((k) => [k, own(r as Record<string, unknown>, k)])));
}

export const agentRouter = Router();
agentRouter.use(requireAgentAuth);

const STATUSES = new Set(["up", "down", "warn", "unknown"]);

// GET /api/agent/config
// The checks this host's agent should run: its own agent_* checks plus any
// engine-type checks pinned to it as a remote probe (probeEndpointId). Polled
// every cycle, so dashboard edits take effect without an agent restart.
// Types newer than the running agent understands are withheld and recorded
// as a warn instead, so an old agent never reports them as "down".
agentRouter.get("/config", async (req, res) => {
  const endpointId = req.agentEndpoint!.id;
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) });
  const owned = await db.query.checks.findMany({
    where: and(eq(checks.endpointId, endpointId), inArray(checks.type, AGENT_CHECK_TYPES), eq(checks.enabled, true)),
  });
  const probes = await db.query.checks.findMany({
    where: and(eq(checks.probeEndpointId, endpointId), inArray(checks.type, REMOTE_PROBE_CHECK_TYPES), eq(checks.enabled, true)),
  });
  const agentVersion = host?.agentVersion ?? null;
  const sendable: typeof owned = [];
  for (const c of [...owned, ...probes]) {
    const min = minAgentVersionFor(c.type) ?? (c.probeEndpointId === endpointId ? "3.0.0" : undefined);
    if (min && !versionAtLeast(agentVersion, min)) {
      if (c.lastMessage?.startsWith("Needs agent") !== true || !c.lastCheckedAt || Date.now() - c.lastCheckedAt.getTime() > 600_000) {
        await recordCheckResult(c.id, { status: "warn", message: `Needs agent ${min}+ (this endpoint runs ${agentVersion ?? "an unknown version"}) — use "Update agent" on the Endpoints page` });
      }
      continue;
    }
    sendable.push(c);
  }

  // Push-to-update: one-shot — consumed (flipped back to false) as soon as
  // it's read, regardless of whether the agent actually manages to update.
  const updateAvailable = host?.updateRequested ?? false;
  if (updateAvailable) {
    await db.update(endpoints).set({ updateRequested: false }).where(eq(endpoints.id, endpointId));
    logger.info("agent", `Endpoint ${endpointId} polled /config with an update pending — flag consumed`, `An agent update was requested for this endpoint and has been handed off.`, { endpointId });
  }

  logger.debug("agent", `Endpoint ${endpointId} polled /config, returned ${sendable.length} check(s)`, { endpointId, checkIds: sendable.map((c) => c.id) });
  // Site collector: the agent downloads and supervises it while this host is
  // some endpoint's collector, and stops it otherwise.
  let collector: { version: string; node: string; bundleSha256: string } | null = null;
  if (await db.query.sites.findFirst({ where: eq(sites.collectorEndpointId, endpointId) })) {
    const manifest = collectorManifest();
    if (manifest) collector = { version: manifest.version, node: manifest.node, bundleSha256: manifest.bundle.sha256 };
    else await db.update(endpoints).set({ collectorError: "The site collector hasn't been built on the Looksee server yet — run scripts/update.sh there" }).where(eq(endpoints.id, endpointId));
  }

  // Each check's config goes out with its exclusions merged in (its own plus
  // any reusable lists), as one-per-line text that every agent version reads.
  const handedOut = await Promise.all(sendable.map(async (c) => ({ id: c.id, type: c.type, config: await withExclusions(c, true), intervalSeconds: c.intervalSeconds })));
  // Watchdog agents also get what they need to alert without Looksee (null
  // for every other endpoint; see services/watchdogAgents.ts).
  const watchdog = host ? await watchdogSpecFor(host) : null;
  // Lock files the endpoint's software checks want included in the
  // software report (only known lock-file names; see services/software.ts).
  const softwareChecks = await db.query.checks.findMany({ where: and(eq(checks.endpointId, endpointId), inArray(checks.type, ["host_vulnerable", "host_software"]), eq(checks.enabled, true)), columns: { config: true } });
  const softwareScan = { lockfiles: lockfilesFrom(softwareChecks.map((c) => (c.config as Record<string, unknown>) ?? {})) };
  res.json({ checks: handedOut, updateAvailable, collector, watchdog, softwareScan });
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
  const endpointId = req.agentEndpoint!.id;
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) });
  const body = req.body ?? {};
  const endpointUpdate: Partial<typeof endpoints.$inferInsert> = { lastSeenAt: new Date() };
  if (Array.isArray(body.availableProcesses)) endpointUpdate.availableProcesses = body.availableProcesses.map(String);
  if (Array.isArray(body.availableServices)) endpointUpdate.availableServices = body.availableServices.map(String);
  if (typeof body.version === "string" && body.version) endpointUpdate.agentVersion = body.version;
  if (body.inventory && typeof body.inventory === "object") endpointUpdate.inventory = body.inventory;
  const procs = cleanInventory(body.processInventory, ["pid", "name", "user", "cpuPercent", "memoryMb", "command", "started"]);
  const svcs = cleanInventory(body.serviceInventory, ["name", "displayName", "state", "startType", "description"]);
  if (procs) endpointUpdate.processInventory = procs;
  if (svcs) endpointUpdate.serviceInventory = svcs;
  if (procs || svcs) endpointUpdate.inventoryUpdatedAt = new Date();
  if (Array.isArray(body.availableScripts)) endpointUpdate.availableScripts = body.availableScripts.map(String).slice(0, 500);
  // The agent's side of running a site collector (download/start failures);
  // the collector clears it once it's up and polling.
  if (typeof body.collectorError === "string" && body.collectorError) endpointUpdate.collectorError = body.collectorError.slice(0, 1000);
  // A watchdog agent's own status (last alert, test, delivery error).
  const watchdogStatus = cleanWatchdogStatus(body.watchdogStatus);
  if (watchdogStatus) endpointUpdate.watchdogStatus = watchdogStatus;
  // The 5.0 agent's software report (sent only when it changed).
  const software = cleanSoftware(body.software);
  if (software) {
    endpointUpdate.software = software;
    endpointUpdate.softwareUpdatedAt = new Date();
  }

  const metrics = body.metrics;
  const extended: Snapshot | null = metrics?.extended && typeof metrics.extended === "object" ? metrics.extended : null;
  if (extended) {
    // Container names ride along with the snapshot for the check form's
    // suggestions, the same way processes/services do.
    endpointUpdate.lastSnapshot = { ...extended, availableContainers: Array.isArray(body.availableContainers) ? body.availableContainers.map(String) : undefined };
  }
  await db.update(endpoints).set(endpointUpdate).where(eq(endpoints.id, endpointId));
  if (extended && host) await recordFromSnapshot(host, extended).catch(() => undefined);

  if (metrics && typeof metrics === "object") {
    await db.insert(endpointMetrics).values({
      endpointId,
      cpuPercent: numberOrNull(metrics.cpuPercent),
      memPercent: numberOrNull(metrics.memPercent),
      diskPercent: numberOrNull(metrics.diskPercent),
      netRxBytes: numberOrNull(metrics.netRxBytes),
      netTxBytes: numberOrNull(metrics.netTxBytes),
      extended,
    });
    await evaluateReportChecks(endpointId, metrics, extended, (endpointUpdate.inventory ?? host?.inventory ?? null) as Record<string, unknown> | null, (software ?? host?.software ?? null) as SoftwareReport | null);
  }

  const results: AgentResult[] = [...(Array.isArray(body.results) ? body.results : []), ...(Array.isArray(body.services) ? body.services : [])];
  let accepted = 0;
  for (const r of results) {
    const checkId = String(r?.checkId ?? "");
    if (!checkId) continue;
    const check = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
    // Only results for checks this host actually owns (or probes for) are
    // accepted — one agent's token can't write another host's results.
    const owns = check && ((check.endpointId === endpointId && (AGENT_CHECK_TYPES as readonly string[]).includes(check.type)) || (check.probeEndpointId === endpointId && (REMOTE_PROBE_CHECK_TYPES as readonly string[]).includes(check.type)));
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
  logger.debug("agent", `Endpoint ${endpointId} reported ${results.length} result(s), ${accepted} accepted`, { endpointId, reported: results.length, accepted });
  res.json({ ok: true });
});

async function evaluateReportChecks(endpointId: string, metrics: Record<string, unknown>, extended: Snapshot | null, inventory: Record<string, unknown> | null, software: SoftwareReport | null) {
  const reportChecks = await db.query.checks.findMany({
    where: and(eq(checks.endpointId, endpointId), inArray(checks.type, REPORT_CHECK_TYPES), eq(checks.enabled, true)),
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
    // Software checks use the software report (merged exclusions apply).
    if (check.type === "host_packages") {
      await recordCheckResult(check.id, evaluatePackages(software, await withExclusions(check)));
      continue;
    }
    if (check.type === "host_software") {
      const { result, state: next } = evaluateSoftwareChange(software, await withExclusions(check), state);
      await db.update(checks).set({ state: next }).where(eq(checks.id, check.id));
      await recordCheckResult(check.id, result);
      continue;
    }
    // host_metric/host_reboot/host_change need the 3.x extended snapshot;
    // /config already records a "needs agent 3.0" warn for older agents.
    if (!extended) continue;
    if (check.type === "host_metric") {
      // Excluded mounts/interfaces/devices/sensors are left out of the reading.
      const result = evaluateEndpointMetric(extended, await withExclusions(check));
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

  // Custom script expected output: judged here (engine side, like every
  // threshold) from the output and exit code the 4.0+ agent includes.
  if (check.type === "agent_script") {
    const judged = evaluateScriptOutput(config, result);
    if (judged) return judged;
  }

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
