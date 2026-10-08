import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults, checkDependencies, alertRules, alertRuleChannels, maintenanceWindows, hosts, endpoints } from "../db/schema.js";
import { CHECK_TYPE_META, COLLECTOR_CHECK_TYPES, isCheckType, HOST_SCOPED_CHECK_TYPES, REMOTE_PROBE_CHECK_TYPES } from "../db/checkTypes.js";
import { requireAuth } from "../middleware/auth.js";
import { maskCheck, mergeSecrets } from "../lib/secrets.js";
import { runOneCheck } from "../services/scheduler.js";
import { runsOnCollector } from "../services/sites.js";
import { invalidateMaintenanceCache, windowAppliesTo, windowIsActive } from "../services/maintenance.js";

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
  const collectorOf = new Map((await db.query.endpoints.findMany()).filter((e) => e.collectorHostId).map((e) => [e.id, e.collectorHostId!]));
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
      };
    })
  );
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
  res.status(201).json(maskCheck(check));
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
    case "duplicate":
      for (const c of rows) {
        await db.insert(checks).values({
          name: `${c.name} (copy)`,
          endpointId: c.endpointId,
          hostId: c.hostId,
          probeHostId: c.probeHostId,
          type: c.type,
          config: c.config,
          intervalSeconds: c.intervalSeconds,
          retryIntervalSeconds: c.retryIntervalSeconds,
          enabled: false,
          tags: c.tags,
          pushToken: PUSH_TYPES.has(c.type) ? newPushToken() : null,
        });
        affected++;
      }
      break;
    case "add_alert_rule": {
      const channelIds: string[] = Array.isArray(req.body?.channelIds) ? req.body.channelIds.map(String) : [];
      const escalationChannelIds: string[] = Array.isArray(req.body?.escalationChannelIds) ? req.body.escalationChannelIds.map(String) : [];
      for (const c of rows) {
        const [rule] = await db
          .insert(alertRules)
          .values({
            checkId: c.id,
            consecutiveFailures: Math.max(1, Number(req.body?.consecutiveFailures) || 2),
            triggerOn: req.body?.triggerOn === "warn" ? "warn" : "down",
            renotifyMinutes: intOrNull(req.body?.renotifyMinutes),
            escalateAfterMinutes: intOrNull(req.body?.escalateAfterMinutes),
          })
          .returning();
        const links = [...channelIds.map((channelId) => ({ alertRuleId: rule.id, channelId, escalation: false })), ...escalationChannelIds.map((channelId) => ({ alertRuleId: rule.id, channelId, escalation: true }))];
        if (links.length) await db.insert(alertRuleChannels).values(links);
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
