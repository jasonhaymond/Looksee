// API routes for checks: list, create (one or many targets at once), edit,
// delete, bulk actions, run now, results and statistics, resolve, recovery
// URLs, excluding results from statistics, what a check ignores, and the SNMP
// walk browser with its OID dictionary.
//
// Security: every route requires a signed-in session; check secrets are
// write-only (lib/secrets.ts); IDs are checked before they reach the database;
// bulk actions run the same rules as single ones.

import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults, checkDependencies, alertRules, maintenanceWindows, endpoints, sites } from "../db/schema.js";
import { CHECK_TYPE_META, COLLECTOR_CHECK_TYPES, isCheckType, ENDPOINT_SCOPED_CHECK_TYPES, PINNABLE_CHECK_TYPES } from "../db/checkTypes.js";
import { requireAuth } from "../middleware/auth.js";
import { maskCheck, mergeSecrets } from "../lib/secrets.js";
import { runOneCheck } from "../services/scheduler.js";
import { queueCollectorJob, runsOnCollector, siteCollectorFor } from "../services/sites.js";
import { browseSnmp } from "../services/probes/snmp.js";
import { annotateWalk, searchOids } from "../services/probes/mibs.js";
import { collectorJobs } from "../db/schema.js";
import { activeMaintenance, invalidateMaintenanceCache, windowAppliesTo } from "../services/maintenance.js";
import { copyAlertRules, createAlertRule, parseAlertRule } from "../services/alertRuleFactory.js";
import { remediationFor } from "../services/remediation.js";
import { resolveCheck } from "../services/alerting.js";
import { logger } from "../lib/logger.js";
import { alertEvents } from "../db/schema.js";
import { exclusionsFor } from "../services/exclusions.js";
import { own } from "../lib/own.js";
import { isUuid } from "../lib/ids.js";

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
// together, independent of how they arrived. probeEndpointId ("run on this
// agent") is only allowed for types an agent elsewhere can run: the remote
// probes (ping, TCP, HTTP, DNS, TLS) and custom scripts — a script still only
// ever comes from that agent's own script_dir.
function validate(type: string, endpointId: string | null, probeEndpointId: string | null, intervalSeconds: number): string | null {
  if ((ENDPOINT_SCOPED_CHECK_TYPES as readonly string[]).includes(type) && !endpointId) return `${type} checks require a endpointId`;
  if (probeEndpointId && !(PINNABLE_CHECK_TYPES as readonly string[]).includes(type)) return `${type} checks can't run on an agent — only ${PINNABLE_CHECK_TYPES.join(", ")} can`;
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 5) return "intervalSeconds must be at least 5";
  return null;
}

checksRouter.get("/", async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
  const conds = [siteId ? eq(checks.siteId, siteId) : undefined, endpointId ? eq(checks.endpointId, endpointId) : undefined].filter(Boolean);
  const rows = await db.query.checks.findMany({
    where: conds.length ? and(...conds) : undefined,
    orderBy: (c, { asc }) => asc(c.name),
  });
  const deps = await db.query.checkDependencies.findMany();
  const depMap = new Map<string, string[]>();
  for (const d of deps) depMap.set(d.checkId, [...(depMap.get(d.checkId) ?? []), d.dependsOnCheckId]);
  // Parent status needs every check, not just this page's filter.
  const statusById = new Map((await db.select({ id: checks.id, lastStatus: checks.lastStatus, name: checks.name }).from(checks)).map((c) => [c.id, c]));
  const { windows, groupChecks } = await activeMaintenance();
  const allSites = await db.query.sites.findMany();
  const collectorOf = new Map(allSites.filter((e) => e.collectorEndpointId).map((e) => [e.id, e.collectorEndpointId!]));
  const locationOf = new Map(allSites.map((e) => [e.id, e.locationId]));
  res.json(
    rows.map((c) => {
      const dependsOn = depMap.get(c.id) ?? [];
      const downParent = dependsOn.map((id) => statusById.get(id)).find((p) => p?.lastStatus === "down");
      return {
        ...maskCheck(c),
        state: undefined,
        dependsOn,
        inMaintenance: windows.some((w) => windowAppliesTo(w, c, groupChecks)),
        blockedBy: downParent?.name ?? null,
        // The agent host whose site collector runs this check, if any.
        collectorEndpointId: COLLECTOR_TYPES.has(c.type) && !c.probeEndpointId ? (collectorOf.get(c.siteId) ?? null) : null,
        pushUrl: c.pushToken ? `${process.env.PUBLIC_URL ?? ""}/api/hb/${c.pushToken}` : null,
        locationId: locationOf.get(c.siteId) ?? null,
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
  const siteId = req.body?.siteId ? String(req.body.siteId) : null;
  if (siteId && (await siteCollectorFor(siteId))) {
    const job = await queueCollectorJob(siteId, "snmp_walk", config);
    res.status(202).json({ jobId: job.id });
    return;
  }
  try {
    // Names, descriptions and readable values from the built-in OID
    // dictionary (services/probes/mibs.ts) are added to every row.
    const walked = await browseSnmp(config);
    res.json({ ...walked, rows: annotateWalk(walked.rows) });
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
  // The collector sends plain rows; names and readable values are added here.
  const walked = JSON.parse(job.result ?? '{"rows":[]}') as { rows?: { oid: string; type: string; value: string }[]; truncated?: boolean };
  res.json({ ...walked, rows: annotateWalk(Array.isArray(walked.rows) ? walked.rows : []) });
});

// GET /api/checks/snmp-oids?q=battery — find OIDs in the built-in dictionary
// by name, description, MIB or OID prefix (the "Look up an OID" box).
checksRouter.get("/snmp-oids", (req, res) => {
  res.json(searchOids(typeof req.query.q === "string" ? req.query.q.slice(0, 100) : ""));
});

checksRouter.get("/types", (_req, res) => {
  res.json(CHECK_TYPE_META);
});

checksRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const siteId = String(req.body?.siteId ?? "");
  const type = req.body?.type;
  if (!name || !siteId || !isCheckType(type)) {
    res.status(400).json({ error: `name, siteId, and a valid type are required` });
    return;
  }
  const endpointId = req.body?.endpointId ? String(req.body.endpointId) : null;
  const probeEndpointId = req.body?.probeEndpointId ? String(req.body.probeEndpointId) : null;
  const intervalSeconds = Number.isFinite(Number(req.body?.intervalSeconds)) ? Number(req.body.intervalSeconds) : 60;
  const error = validate(type, endpointId, probeEndpointId, intervalSeconds);
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const config = req.body?.config && typeof req.body.config === "object" ? req.body.config : {};
  const [check] = await db
    .insert(checks)
    .values({
      name,
      siteId,
      endpointId,
      probeEndpointId,
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

// {{endpoint}} (the device; {{host}} is its pre-5.0 name), {{address}} and
// {{site}} in the name or any text setting are filled in per target, so one
// form can create "ping <each endpoint>".
function fillPlaceholders<T>(value: T, vars: Record<string, string>): T {
  if (typeof value === "string") return value.replace(/\{\{\s*(host|address|endpoint|site)\s*\}\}/g, (_m, k: string) => own(vars, k) ?? "") as T;
  if (Array.isArray(value)) return value.map((v) => fillPlaceholders(v, vars)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillPlaceholders(v, vars)])) as T;
  return value;
}

// POST /api/checks/batch
// { type, name, config, intervalSeconds, retryIntervalSeconds, enabled, tags,
//   dependsOn, probeEndpointId, alertRule?, targets: [{ siteId, endpointId? }] }
// Creates the same check once per target (multi-select endpoints/sites in
// the add-check form). Each target is validated on its own; failures are
// reported per target rather than failing the whole batch.
checksRouter.post("/batch", async (req, res) => {
  const type = req.body?.type;
  const baseName = String(req.body?.name ?? "").trim();
  const targets: { siteId?: unknown; endpointId?: unknown }[] = Array.isArray(req.body?.targets) ? req.body.targets.slice(0, 500) : [];
  if (!isCheckType(type) || !baseName || !targets.length) {
    res.status(400).json({ error: "type, name and at least one target are required" });
    return;
  }
  const intervalSeconds = Number.isFinite(Number(req.body?.intervalSeconds)) ? Number(req.body.intervalSeconds) : 60;
  const probeEndpointId = req.body?.probeEndpointId ? String(req.body.probeEndpointId) : null;
  const rule = parseAlertRule(req.body?.alertRule);
  const allEndpoints = new Map((await db.query.endpoints.findMany()).map((h) => [h.id, h]));
  const allSites = new Map((await db.query.sites.findMany()).map((e) => [e.id, e]));
  const created: ReturnType<typeof maskCheck>[] = [];
  const errors: { target: string; error: string }[] = [];
  for (const t of targets) {
    const host = t.endpointId ? allEndpoints.get(String(t.endpointId)) : undefined;
    const siteId = host?.siteId ?? (t.siteId ? String(t.siteId) : "");
    const endpoint = allSites.get(siteId);
    const label = host?.name ?? endpoint?.name ?? String(t.endpointId ?? t.siteId ?? "?");
    if (!endpoint || (t.endpointId && !host)) {
      errors.push({ target: label, error: "site or endpoint not found" });
      continue;
    }
    const err = validate(type, host?.id ?? null, probeEndpointId, intervalSeconds);
    if (err) {
      errors.push({ target: label, error: err });
      continue;
    }
    const vars = { endpoint: host?.name ?? "", host: host?.name ?? "", address: host?.hostname || host?.name || "", site: endpoint.name };
    let name = fillPlaceholders(baseName, vars);
    // Several targets with a name that doesn't mention one would all look
    // identical in the list.
    if (targets.length > 1 && name === baseName) name = `${baseName} — ${label}`;
    const [check] = await db
      .insert(checks)
      .values({
        name,
        siteId,
        endpointId: host?.id ?? null,
        probeEndpointId,
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
  const endpoint = await db.query.sites.findFirst({ where: eq(sites.id, check.siteId) });
  const { windows, groupChecks } = await activeMaintenance();
  const parents = deps.length ? await db.query.checks.findMany({ where: inArray(checks.id, deps.map((d) => d.dependsOnCheckId)) }) : [];
  res.json({
    ...maskCheck(check),
    state: undefined,
    dependsOn: deps.map((d) => d.dependsOnCheckId),
    inMaintenance: windows.some((w) => windowAppliesTo(w, check, groupChecks)),
    blockedBy: parents.find((p) => p.lastStatus === "down")?.name ?? null,
    collectorEndpointId: COLLECTOR_TYPES.has(check.type) && !check.probeEndpointId ? (endpoint?.collectorEndpointId ?? null) : null,
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
      count(*) FILTER (WHERE status = 'up' AND NOT (in_maintenance OR excluded))::int AS up,
      count(*) FILTER (WHERE status = 'warn' AND NOT (in_maintenance OR excluded))::int AS warn,
      count(*) FILTER (WHERE status = 'down' AND NOT (in_maintenance OR excluded))::int AS down,
      count(*) FILTER (WHERE NOT (in_maintenance OR excluded) AND status <> 'unknown')::int AS counted,
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
      CASE WHEN bool_or(status = 'down' AND NOT (in_maintenance OR excluded)) THEN 'down' WHEN bool_or(status = 'warn' AND NOT (in_maintenance OR excluded)) THEN 'warn'
           WHEN bool_or(in_maintenance OR excluded) THEN 'maintenance' WHEN bool_or(status = 'up') THEN 'up' ELSE 'unknown' END AS status,
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
  if (req.body?.siteId !== undefined) updates.siteId = String(req.body.siteId);
  if (req.body?.endpointId !== undefined) updates.endpointId = req.body.endpointId ? String(req.body.endpointId) : null;
  if (req.body?.probeEndpointId !== undefined) updates.probeEndpointId = req.body.probeEndpointId ? String(req.body.probeEndpointId) : null;
  if (req.body?.config !== undefined) updates.config = mergeSecrets(req.body.config ?? {}, existing.config);
  if (req.body?.intervalSeconds !== undefined) updates.intervalSeconds = Number(req.body.intervalSeconds);
  if (req.body?.retryIntervalSeconds !== undefined) updates.retryIntervalSeconds = intOrNull(req.body.retryIntervalSeconds);
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.tags !== undefined) updates.tags = asTags(req.body.tags);
  // Changing what a check measures invalidates its baselines/counters.
  if (updates.config || updates.endpointId !== undefined) updates.state = {};
  const error = validate(
    existing.type,
    "endpointId" in updates ? (updates.endpointId ?? null) : existing.endpointId,
    "probeEndpointId" in updates ? (updates.probeEndpointId ?? null) : existing.probeEndpointId,
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
  if (meta.executor !== "engine" || check.probeEndpointId) {
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

// POST /api/checks/:id/regenerate-token — a new secret URL for the check,
// replacing the old one (which stops working). For heartbeat/push checks it's
// where results are pushed; for any other check it's a "recovery URL": an
// external system calling it with status=up marks the check recovered
// (routes/public.ts). The token is the URL's only credential.
checksRouter.post("/:id/regenerate-token", async (req, res) => {
  const [check] = await db.update(checks).set({ pushToken: newPushToken() }).where(eq(checks.id, String(req.params.id))).returning();
  if (!check) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  res.json({ ...maskCheck(check), pushUrl: `${process.env.PUBLIC_URL ?? ""}/api/hb/${check.pushToken}` });
});

// POST /api/checks/:id/remove-token — turns a check's recovery URL off.
// Heartbeat/push checks need theirs, so it can't be removed from them.
checksRouter.post("/:id/remove-token", async (req, res) => {
  const existing = await db.query.checks.findFirst({ where: eq(checks.id, String(req.params.id)) });
  if (!existing) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  if (PUSH_TYPES.has(existing.type)) {
    res.status(400).json({ error: "A heartbeat/push check needs its URL — regenerate it instead" });
    return;
  }
  const [check] = await db.update(checks).set({ pushToken: null }).where(eq(checks.id, existing.id)).returning();
  res.json({ ...maskCheck(check), pushUrl: null });
});

// POST /api/checks/:id/resolve { note? } — marks a failing check recovered
// by hand: records an "up" result (closing its alert incident and sending the
// usual recovery notification). Event checks ignore events from before now;
// other checks report their real status on their next run.
checksRouter.post("/:id/resolve", async (req, res) => {
  const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) : "";
  const ok = await resolveCheck(String(req.params.id), note ? `Manually resolved: ${note}` : "Manually resolved", "manual");
  if (!ok) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  logger.info("checks", `Check ${String(req.params.id)} resolved by hand${note ? `: ${note}` : ""}`, "A check was marked recovered by hand.");
  res.json({ resolved: true });
});

// POST /api/checks/:id/results/exclude { resultIds?, from?, to?, exclude?, reason? }
// Marks results excluded from statistics (uptime, SLA, status pages,
// charts) — or, with exclude: false, counts them again. Either specific
// results (resultIds) or every result in a time range (from/to, ISO times).
// The results themselves are kept.
checksRouter.post("/:id/results/exclude", async (req, res) => {
  const checkId = String(req.params.id);
  const exclude = req.body?.exclude !== false;
  const reason = exclude && typeof req.body?.reason === "string" ? req.body.reason.trim().slice(0, 300) || null : null;
  // At most 5000 IDs, and only well-formed UUIDs (8-4-4-4-12 hex digits,
  // e.g. 3f2b…-…): anything else would make the database query fail, so
  // junk is dropped here and, if nothing valid is left, refused below.
  const ids: string[] = Array.isArray(req.body?.resultIds)
    ? req.body.resultIds
        .map(String)
        .filter((v: string) => isUuid(v))
        .slice(0, 5000)
    : [];
  const from = req.body?.from ? new Date(String(req.body.from)) : null;
  const to = req.body?.to ? new Date(String(req.body.to)) : null;
  // A range needs both ends, in order; otherwise specific IDs are required.
  const range = from && to && !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from < to;
  if (!ids.length && !range) {
    res.status(400).json({ error: "Give resultIds, or a from/to time range" });
    return;
  }
  // Only this check's results can be changed, whatever IDs are sent.
  const where = ids.length
    ? and(eq(checkResults.checkId, checkId), inArray(checkResults.id, ids))
    : and(eq(checkResults.checkId, checkId), gte(checkResults.checkedAt, from!), sql`${checkResults.checkedAt} <= ${to!}`);
  const changed = await db.update(checkResults).set({ excluded: exclude, excludedReason: reason }).where(where).returning({ id: checkResults.id });
  logger.info("checks", `${changed.length} result(s) of check ${checkId} ${exclude ? "excluded from" : "counted again in"} statistics${reason ? `: ${reason}` : ""}`, `Check results were ${exclude ? "excluded from" : "returned to"} uptime and SLA figures.`);
  res.json({ changed: changed.length });
});

// GET /api/checks/:id/exclusions — every item this check ignores and where
// it comes from (its own setting, or a named exclusion list), so the
// dashboard can show why something isn't being alerted on.
checksRouter.get("/:id/exclusions", async (req, res) => {
  const check = isUuid(req.params.id) ? await db.query.checks.findFirst({ where: eq(checks.id, req.params.id) }) : undefined;
  if (!check) {
    res.status(404).json({ error: "Check not found" });
    return;
  }
  res.json(await exclusionsFor(check));
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
      const siteId = String(req.body?.siteId ?? "");
      if (!(await db.query.sites.findFirst({ where: eq(sites.id, siteId) }))) {
        res.status(400).json({ error: "siteId not found" });
        return;
      }
      affected = (await db.update(checks).set({ siteId }).where(inArray(checks.id, ids)).returning({ id: checks.id })).length;
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
    case "set_endpoint":
    case "set_probe_endpoint": {
      const target = req.body?.endpointId ? String(req.body.endpointId) : null;
      if (target && !(await db.query.endpoints.findFirst({ where: eq(endpoints.id, target) }))) {
        res.status(400).json({ error: "endpointId not found" });
        return;
      }
      for (const c of rows) {
        const endpointId = action === "set_endpoint" ? target : c.endpointId;
        const probeEndpointId = action === "set_probe_endpoint" ? target : c.probeEndpointId;
        const err = validate(c.type, endpointId, probeEndpointId, c.intervalSeconds);
        if (err) {
          errors.push({ id: c.id, error: `${c.name}: ${err}` });
          continue;
        }
        await db.update(checks).set(action === "set_endpoint" ? { endpointId, state: {} } : { probeEndpointId }).where(eq(checks.id, c.id));
        affected++;
      }
      break;
    }
    case "resolve": {
      // Marks every chosen check recovered by hand (see /:id/resolve).
      const note = typeof req.body?.note === "string" ? req.body.note.trim().slice(0, 300) : "";
      for (const c of rows) {
        if (await resolveCheck(c.id, note ? `Manually resolved: ${note}` : "Manually resolved", "manual")) affected++;
      }
      break;
    }
    case "run_now":
      for (const c of rows) {
        if (CHECK_TYPE_META[c.type].executor !== "engine" || c.probeEndpointId) {
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
      // Destinations: endpointIds (one copy per check per host, landing in that
      // host's endpoint), else siteIds (one copy per endpoint), else the
      // check's own endpoint. Copies keep the original's enabled state, alert
      // rules and dependencies, so a copy is ready to monitor straight away.
      const endpointIds: string[] = Array.isArray(req.body?.endpointIds) ? req.body.endpointIds.map(String) : [];
      const siteIds: string[] = Array.isArray(req.body?.siteIds) ? req.body.siteIds.map(String) : [];
      const endpointRows = endpointIds.length ? await db.query.endpoints.findMany({ where: inArray(endpoints.id, endpointIds) }) : [];
      const siteRows = new Map((await db.query.sites.findMany()).map((e) => [e.id, e]));
      const allEndpoints = new Map((await db.query.endpoints.findMany()).map((h) => [h.id, h]));
      const deps = await db.query.checkDependencies.findMany({ where: inArray(checkDependencies.checkId, ids) });
      for (const c of rows) {
        const dests: { siteId: string; endpointId: string | null; label: string | null }[] = endpointRows.length
          ? endpointRows.map((h) => ({ siteId: h.siteId, endpointId: h.id, label: h.name }))
          : siteIds.length
            ? siteIds.filter((id) => siteRows.has(id)).map((id) => ({ siteId: id, endpointId: c.endpointId && allEndpoints.get(c.endpointId)?.siteId === id ? c.endpointId : null, label: siteRows.get(id)!.name }))
            : [{ siteId: c.siteId, endpointId: c.endpointId, label: null }];
        for (const d of dests) {
          const err = validate(c.type, d.endpointId, c.probeEndpointId, c.intervalSeconds);
          if (err) {
            errors.push({ id: c.id, error: `${c.name} → ${d.label}: ${err}` });
            continue;
          }
          const sameSpot = d.siteId === c.siteId && d.endpointId === c.endpointId;
          const [copy] = await db
            .insert(checks)
            .values({
              name: sameSpot ? `${c.name} (copy)` : `${c.name} (${d.label})`,
              siteId: d.siteId,
              endpointId: d.endpointId,
              probeEndpointId: c.probeEndpointId,
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
