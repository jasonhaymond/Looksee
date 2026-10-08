import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults, alertRules, alertRuleChannels, alertEvents, notificationChannels, checkDependencies } from "../db/schema.js";
import { sendEmail } from "./notifications/email.js";
import { sendWebhook } from "./notifications/webhook.js";
import { sendWebPush } from "./notifications/webpush.js";
import { isInMaintenance } from "./maintenance.js";
import type { Status } from "./thresholds.js";
import { logger } from "../lib/logger.js";

export type ResultInput = {
  status: Status;
  latencyMs?: number | null;
  message?: string | null;
  value?: number | null;
  details?: unknown;
};

// Flap detection (L4), Nagios-style with hysteresis: a check whose last
// FLAP_WINDOW results changed state at least FLAP_START times is flapping
// until changes fall to FLAP_STOP or fewer. While flapping, new alerts are
// held back — one noisy check shouldn't spam every channel.
const FLAP_WINDOW = 21;
const FLAP_START = 7;
const FLAP_STOP = 3;

// Shared by every result source (engine probes, agent reports, push URLs)
// so "what counts as a result, and what happens next" lives in one place.
export async function recordCheckResult(checkId: string, input: ResultInput) {
  const check = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
  if (!check) return;
  const now = new Date();
  const inMaintenance = await isInMaintenance(check, now);

  await db.insert(checkResults).values({
    checkId,
    status: input.status,
    latencyMs: input.latencyMs ?? null,
    message: input.message ?? null,
    value: input.value ?? null,
    details: input.details ?? null,
    inMaintenance,
    checkedAt: now,
  });

  const recent = await db
    .select({ status: checkResults.status })
    .from(checkResults)
    .where(eq(checkResults.checkId, checkId))
    .orderBy(desc(checkResults.checkedAt))
    .limit(FLAP_WINDOW);
  let changes = 0;
  for (let i = 1; i < recent.length; i++) if (recent[i].status !== recent[i - 1].status) changes++;
  const flapping = check.flapping ? changes > FLAP_STOP : changes >= FLAP_START;
  if (flapping && !check.flapping) {
    logger.warn("alerting", `Check ${checkId} started flapping (${changes} state changes in ${recent.length} results)`, `"${check.name}" is flapping between states — alerts for it are held until it settles.`, { checkId });
  }

  await db
    .update(checks)
    .set({
      lastStatus: input.status,
      lastMessage: input.message ?? null,
      lastValue: input.value ?? null,
      lastLatencyMs: input.latencyMs ?? null,
      lastCheckedAt: now,
      lastStatusChangeAt: check.lastStatus !== input.status ? now : check.lastStatusChangeAt,
      flapping,
    })
    .where(eq(checks.id, checkId));

  if (inMaintenance) return;
  await evaluateAlertRules({ ...check, flapping }, input);
}

async function parentDown(checkId: string): Promise<string | null> {
  const deps = await db.query.checkDependencies.findMany({ where: eq(checkDependencies.checkId, checkId) });
  if (deps.length === 0) return null;
  const parents = await db.query.checks.findMany({ where: inArray(checks.id, deps.map((d) => d.dependsOnCheckId)) });
  return parents.find((p) => p.lastStatus === "down")?.name ?? null;
}

const failing = (status: string, triggerOn: string) => status === "down" || (triggerOn === "warn" && status === "warn");

async function evaluateAlertRules(check: typeof checks.$inferSelect, latest: ResultInput) {
  const rules = await db.query.alertRules.findMany({ where: and(eq(alertRules.checkId, check.id), eq(alertRules.enabled, true)) });
  if (rules.length === 0) return;
  const blockedBy = await parentDown(check.id);

  for (const rule of rules) {
    const recent = await db.query.checkResults.findMany({
      where: and(eq(checkResults.checkId, check.id), eq(checkResults.inMaintenance, false)),
      orderBy: desc(checkResults.checkedAt),
      limit: rule.consecutiveFailures,
    });
    const allFailing = recent.length >= rule.consecutiveFailures && recent.every((r) => failing(r.status, rule.triggerOn));
    const openEvent = await db.query.alertEvents.findFirst({
      where: and(eq(alertEvents.alertRuleId, rule.id), isNull(alertEvents.resolvedAt)),
      orderBy: desc(alertEvents.triggeredAt),
    });

    if (allFailing && !openEvent) {
      if (blockedBy) {
        logger.info("alerting", `Suppressed alert for check ${check.id}: parent "${blockedBy}" is down`, `"${check.name}" is failing, but its parent check "${blockedBy}" is down, so no alert was sent.`, { checkId: check.id });
        continue;
      }
      if (check.flapping) continue;
      const severity = latest.status === "warn" ? "warn" : "down";
      const text = `${check.name} is ${severity.toUpperCase()}${latest.message ? `: ${latest.message}` : ""}`;
      await db.insert(alertEvents).values({ alertRuleId: rule.id, severity, message: text, lastNotifiedAt: new Date() });
      await notify(rule.id, `[Looksee] ${text}`, `${check.name} is ${severity.toUpperCase()}`, false);
    } else if (openEvent && latest.status !== "unknown" && !failing(latest.status, rule.triggerOn)) {
      await db.update(alertEvents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(alertEvents.id, openEvent.id));
      await notify(rule.id, `[Looksee] ${check.name} has recovered (now ${latest.status.toUpperCase()}).`, `${check.name} recovered`, Boolean(openEvent.escalatedAt));
    }
  }
}

// L12: re-notify and escalate still-open incidents. Run on a one-minute
// timer from index.ts, independent of when results arrive — a check that
// stops reporting entirely must still escalate.
export async function processOpenAlerts(now = new Date()) {
  const open = await db.query.alertEvents.findMany({ where: isNull(alertEvents.resolvedAt) });
  for (const event of open) {
    const rule = await db.query.alertRules.findFirst({ where: eq(alertRules.id, event.alertRuleId) });
    if (!rule || !rule.enabled) continue;
    const check = await db.query.checks.findFirst({ where: eq(checks.id, rule.checkId) });
    if (!check || (await isInMaintenance(check, now))) continue;
    const text = event.message ?? `${check.name} is still failing`;

    if (rule.escalateAfterMinutes && !event.escalatedAt && now.getTime() - event.triggeredAt.getTime() >= rule.escalateAfterMinutes * 60_000) {
      await db.update(alertEvents).set({ escalatedAt: now }).where(eq(alertEvents.id, event.id));
      await notify(rule.id, `[Looksee] ESCALATED — ${text} (open for ${rule.escalateAfterMinutes}+ min)`, `Escalated: ${check.name}`, true, true);
      continue;
    }
    const last = event.lastNotifiedAt ?? event.triggeredAt;
    if (rule.renotifyMinutes && now.getTime() - last.getTime() >= rule.renotifyMinutes * 60_000) {
      await db.update(alertEvents).set({ lastNotifiedAt: now }).where(eq(alertEvents.id, event.id));
      await notify(rule.id, `[Looksee] Still failing — ${text}`, `Still failing: ${check.name}`, Boolean(event.escalatedAt));
    }
  }
}

// includeEscalation: also send to the rule's escalation channels (once an
// incident has escalated, its reminders and recovery go there too).
// escalationOnly: just the escalation channels (the escalation notice itself).
async function notify(alertRuleId: string, message: string, subject: string, includeEscalation: boolean, escalationOnly = false) {
  const links = await db.query.alertRuleChannels.findMany({ where: eq(alertRuleChannels.alertRuleId, alertRuleId) });
  const chosen = links.filter((l) => (escalationOnly ? l.escalation : !l.escalation || includeEscalation));
  for (const link of chosen) {
    const channel = await db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, link.channelId) });
    if (!channel || !channel.enabled) continue;
    try {
      if (channel.type === "email") await sendEmail(channel.config, message, subject);
      else if (channel.type === "webhook") await sendWebhook(channel.config, message);
      else if (channel.type === "web_push") await sendWebPush(channel.config, message);
      // SMS sender lands once a provider is chosen (see spec.md deferred
      // items) — an enabled sms channel is a no-op for now, not an error.
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      logger.error(
        "alerting",
        `Failed to notify via channel ${channel.id} (${channel.type}): ${detail}`,
        `An alert couldn't be delivered through your "${channel.type}" channel — check its configuration on the Channels page.`,
        { channelId: channel.id, channelType: channel.type }
      );
    }
  }
}
