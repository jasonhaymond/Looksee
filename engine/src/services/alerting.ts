import { desc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checkResults, alertRules, alertRuleChannels, alertEvents, notificationChannels } from "../db/schema.js";
import { sendEmail } from "./notifications/email.js";
import { sendWebhook } from "./notifications/webhook.js";
import { sendWebPush } from "./notifications/webpush.js";

type Status = "up" | "down" | "warn" | "unknown";

// Shared by both the agentless prober and the agent-report ingest endpoint
// so "what counts as a result, and what happens next" lives in exactly one
// place regardless of where the result came from.
export async function recordCheckResult(
  checkId: string,
  status: Status,
  latencyMs: number | null,
  message: string | null
) {
  await db.insert(checkResults).values({ checkId, status, latencyMs, message });
  await evaluateAlertRules(checkId, status);
}

async function evaluateAlertRules(checkId: string, latestStatus: Status) {
  const rules = await db.query.alertRules.findMany({
    where: eq(alertRules.checkId, checkId),
  });

  for (const rule of rules) {
    if (!rule.enabled) continue;

    const recent = await db.query.checkResults.findMany({
      where: eq(checkResults.checkId, checkId),
      orderBy: desc(checkResults.checkedAt),
      limit: rule.consecutiveFailures,
    });
    const allFailing = recent.length >= rule.consecutiveFailures && recent.every((r) => r.status === "down");

    const openEvent = await db.query.alertEvents.findFirst({
      where: eq(alertEvents.alertRuleId, rule.id),
      orderBy: desc(alertEvents.triggeredAt),
    });
    const isOpen = openEvent && openEvent.status === "triggered";

    if (allFailing && !isOpen) {
      const [event] = await db.insert(alertEvents).values({ alertRuleId: rule.id }).returning();
      await notify(rule.id, `Check is down (${rule.consecutiveFailures} consecutive failures).`);
      void event;
    } else if (latestStatus === "up" && isOpen) {
      await db.update(alertEvents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(alertEvents.id, openEvent!.id));
      await notify(rule.id, "Check has recovered.");
    }
  }
}

async function notify(alertRuleId: string, message: string) {
  const links = await db.query.alertRuleChannels.findMany({ where: eq(alertRuleChannels.alertRuleId, alertRuleId) });
  for (const link of links) {
    const channel = await db.query.notificationChannels.findFirst({
      where: eq(notificationChannels.id, link.channelId),
    });
    if (!channel || !channel.enabled) continue;
    try {
      if (channel.type === "email") await sendEmail(channel.config, message);
      else if (channel.type === "webhook") await sendWebhook(channel.config, message);
      else if (channel.type === "web_push") await sendWebPush(channel.config, message);
      // SMS sender lands once a provider is chosen (see spec.md deferred
      // items) — an enabled sms channel is a no-op for now, not an error.
    } catch (err) {
      console.error(`Failed to notify via channel ${channel.id} (${channel.type}):`, err);
    }
  }
}
