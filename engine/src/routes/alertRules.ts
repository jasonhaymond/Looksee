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
  const linksByRule = new Map<string, string[]>();
  for (const link of links) {
    const list = linksByRule.get(link.alertRuleId) ?? [];
    list.push(link.channelId);
    linksByRule.set(link.alertRuleId, list);
  }
  res.json(rules.map((rule) => ({ ...rule, channelIds: linksByRule.get(rule.id) ?? [] })));
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
  const channelIds: string[] = Array.isArray(req.body?.channelIds) ? req.body.channelIds : [];

  const [rule] = await db.insert(alertRules).values({ checkId, consecutiveFailures }).returning();
  if (channelIds.length > 0) {
    await db.insert(alertRuleChannels).values(channelIds.map((channelId) => ({ alertRuleId: rule.id, channelId })));
  }
  res.status(201).json(rule);
});

alertRulesRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof alertRules.$inferInsert> = {};
  if (req.body?.consecutiveFailures !== undefined) updates.consecutiveFailures = Number(req.body.consecutiveFailures);
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  const [rule] = await db.update(alertRules).set(updates).where(eq(alertRules.id, req.params.id)).returning();
  if (!rule) {
    res.status(404).json({ error: "Alert rule not found" });
    return;
  }
  if (Array.isArray(req.body?.channelIds)) {
    await db.delete(alertRuleChannels).where(eq(alertRuleChannels.alertRuleId, rule.id));
    const channelIds: string[] = req.body.channelIds;
    if (channelIds.length > 0) {
      await db.insert(alertRuleChannels).values(channelIds.map((channelId) => ({ alertRuleId: rule.id, channelId })));
    }
  }
  res.json(rule);
});

alertRulesRouter.delete("/:id", async (req, res) => {
  await db.delete(alertRules).where(eq(alertRules.id, req.params.id));
  res.status(204).end();
});
