// API routes for alert rules: /api/alert-rules (list, create, edit, enable/
// disable, delete) and the alert history (/events).
//
// A rule says when a failing check notifies (after N failing results in a
// row; down only or warn too), which channels, reminders and escalation.
// Security: every route requires a signed-in session; numbers are clamped
// (e.g. 1–1000 results in a row) so a request can't store nonsense.

import { Router } from "express";
import { and, desc, eq, gte, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRules, alertRuleChannels, alertEvents, checks, sites } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { own } from "../lib/own.js";

export const alertRulesRouter = Router();
alertRulesRouter.use(requireAuth);

// Recent alert history for the dashboard's alert-history widget — joins
// alertEvents -> alertRules -> checks by hand (same "fetch and merge, skip
// drizzle relations() wiring for one small join" posture as GET / below)
// rather than a single relational query.
// Filters (all optional): siteId, locationId, checkId, endpointId,
// status=open|resolved, since/until (ISO), q (check name or message text).
alertRulesRouter.get("/events", async (req, res) => {
  const q = (k: string) => {
    const v = own(req.query as Record<string, unknown>, k);
    return typeof v === "string" && v ? v : undefined;
  };
  const date = (k: string) => {
    const d = q(k) ? new Date(q(k)!) : undefined;
    return d && !Number.isNaN(d.getTime()) ? d : undefined;
  };
  const siteId = q("siteId");
  const locationId = q("locationId");
  const validSince = date("since");
  const until = date("until");
  const status = q("status");
  const text = q("q")?.toLowerCase();
  const limit = Math.min(Number(req.query.limit) || 50, 2000);

  const locationSites = locationId ? (await db.query.sites.findMany({ where: eq(sites.locationId, locationId) })).map((e) => e.id) : null;
  const checkRows = (await db.query.checks.findMany({ where: siteId ? eq(checks.siteId, siteId) : undefined })).filter(
    (c) => (!locationSites || locationSites.includes(c.siteId)) && (!q("checkId") || c.id === q("checkId")) && (!q("endpointId") || c.endpointId === q("endpointId") || c.probeEndpointId === q("endpointId"))
  );
  const checkById = new Map(checkRows.map((c) => [c.id, c]));
  const filtered = siteId || locationId || q("checkId") || q("endpointId");
  if (filtered && !checkRows.length) {
    res.json([]);
    return;
  }
  const ruleRows = await db.query.alertRules.findMany({
    where: filtered ? inArray(alertRules.checkId, checkRows.map((c) => c.id)) : undefined,
  });
  const ruleById = new Map(ruleRows.map((r) => [r.id, r]));

  if (ruleRows.length === 0) {
    res.json([]);
    return;
  }

  const events = await db.query.alertEvents.findMany({
    where: and(
      inArray(alertEvents.alertRuleId, ruleRows.map((r) => r.id)),
      validSince ? gte(alertEvents.triggeredAt, validSince) : undefined,
      until ? lte(alertEvents.triggeredAt, until) : undefined,
      status === "open" ? isNull(alertEvents.resolvedAt) : status === "resolved" ? isNotNull(alertEvents.resolvedAt) : undefined
    ),
    orderBy: desc(alertEvents.triggeredAt),
    limit: text ? 5000 : limit,
  });

  const rows = events.map((e) => {
    const rule = ruleById.get(e.alertRuleId);
    const check = rule ? checkById.get(rule.checkId) : undefined;
    const end = e.resolvedAt ?? new Date();
    return {
      ...e,
      checkId: rule?.checkId ?? null,
      checkName: check?.name ?? "(deleted check)",
      siteId: check?.siteId ?? null,
      endpointId: check?.endpointId ?? null,
      checkType: check?.type ?? null,
      durationMinutes: Math.round((end.getTime() - e.triggeredAt.getTime()) / 60_000),
    };
  });
  res.json(text ? rows.filter((r) => `${r.checkName} ${r.message ?? ""}`.toLowerCase().includes(text)).slice(0, limit) : rows);
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
  // Failing results in a row before notifying: 1–1000, default 2.
  const consecutiveFailures = Number.isFinite(req.body?.consecutiveFailures)
    ? Math.max(1, Math.min(1000, Math.round(Number(req.body.consecutiveFailures))))
    : 2;
  const [rule] = await db
    .insert(alertRules)
    .values({ checkId, consecutiveFailures, triggerOn: req.body?.triggerOn === "warn" ? "warn" : "down", renotifyMinutes: optInt(req.body?.renotifyMinutes), escalateAfterMinutes: optInt(req.body?.escalateAfterMinutes) })
    .returning();
  await setChannels(rule.id, req.body?.channelIds, req.body?.escalationChannelIds);
  res.status(201).json(rule);
});

// PATCH /api/alert-rules/:id — change any part of a rule: how many failing
// results in a row trigger it, warn-or-down, reminders, escalation, on/off,
// and its channels (primary and escalation). Fields left out stay as they are.
alertRulesRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof alertRules.$inferInsert> = {};
  // At least 1 result in a row; anything unparseable keeps the old value.
  if (req.body?.consecutiveFailures !== undefined) {
    const n = Math.round(Number(req.body.consecutiveFailures));
    if (Number.isFinite(n)) updates.consecutiveFailures = Math.max(1, Math.min(1000, n));
  }
  if (req.body?.enabled !== undefined) updates.enabled = Boolean(req.body.enabled);
  if (req.body?.triggerOn !== undefined) updates.triggerOn = req.body.triggerOn === "warn" ? "warn" : "down";
  if (req.body?.renotifyMinutes !== undefined) updates.renotifyMinutes = optInt(req.body.renotifyMinutes);
  if (req.body?.escalateAfterMinutes !== undefined) updates.escalateAfterMinutes = optInt(req.body.escalateAfterMinutes);
  // An edit that only changes channels has no column to update; read the
  // rule instead (an empty update would be an error).
  const [rule] = Object.keys(updates).length
    ? await db.update(alertRules).set(updates).where(eq(alertRules.id, String(req.params.id))).returning()
    : await db.select().from(alertRules).where(eq(alertRules.id, String(req.params.id)));
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
