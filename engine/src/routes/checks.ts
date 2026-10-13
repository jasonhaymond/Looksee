import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults, checkDependencies, alertRules, alertRuleChannels, maintenanceWindows, hosts, endpoints } from "../db/schema.js";
import { CHECK_TYPE_META, COLLECTOR_CHECK_TYPES, isCheckType, HOST_SCOPED_CHECK_TYPES, REMOTE_PROBE_CHECK_TYPES } from "../db/checkTypes.js";
import { requireAuth } from "../middleware/auth.js";
import { maskCheck, mergeSecrets } from "../lib/secrets.js";
import { runOneCheck } from "../services/scheduler.js";
import { queueCollectorJob, runsOnCollector, siteCollectorFor } from "../services/sites.js";
import { browseSnmp } from "../services/probes/snmp.js";
import { collectorJobs } from "../db/schema.js";
import { invalidateMaintenanceCache, windowAppliesTo, windowIsActive } from "../services/maintenance.js";
import { copyAlertRules, createAlertRule, parseAlertRule } from "../services/alertRuleFactory.js";
import { remediationFor } from "../services/remediation.js";
import { alertEvents } from "../db/schema.js";

export const checksRouter = Router();
checksRouter.use(requireAuth);

const PUSH_TYPES = new Set(["heartbeat", "push_value"]);
const COLLECTOR_TYPES = new Set<string>(COLLECTOR_CHECK_TYPES);
const newPushToken = () => crypto.randomBytes(18).toString("base64url");

const asTags = (v: unknown): string[] =>
  Array.isArray(v)
    ? [...new Set(v.map((t) => String(t).trim()).filter(Boolean))]
    : typeof v === "string"
      ? [...new Set(v.split(",").map((t) => t.trim()).filter(Boolean))]
      : [];

const intOrNull = (v: unknown) => (v === null || v === "" || v === undefined ? null : Number.isFinite(Number(v)) ? Math.round(Number(v)) : null);

// Shared rule for create and update: what the fields must look like
// together, independent of how they arrived.
function validate(type: string, hostId: string | null, probeHostId: string | null, intervalSeconds: number): string | null {
  if ((HOST_SCOPED_CHECK_TYPES as readonly string[]).includes(type) && !hostId) return `${type} checks require a hostId`;
  if (probeHostId && !(REMOTE_PROBE_CHECK_TYPES as readonly string[]).includes(type)) return `${type} checks can't run on an agent — only ${REMOTE_PROBE_CHECK_TYPES.join(", ")} can`;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) return "intervalSeconds must be at least 5";
  return null;
}

checksRouter.get("/", async (req, res) => {
  const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
  const hostId = typeof req.query.hostId === "string" ? req.query.hostId : undefined;
  const conds = [endpointId ? eq(checks.endpointId, endpointId) : undefined, hostId ? eq(checks.hostId, hostId) : undefined].filter(Boolean);
  const rows = await db.query.checks.findMany({
    where: conds.length ? and(...conds) : undefined,
    orderBy: (c, { asc }) => asc(c.name),
  });
  const deps = await db.query.checkDependencies.findMany();
  const depMap = new Map<string, string[]>();
  for (const d of deps) depMap.set(d.checkId, [...(depMap.get(d.checkId) ?? []), d.dependsOnCheckId]);
  // Parent status needs every check, not just this page's filter.
  const statusById = new Map((await db.select({ id: checks.id, lastStatus: checks.lastStatus, name: checks.name }).from(checks)).map((c) => [c.id, c]));
  const windows = (await db.query.maintenanceWindows.findMany()).filter((w) => windowIsActive(w));
  const allEndpoints = await db.query.endpoints.findMany();
  const collectorOf = new Map(allEndpoints.filter((e) => e.collectorHostId).map((e) => [e.id, e.collectorHostId!]));
  const locationOf = new Map(allEndpoints.map((e) => [e.id, e.locationId]));
  res.json(
    rows.map((c) => {
      const dependsOn = depMap.get(c.id) ?? [];
      const downParent = dependsOn.map((id) => statusById.get(id)).find((p) => p?.lastStatus === "down");
      return {
        ...maskCheck(c),
        state: undefined,
        dependsOn,
        inMaintenance: windows.some((w) => windowAppliesTo(w, c)),
        blockedBy: downParent?.name ?? null,
        // The agent host whose site collector runs this check, if any.
        collectorHostId: COLLECTOR_TYPES.has(c.type) && !c.probeHostId ? (collectorOf.get(c.endpointId) ?? null) : null,
        pushUrl: c.pushToken ? `${process.env.PUBLIC_URL ?? ""}/api/hb/${c.pushToken}` : null,
        locationId: locationOf.get(c.endpointId) ?? null,
        remediation: c.enabled ? remediationFor({ type: c.type, status: c.lastStatus, message: c.lastMessage, config: c.config }) : [],
      };
    })
  );
});

// SNMP walk browser: every value under an OID, run from wherever the
// endpoint's checks run (its site collector, or the engine). checkId lets an
// edit form reuse the saved, masked SNMPv3 keys.
checksRouter.post("/snmp-walk", async (req, res) => {
  let config = req.body?.config && typeof req.body.config === "object" ? (req.body.config as Record<string, unknown>) : {};
  if (req.body?.checkId) {
    const existing = await db.query.checks.findFirst({ where: eq(checks.id, String(req.body.checkId)) });
    if (existing) config = mergeSecrets(config, existing.config);
  }
  if (!config.host) {
    res.status(400).json({ error: "host is required" });
    return;
  }
  const endpointId = req.body?.endpointId ? String(req.body.endpointId) : null;
  if (endpointId && (await siteCollectorFor(endpointId))) {
    const job = await queueCollectorJob(endpointId, "snmp_walk", config);
    res.status(202).json({ jobId: job.id });
    return;
  }
  try {
    res.json(await browseSnmp(config));
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

checksRouter.get("/snmp-walk/:jobId", async (req, res) => {
  const job = await db.query.collectorJobs.findFirst({ where: eq(collectorJobs.id, req.params.jobId) });
  if (!job || job.kind !== "snmp_walk") {
    res.status(404).json({ error: "Walk not found" });
    return;
  }
  if (job.status === "queued" || job.status === "sent") {
    res.json({ pending: true });
    return;
  }
  if (job.status === "error") {
    res.status(502).json({ error: job.result ?? "The site collector couldn't walk the device" });
    return;
  }
  res.json(JSON.parse(job.result ?? '{"rows":[]}'));
});

checksRouter.get("/types", (_req, res) => {
  res.json(CHECK_TYPE_META);
});

checksRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const endpointId = String(req.body?.endpointId ?? "");
  const type = req.body?.type;
  if (!name || !endpointId || !isCheckType(type)) {
    res.status(400).json({ error: `name, endpointId, and a valid type are required` });
    return;
  }
  const hostId = req.body?.hostId ? String(req.body.hostId) : null;
  const probeHostId = req.body?.probeHostId ? String(req.body.probeHostId) : null;
  const intervalSeconds = Number.isFinite(Number(req.body?.intervalSeconds)) ? Number(req.body.intervalSeconds) : 60;
  const error = validate(type, hostId, probeHostId, intervalSeconds);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  const [check] = await db
    .insert(checks)
    .values({
      name,
      endpointId,
      hostId,
      probeHostId,
      type,
      config,
      intervalSeconds,
      retryIntervalSeconds: intOrNull(req.body?.retryIntervalSeconds),
      enabled: req.body?.enabled === undefined ? true : Boolean(req.body.enabled),
      tags: asTags(req.body?.tags),
      pushToken: PUSH_TYPES.has(type) ? newPushToken() : null,
    })
    .returning();
  if (Array.isArray(req.body?.dependsOn) && req.body.dependsOn.length) {
    await db.insert(checkDependencies).values(req.body.dependsOn.filter((id: unknown) => id && id !== check.id).map((id: unknown) => ({ checkId: check.id, dependsOnCheckId: String(id) })));
  }
  const rule = parseAlertRule(req.body?.alertRule);
  if (rule) await createAlertRule(check.id, rule);
  res.status(201).json(maskCheck(check));
});

// {{host}}, {{address}} and {{endpoint}} in the name or any text setting
// are filled in per target, so one form can create "ping <each host>".
function fillPlaceholders<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") return value.replace(/\{\{\s*(host|address|endpoint)\s*\}\}/g, (_m, k: string) => vars[k] ?? "") as T;
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, vars)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, vars)])) as T;
  return value;
}

// POST /api/checks/batch
// { type, name, config, intervalSeconds, retryIntervalSeconds, enabled, tags,
//   dependsOn, probeHostId, alertRule?, targets: [{ endpointId, hostId? }] }
// Creates the same check once per target (multi-select hosts/endpoints in
// the add-check form). Each target is validated on its own; failures are
// reported per target rather than failing the whole batch.
checksRouter.post("/batch", async (req, res) => {
  const type = req.body?.type;
  const baseName = String(req.body?.name ?? "").trim();
  const targets: { endpointId?: unknown; hostId?: unknown }[] = Array.isArray(req.body?.targets) ? req.body.targets.slice(0, 500) : [];
  if (!isCheckType(type) || !baseName || !targets.length) {
    res.status(400).json({ error: "type, name and at least one target are required" });
    return;
  }
  const intervalSeconds = Number.isFinite(Number(req.body?.intervalSeconds)) ? Number(req.body.intervalSeconds) : 60;
  const probeHostId = req.body?.probeHostId ? String(req.body.probeHostId) : null;
  const rule = parseAlertRule(req.body?.alertRule);
  const allHosts = new Map((await db.query.hosts.findMany()).map((h) => [h.id, h]));
  const allEndpoints = new Map((await db.query.endpoints.findMany()).map((e) => [e.id, e]));
  const created: ReturnType<typeof maskCheck>[] = [];
  const errors: { target: string; error: string }[] = [];
  for (const t of targets) {
    const host = t.hostId ? allHosts.get(String(t.hostId)) : undefined;
    const endpointId = host?.endpointId ?? (t.endpointId ? String(t.endpointId) : "");
    const endpoint = allEndpoints.get(endpointId);
    const label = host?.name ?? endpoint?.name ?? String(t.hostId ?? t.endpointId ?? "?");
    if (!endpoint || (t.hostId && !host)) {
      errors.push({ target: label, error: "endpoint or host not found" });
      continue;
    }
    const err = validate(type, host?.id ?? null, probeHostId, intervalSeconds);
    if (err) {
      errors.push({ target: label, error: err });
      continue;
    }
    const vars = { host: host?.name ?? "", address: host?.hostname || host?.name || "", endpoint: endpoint.name };
    let name = fillPlaceholders(baseName, vars);
    // Several targets with a name that doesn't mention one would all look
    // identical in the list.
    if (targets.length > 1 && name === baseName) name = `${baseName} — ${label}`;
    const [check] = await db
      .insert(checks)
      .values({
        name,
        endpointId,
        hostId: host?.id ?? null,
        probeHostId,
        type,
        config: fillPlaceholders(req.body?.config && typeof req.body.config === "object" ? req.body.config : {}, vars),
        intervalSeconds,
        retryIntervalSeconds: intOrNull(req.body?.retryIntervalSeconds),
        enabled: req.body?.enabled === undefined ? true : Boolean(req.body.enabled),
        tags: asTags(req.body?.tags),
        pushToken: PUSH_TYPES.has(type) ? newPushToken() : null,
      })
      .returning();
    if (Array.isArray(req.body?.dependsOn)) await setDependencies(check.id, req.body.dependsOn.map(String));
    if (rule) await createAlertRule(check.id, rule);
    created.push(maskCheck(check));
  }
  res.status(created.length ? 201 : 400).json({ created, errors, ...(created.length ? {} : { error: errors[0]?.error ?? "Nothing created" }) });
});

checksRouter.get("/:id", async (req, res) => {
  const check = await db.query.checks.findFirst({ where: eq(checks.id, req.params.id) });
  if (!check) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  const deps = await db.query.checkDependencies.findMany({ where: eq(checkDependencies.checkId, check.id) });
  const endpoint = await db.query.endpoints.findFirst({ where: eq(endpoints.id, check.endpointId) });
  const windows = (await db.query.maintenanceWindows.findMany()).filter((w) => windowIsActive(w));
  const parents = deps.length ? await db.query.checks.findMany({ where: inArray(checks.id, deps.map((d) => d.dependsOnCheckId)) }) : [];
  res.json({
    ...maskCheck(check),
    state: undefined,
    dependsOn: deps.map((d) => d.dependsOnCheckId),
    inMaintenance: windows.some((w) => windowAppliesTo(w, check)),
    blockedBy: parents.find((p) => p.lastStatus === "down")?.name ?? null,
    collectorHostId: COLLECTOR_TYPES.has(check.type) && !check.probeHostId ? (endpoint?.collectorHostId ?? null) : null,
    pushUrl: check.pushToken ? `${process.env.PUBLIC_URL ?? ""}/api/hb/${check.pushToken}` : null,
    locationId: endpoint?.locationId ?? null,
    remediation: remediationFor({ type: check.type, status: check.lastStatus, message: check.lastMessage, config: check.config }),
  });
});

// Summary numbers and a bucketed time series for the check page's charts.
// hours: 1..8760. Maintenance-time results are excluded from uptime.
checksRouter.get("/:id/stats", async (req, res) => {
  const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 8760);
  const since = new Date(Date.now() - hours * 3_600_000);
  const bucketSeconds = Math.max(60, Math.round((hours * 3600) / 120));
  const id = req.params.id;
  const summary = await db.execute(sql`
    SELECT count(*)::int AS results,
      count(*) FILTER (WHERE status = 'up' AND NOT in_maintenance)::int AS up,
      count(*) FILTER (WHERE status = 'warn' AND NOT in_maintenance)::int AS warn,
      count(*) FILTER (WHERE status = 'down' AND NOT in_maintenance)::int AS down,
      count(*) FILTER (WHERE NOT in_maintenance AND status <> 'unknown')::int AS counted,
      avg(latency_ms)::float AS "latencyAvg", min(latency_ms)::float AS "latencyMin", max(latency_ms)::float AS "latencyMax",
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)::float AS "latencyP95",
      avg(value)::float AS "valueAvg", min(value)::float AS "valueMin", max(value)::float AS "valueMax"
    FROM check_results WHERE check_id = ${id} AND checked_at >= ${since}`);
  const changes = await db.execute(sql`
    SELECT count(*)::int AS n FROM (
      SELECT status, lag(status) OVER (ORDER BY checked_at) AS prev FROM check_results WHERE check_id = ${id} AND checked_at >= ${since}
    ) t WHERE prev IS NOT NULL AND prev <> status`);
  const series = await db.execute(sql`
    SELECT to_timestamp(floor(extract(epoch FROM checked_at) / ${bucketSeconds}) * ${bucketSeconds}) AS t,
      avg(latency_ms)::float AS latency, avg(value)::float AS value, min(value)::float AS "valueMin", max(value)::float AS "valueMax",
      CASE WHEN bool_or(status = 'down' AND NOT in_maintenance) THEN 'down' WHEN bool_or(status = 'warn' AND NOT in_maintenance) THEN 'warn'
           WHEN bool_or(in_maintenance) THEN 'maintenance' WHEN bool_or(status = 'up') THEN 'up' ELSE 'unknown' END AS status,
      count(*)::int AS n
    FROM check_results WHERE check_id = ${id} AND checked_at >= ${since}
    GROUP BY 1 ORDER BY 1`);
  const ruleIds = (await db.select({ id: alertRules.id }).from(alertRules).where(eq(alertRules.checkId, id))).map((r) => r.id);
  const incidents = ruleIds.length ? await db.query.alertEvents.findMany({ where: and(inArray(alertEvents.alertRuleId, ruleIds), gte(alertEvents.triggeredAt, since)), orderBy: desc(alertEvents.triggeredAt), limit: 200 }) : [];
  const s = summary.rows[0] as Record<string, number | null>;
  const counted = Number(s.counted) || 0;
  res.json({
    hours,
    bucketSeconds,
    ...s,
    uptimePercent: counted ? Math.round(((Number(s.up) + Number(s.warn)) / counted) * 10000) / 100 : null,
    stateChanges: (changes.rows[0] as { n: number }).n,
    series: series.rows,
    incidents,
  });
});

checksRouter.patch("/:id", async (req, res) => {
  const existing = await db.query.checks.findFirst({ where: eq(checks.id, req.params.id) });
  if (!existing) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  const updates: Partial<typeof checks.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.endpointId !== undefined) updates.endpointId = String(req.body.endpointId);
  if (req.body?.hostId !== undefined) updates.hostId = req.body.hostId ? String(req.body.hostId) : null;
  if (req.body?.probeHostId !== undefined) updates.probeHostId = req.body.probeHostId ? String(req.body.probeHostId) : null;
  if (req.body?.config !== undefined) updates.config = mergeSecrets(req.body.config ?? {}, existing.config);
  if (req.body?.intervalSeconds !== undefined) updates.intervalSeconds = Number(req.body.intervalSeconds);
  if (req.body?.retryIntervalSeconds !== undefined) updates.retryIntervalSeconds = intOrNull(req.body.retryIntervalSeconds);
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.tags !== undefined) updates.tags = asTags(req.body.tags);
  // Changing what a check measures invalidates its baselines/counters.
  if (updates.config || updates.hostId !== undefined) updates.state = {};
  const error = validate(
    existing.type,
    "hostId" in updates ? (updates.hostId ?? null) : existing.hostId,
    "probeHostId" in updates ? (updates.probeHostId ?? null) : existing.probeHostId,
    updates.intervalSeconds ?? existing.intervalSeconds
  );
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [check] = await db.update(checks).set(updates).where(eq(checks.id, req.params.id)).returning();
  if (Array.isArray(req.body?.dependsOn)) await setDependencies(check.id, req.body.dependsOn.map(String));
  res.json(maskCheck(check));
});

async function setDependencies(checkId: string, parentIds: string[]) {
  await db.delete(checkDependencies).where(eq(checkDependencies.checkId, checkId));
  const unique = [...new Set(parentIds.filter((id) => id && id !== checkId))];
  if (unique.length) await db.insert(checkDependencies).values(unique.map((dependsOnCheckId) => ({ checkId, dependsOnCheckId })));
}

checksRouter.delete("/:id", async (req, res) => {
  await db.delete(checks).where(eq(checks.id, req.params.id));
  res.status(204).end();
});

checksRouter.post("/:id/run", async (req, res) => {
  const check = await db.query.checks.findFirst({ where: eq(checks.id, req.params.id) });
  if (!check) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  const meta = CHECK_TYPE_META[check.type];
  if (meta.executor !== "engine" || check.probeHostId) {
    res.status(409).json({ error: "This check runs on an agent — it'll update on the agent's next report." });
    return;
  }
  if (await runsOnCollector(check)) {
    // Clearing lastRunAt is the collector's cue to run it on its next poll.
    await db.update(checks).set({ lastRunAt: null }).where(eq(checks.id, check.id));
    res.status(202).json({ queued: true, message: "Queued on the site collector — the result appears within about 15 seconds." });
    return;
  }
  const result = await runOneCheck(check);
  res.json(result);
});

checksRouter.post("/:id/regenerate-token", async (req, res) => {
  const [check] = await db.update(checks).set({ pushToken: newPushToken() }).where(eq(checks.id, req.params.id)).returning();
  if (!check || !PUSH_TYPES.has(check.type)) {
    res.status(404).json({ error: "Not a heartbeat/push check" });
    return;
  }
  res.json(maskCheck(check));
});

// Recent result history for one check. `since` (ISO timestamp) narrows to a
// time window; `limit` stays in effect as a safety ceiling within it.
checksRouter.get("/:id/results", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 5000);
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const validSince = since && !Number.isNaN(since.getTime()) ? since : undefined;
  const rows = await db.query.checkResults.findMany({
    where: validSince ? and(eq(checkResults.checkId, req.params.id), gte(checkResults.checkedAt, validSince)) : eq(checkResults.checkId, req.params.id),
    orderBy: desc(checkResults.checkedAt),
    limit,
  });
  res.json(rows);
});

// One request applies an action to many checks — the management table's
// multi-select. Every action is a plain loop over the same single-check
// rules above, so batch and one-at-a-time behave identically.
checksRouter.post("/bulk", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const action = String(req.body?.action ?? "");
  if (!ids.length) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  const rows = await db.query.checks.findMany({ where: inArray(checks.id, ids) });
  const errors: { id: string; error: string }[] = [];
  let affected = 0;

  switch (action) {
    case "enable":
    case "disable":
      affected = (await db.update(checks).set({ enabled: action === "enable" }).where(inArray(checks.id, ids)).returning({ id: checks.id })).length;
      break;
    case "delete":
      affected = (await db.delete(checks).where(inArray(checks.id, ids)).returning({ id: checks.id })).length;
      break;
    case "move": {
      const endpointId = String(req.body?.endpointId ?? "");
      if (!(await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) }))) {
        res.status(400).json({ error: "endpointId not found" });
        return;
      }
      affected = (await db.update(checks).set({ endpointId }).where(inArray(checks.id, ids)).returning({ id: checks.id })).length;
      break;
    }
    case "set_interval":
    case "set_retry_interval": {
      const value = intOrNull(req.body?.seconds);
      if (action === "set_interval" && (value == null || value < 5)) {
        res.status(400).json({ error: "seconds must be at least 5" });
        return;
      }
      affected = (await db.update(checks).set(action === "set_interval" ? { intervalSeconds: value! } : { retryIntervalSeconds: value }).where(inArray(checks.id, ids)).returning({ id: checks.id })).length;
      break;
    }
    case "add_tags":
    case "remove_tags": {
      const tags = asTags(req.body?.tags);
      for (const c of rows) {
        const next = action === "add_tags" ? [...new Set([...(c.tags ?? []), ...tags])] : (c.tags ?? []).filter((t) => !tags.includes(t));
        await db.update(checks).set({ tags: next }).where(eq(checks.id, c.id));
        affected++;
      }
      break;
    }
    case "set_host":
    case "set_probe_host": {
      const target = req.body?.hostId ? String(req.body.hostId) : null;
      if (target && !(await db.query.hosts.findFirst({ where: eq(hosts.id, target) }))) {
        res.status(400).json({ error: "hostId not found" });
        return;
      }
      for (const c of rows) {
        const hostId = action === "set_host" ? target : c.hostId;
        const probeHostId = action === "set_probe_host" ? target : c.probeHostId;
        const err = validate(c.type, hostId, probeHostId, c.intervalSeconds);
        if (err) {
          errors.push({ id: c.id, error: `${c.name}: ${err}` });
          continue;
        }
        await db.update(checks).set(action === "set_host" ? { hostId, state: {} } : { probeHostId }).where(eq(checks.id, c.id));
        affected++;
      }
      break;
    }
    case "run_now":
      for (const c of rows) {
        if (CHECK_TYPE_META[c.type].executor !== "engine" || c.probeHostId) {
          errors.push({ id: c.id, error: `${c.name}: runs on an agent` });
          continue;
        }
        if (await runsOnCollector(c)) {
          await db.update(checks).set({ lastRunAt: null }).where(eq(checks.id, c.id));
          affected++;
          continue;
        }
        await runOneCheck(c).catch((e) => errors.push({ id: c.id, error: `${c.name}: ${e instanceof Error ? e.message : String(e)}` }));
        affected++;
      }
      break;
    case "duplicate": {
      // Destinations: hostIds (one copy per check per host, landing in that
      // host's endpoint), else endpointIds (one copy per endpoint), else the
      // check's own endpoint. Copies keep the original's enabled state, alert
      // rules and dependencies, so a copy is ready to monitor straight away.
      const hostIds: string[] = Array.isArray(req.body?.hostIds) ? req.body.hostIds.map(String) : [];
      const endpointIds: string[] = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds.map(String) : [];
      const hostRows = hostIds.length ? await db.query.hosts.findMany({ where: inArray(hosts.id, hostIds) }) : [];
      const endpointRows = new Map((await db.query.endpoints.findMany()).map((e) => [e.id, e]));
      const allHosts = new Map((await db.query.hosts.findMany()).map((h) => [h.id, h]));
      const deps = await db.query.checkDependencies.findMany({ where: inArray(checkDependencies.checkId, ids) });
      for (const c of rows) {
        const dests: { endpointId: string; hostId: string | null; label: string | null }[] = hostRows.length
          ? hostRows.map((h) => ({ endpointId: h.endpointId, hostId: h.id, label: h.name }))
          : endpointIds.length
            ? endpointIds.filter((id) => endpointRows.has(id)).map((id) => ({ endpointId: id, hostId: c.hostId && allHosts.get(c.hostId)?.endpointId === id ? c.hostId : null, label: endpointRows.get(id)!.name }))
            : [{ endpointId: c.endpointId, hostId: c.hostId, label: null }];
        for (const d of dests) {
          const err = validate(c.type, d.hostId, c.probeHostId, c.intervalSeconds);
          if (err) {
            errors.push({ id: c.id, error: `${c.name} → ${d.label}: ${err}` });
            continue;
          }
          const sameSpot = d.endpointId === c.endpointId && d.hostId === c.hostId;
          const [copy] = await db
            .insert(checks)
            .values({
              name: sameSpot ? `${c.name} (copy)` : `${c.name} (${d.label})`,
              endpointId: d.endpointId,
              hostId: d.hostId,
              probeHostId: c.probeHostId,
              type: c.type,
              config: c.config,
              intervalSeconds: c.intervalSeconds,
              retryIntervalSeconds: c.retryIntervalSeconds,
              enabled: c.enabled,
              tags: c.tags,
              pushToken: PUSH_TYPES.has(c.type) ? newPushToken() : null,
            })
            .returning();
          await copyAlertRules(c.id, copy.id);
          const parents = deps.filter((x) => x.checkId === c.id).map((x) => x.dependsOnCheckId);
          if (parents.length) await setDependencies(copy.id, parents);
          affected++;
        }
      }
      break;
    }
    case "add_alert_rule": {
      const rule = parseAlertRule(req.body);
      if (!rule) {
        res.status(400).json({ error: "Choose at least one channel" });
        return;
      }
      for (const c of rows) {
        await createAlertRule(c.id, rule);
        affected++;
      }
      break;
    }
    case "clear_alert_rules":
      affected = (await db.delete(alertRules).where(inArray(alertRules.checkId, ids)).returning({ id: alertRules.id })).length;
      break;
    case "set_dependencies": {
      const parents: string[] = Array.isArray(req.body?.dependsOn) ? req.body.dependsOn.map(String) : [];
      for (const c of rows) {
        await setDependencies(c.id, parents);
        affected++;
      }
      break;
    }
    case "maintenance": {
      const minutes = Math.max(1, Number(req.body?.minutes) || 60);
      const now = new Date();
      await db.insert(maintenanceWindows).values({
        name: String(req.body?.name || `Maintenance for ${rows.length} check(s)`),
        scope: "check",
        targetIds: rows.map((c) => c.id),
        startsAt: now,
        endsAt: new Date(now.getTime() + minutes * 60_000),
      });
      invalidateMaintenanceCache();
      affected = rows.length;
      break;
    }
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
  }
  res.json({ affected, errors });
});
