import { Router } from "express";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules, alertRuleChannels, alertEvents, checks } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const alertRulesRouter = Router();
alertRulesRouter.use(requireAuth);

// Recent alert history for the dashboard's alert-history widget — joins
// alertEvents -> alertRules -> checks by hand (same "fetch and merge, skip
// drizzle relations() wiring for one small join" posture as GET / below)
// rather than a single relational query.
alertRulesRouter.get("/events", async (req, res) => {
  const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const validSince = since && !Number.isNaN(since.getTime()) ? since : undefined;
  const limit = Math.min(Number(req.query.limit) || 50, 500);

  const checkRows = await db.query.checks.findMany({ where: endpointId ? eq(checks.endpointId, endpointId) : undefined });
  const checkById = new Map(checkRows.map((c) => [c.id, c]));
  const ruleRows = await db.query.alertRules.findMany({
    where: endpointId ? inArray(alertRules.checkId, checkRows.map((c) => c.id)) : undefined,
  });
  const ruleById = new Map(ruleRows.map((r) => [r.id, r]));

  if (ruleRows.length === 0) {
    res.json([]);
    return;
  }

  const events = await db.query.alertEvents.findMany({
    where: and(
      inArray(alertEvents.alertRuleId, ruleRows.map((r) => r.id)),
      validSince ? gte(alertEvents.triggeredAt, validSince) : undefined
    ),
    orderBy: desc(alertEvents.triggeredAt),
    limit,
  });

  res.json(
    events.map((e) => {
      const rule = ruleById.get(e.alertRuleId);
      const check = rule ? checkById.get(rule.checkId) : undefined;
      return { ...e, checkId: rule?.checkId ?? null, checkName: check?.name ?? "(deleted check)" };
    })
  );
});

alertRulesRouter.get("/", async (req, res) => {
  const checkId = typeof req.query.checkId === "string" ? req.query.checkId : undefined;
  const rules = await db.query.alertRules.findMany({
    where: checkId ? eq(alertRules.checkId, checkId) : undefined,
  });
  // No drizzle relational query here (avoids needing relations() wiring in
  // schema.ts for one small join) — just fetch and merge the channel ids.
  const links = await db.query.alertRuleChannels.findMany();
  const linksByRule = new Map<string, { channelIds: string[]; escalationChannelIds: string[] }>();
  for (const link of links) {
    const entry = linksByRule.get(link.alertRuleId) ?? { channelIds: [], escalationChannelIds: [] };
    (link.escalation ? entry.escalationChannelIds : entry.channelIds).push(link.channelId);
    linksByRule.set(link.alertRuleId, entry);
  }
  res.json(rules.map((rule) => ({ ...rule, ...(linksByRule.get(rule.id) ?? { channelIds: [], escalationChannelIds: [] }) })));
});

alertRulesRouter.post("/", async (req, res) => {
  const checkId = String(req.body?.checkId ?? "");
  if (!checkId) {
    res.status(400).json({ error: "checkId is required" });
    return;
  }
  const consecutiveFailures = Number.isFinite(req.body?.consecutiveFailures)
    ? Number(req.body.consecutiveFailures)
    : 2;
  const [rule] = await db
    .insert(alertRules)
    .values({ checkId, consecutiveFailures, triggerOn: req.body?.triggerOn === "warn" ? "warn" : "down", renotifyMinutes: optInt(req.body?.renotifyMinutes), escalateAfterMinutes: optInt(req.body?.escalateAfterMinutes) })
    .returning();
  await setChannels(rule.id, req.body?.channelIds, req.body?.escalationChannelIds);
  res.status(201).json(rule);
});

alertRulesRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof alertRules.$inferInsert> = {};
  if (req.body?.consecutiveFailures !== undefined) updates.consecutiveFailures = Number(req.body.consecutiveFailures);
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.triggerOn !== undefined) updates.triggerOn = req.body.triggerOn === "warn" ? "warn" : "down";
  if (req.body?.renotifyMinutes !== undefined) updates.renotifyMinutes = optInt(req.body.renotifyMinutes);
  if (req.body?.escalateAfterMinutes !== undefined) updates.escalateAfterMinutes = optInt(req.body.escalateAfterMinutes);
  const [rule] = await db.update(alertRules).set(updates).where(eq(alertRules.id, req.params.id)).returning();
  if (!rule) {
    res.status(404).json({ error: "Alert rule not found" });
    return;
  }
  if (Array.isArray(req.body?.channelIds) || Array.isArray(req.body?.escalationChannelIds)) {
    const existing = await db.query.alertRuleChannels.findMany({ where: eq(alertRuleChannels.alertRuleId, rule.id) });
    await setChannels(
      rule.id,
      Array.isArray(req.body?.channelIds) ? req.body.channelIds : existing.filter((l) => !l.escalation).map((l) => l.channelId),
      Array.isArray(req.body?.escalationChannelIds) ? req.body.escalationChannelIds : existing.filter((l) => l.escalation).map((l) => l.channelId)
    );
  }
  res.json(rule);
});

alertRulesRouter.delete("/:id", async (req, res) => {
  await db.delete(alertRules).where(eq(alertRules.id, req.params.id));
  res.status(204).end();
});

const optInt = (v: unknown) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Math.max(1, Math.round(Number(v))));

async function setChannels(alertRuleId: string, channelIds: unknown, escalationChannelIds: unknown) {
  await db.delete(alertRuleChannels).where(eq(alertRuleChannels.alertRuleId, alertRuleId));
  const primary = Array.isArray(channelIds) ? channelIds.map(String) : [];
  const escalation = Array.isArray(escalationChannelIds) ? escalationChannelIds.map(String) : [];
  const rows = [...primary.map((channelId) => ({ alertRuleId, channelId, escalation: false })), ...escalation.map((channelId) => ({ alertRuleId, channelId, escalation: true }))];
  if (rows.length) await db.insert(alertRuleChannels).values(rows);
}
