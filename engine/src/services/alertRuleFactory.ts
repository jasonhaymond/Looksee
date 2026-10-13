import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { alertRuleChannels, alertRules } from "../db/schema.js";

// The alert options every "create checks" path accepts (the check form,
// bulk "add alert rule", suggested checks, discovery, duplicate), parsed
// one way so they all mean the same thing.
export type AlertRuleParams = {
  channelIds: string[];
  escalationChannelIds: string[];
  consecutiveFailures: number;
  triggerOn: "down" | "warn";
  renotifyMinutes: number | null;
  escalateAfterMinutes: number | null;
};

const optInt = (v: unknown) => (v === null || v === "" || v === undefined || !Number.isFinite(Number(v)) ? null : Math.max(1, Math.round(Number(v))));
const ids = (v: unknown) => (Array.isArray(v) ? [...new Set(v.map(String).filter(Boolean))] : []);

// null when the request didn't ask for an alert rule at all.
export function parseAlertRule(raw: unknown): AlertRuleParams | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const channelIds = ids(r.channelIds);
  const escalationChannelIds = ids(r.escalationChannelIds);
  if (!channelIds.length && !escalationChannelIds.length) return null;
  return {
    channelIds,
    escalationChannelIds,
    consecutiveFailures: Math.max(1, Number(r.consecutiveFailures) || 2),
    triggerOn: r.triggerOn === "warn" ? "warn" : "down",
    renotifyMinutes: optInt(r.renotifyMinutes),
    escalateAfterMinutes: optInt(r.escalateAfterMinutes),
  };
}

export async function createAlertRule(checkId: string, p: AlertRuleParams) {
  const [rule] = await db
    .insert(alertRules)
    .values({ checkId, consecutiveFailures: p.consecutiveFailures, triggerOn: p.triggerOn, renotifyMinutes: p.renotifyMinutes, escalateAfterMinutes: p.escalateAfterMinutes })
    .returning();
  const links = [...p.channelIds.map((channelId) => ({ alertRuleId: rule.id, channelId, escalation: false })), ...p.escalationChannelIds.map((channelId) => ({ alertRuleId: rule.id, channelId, escalation: true }))];
  if (links.length) await db.insert(alertRuleChannels).values(links);
  return rule;
}

// Copies every alert rule (with its channels) from one check to another.
export async function copyAlertRules(fromCheckId: string, toCheckId: string) {
  const rules = await db.query.alertRules.findMany({ where: eq(alertRules.checkId, fromCheckId) });
  for (const r of rules) {
    const links = await db.query.alertRuleChannels.findMany({ where: eq(alertRuleChannels.alertRuleId, r.id) });
    const [copy] = await db
      .insert(alertRules)
      .values({ checkId: toCheckId, consecutiveFailures: r.consecutiveFailures, triggerOn: r.triggerOn, renotifyMinutes: r.renotifyMinutes, escalateAfterMinutes: r.escalateAfterMinutes, enabled: r.enabled })
      .returning();
    if (links.length) await db.insert(alertRuleChannels).values(links.map((l) => ({ alertRuleId: copy.id, channelId: l.channelId, escalation: l.escalation })));
  }
  return rules.length;
}
