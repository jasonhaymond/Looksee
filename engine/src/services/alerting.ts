import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, checkResults, alertRules, alertRuleChannels, alertEvents, notificationChannels, checkDependencies, endpoints, sites, locations } from "../db/schema.js";
import { sendEmail } from "./notifications/email.js";
import { sendWebhook } from "./notifications/webhook.js";
import { sendWebPush } from "./notifications/webpush.js";
import { sendSlack, sendTeams, sendTelegram } from "./notifications/chat.js";
import { dashboardUrl, formatDuration, renderFor, type AlertContext, type AlertEvent, type Templates } from "./notifications/templates.js";
import { remediationFor } from "./remediation.js";
import { recordSighting } from "./addresses.js";
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

  // An ARP check that found its device is also an address sighting.
  if (check.type === "arp_presence" && input.status === "up") {
    const d = (input.details ?? {}) as { mac?: string; ip?: string };
    const cfg = (check.config ?? {}) as { mac?: string; ip?: string };
    const mac = d.mac ?? cfg.mac;
    const ip = d.ip ?? cfg.ip;
    if (mac && ip) await recordSighting({ mac, ip, source: "arp", endpointId: check.endpointId, siteId: check.siteId }).catch(() => undefined);
  }

  // A recovery (failing → up) also recovers every check set to "recover
  // with" this one (config.recoverWithCheckId). Done before the maintenance
  // early-return, so followers recover even while this check is silenced.
  if (input.status === "up" && check.lastStatus && check.lastStatus !== "up") {
    await resolveFollowers(check).catch((err) => logger.error("alerting", `Recovering checks that follow ${checkId} failed: ${err instanceof Error ? err.message : String(err)}`, `Checks set to recover together with "${check.name}" couldn't be recovered automatically.`));
  }

  if (inMaintenance) return;
  await evaluateAlertRules({ ...check, flapping }, input);
}

// How a check was resolved without a new probe result of its own: by hand,
// because the check it follows recovered, by an "up" push to its recovery
// URL, or automatically after its auto-recovery delay.
export type ResolvedBy = "manual" | "check" | "push" | "auto";

/**
 * Marks a check as recovered now, without running it: records an "up"
 * result (which closes its open alert incident and sends the usual
 * "recovered" notification) and remembers the moment in the check's state as
 * `resolvedAt`. Event checks (traps/syslog) ignore events received up to
 * that moment, so old messages can't make them fail again; checks that poll
 * simply report their real status on their next run.
 *
 * @param checkId the check to resolve
 * @param message shown as the result message, e.g. "Manually resolved: …"
 * @param by how it was resolved (kept in the result's details)
 * @returns false if the check doesn't exist
 */
export async function resolveCheck(checkId: string, message: string, by: ResolvedBy): Promise<boolean> {
  const check = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
  if (!check) return false;
  const now = new Date();
  await db
    .update(checks)
    .set({ state: { ...((check.state as Record<string, unknown>) ?? {}), resolvedAt: now.toISOString(), resolvedBy: by } })
    .where(eq(checks.id, checkId));
  await recordCheckResult(checkId, { status: "up", message: message.slice(0, 1000), details: { resolved: by, at: now.toISOString() } });
  return true;
}

/**
 * Recovers the failing checks that are set to recover together with this
 * one (config.recoverWithCheckId = its ID). A follower recovering in turn
 * recovers its own followers; cycles end because only failing checks are
 * touched.
 */
async function resolveFollowers(check: typeof checks.$inferSelect) {
  const followers = await db
    .select({ id: checks.id, config: checks.config, lastStatus: checks.lastStatus })
    .from(checks)
    .where(inArray(checks.lastStatus, ["down", "warn"]));
  for (const f of followers) {
    if ((f.config as Record<string, unknown>)?.recoverWithCheckId === check.id) {
      await resolveCheck(f.id, `Recovered together with "${check.name}"`, "check");
    }
  }
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
      await notify(rule.id, await alertContext(check, "triggered", severity, latest.message ?? null, null), false);
    } else if (openEvent && latest.status !== "unknown" && !failing(latest.status, rule.triggerOn)) {
      await db.update(alertEvents).set({ status: "resolved", resolvedAt: new Date() }).where(eq(alertEvents.id, openEvent.id));
      await notify(rule.id, await alertContext(check, "resolved", latest.status, latest.message ?? null, openEvent.triggeredAt), Boolean(openEvent.escalatedAt));
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
    const status = check.lastStatus ?? event.severity;
    if (rule.escalateAfterMinutes && !event.escalatedAt && now.getTime() - event.triggeredAt.getTime() >= rule.escalateAfterMinutes * 60_000) {
      await db.update(alertEvents).set({ escalatedAt: now }).where(eq(alertEvents.id, event.id));
      await notify(rule.id, await alertContext(check, "escalated", status, check.lastMessage, event.triggeredAt), true, true);
      continue;
    }
    const last = event.lastNotifiedAt ?? event.triggeredAt;
    if (rule.renotifyMinutes && now.getTime() - last.getTime() >= rule.renotifyMinutes * 60_000) {
      await db.update(alertEvents).set({ lastNotifiedAt: now }).where(eq(alertEvents.id, event.id));
      await notify(rule.id, await alertContext(check, "reminder", status, check.lastMessage, event.triggeredAt), Boolean(event.escalatedAt));
    }
  }
}

// Everything a template can mention, looked up once per notification.
export async function alertContext(check: typeof checks.$inferSelect, event: AlertEvent, status: string, message: string | null, openedAt: Date | null): Promise<AlertContext> {
  const host = check.endpointId ? await db.query.endpoints.findFirst({ where: eq(endpoints.id, check.endpointId) }) : undefined;
  const endpoint = await db.query.sites.findFirst({ where: eq(sites.id, check.siteId) });
  const location = endpoint?.locationId ? await db.query.locations.findFirst({ where: eq(locations.id, endpoint.locationId) }) : undefined;
  const hints = remediationFor({ type: check.type, status: event === "resolved" ? "up" : status, message, config: check.config });
  return {
    event,
    check: check.name,
    checkId: check.id,
    type: check.type.replace(/_/g, " "),
    status: status.toUpperCase(),
    message: message ?? "",
    host: host?.name ?? "",
    endpoint: endpoint?.name ?? "",
    location: location?.name ?? "",
    time: new Date().toLocaleString(),
    duration: openedAt ? formatDuration(Date.now() - openedAt.getTime()) : "",
    remediation: hints.map((h) => `• ${h}`).join("\n"),
    url: `${dashboardUrl()}/checks/${check.id}`,
  };
}

// One channel, one rendered message — also what the Channels page's "Send
// test" uses, so a test proves the exact path a real alert takes.
export async function deliver(channel: typeof notificationChannels.$inferSelect, ctx: AlertContext) {
  const { title, body } = renderFor(channel.templates as Templates, ctx);
  await deliverText(channel, title, body, ctx.url, ctx.status, ctx);
}

// Sends an already-rendered message; security notifications use this
// directly since they aren't about a check.
export async function deliverText(channel: typeof notificationChannels.$inferSelect, title: string, body: string, url?: string, status?: string, vars: Record<string, unknown> = {}) {
  if (channel.type === "email") await sendEmail(channel.config, body, title);
  else if (channel.type === "webhook") await sendWebhook(channel.config, body, { ...vars, title, url });
  else if (channel.type === "web_push") await sendWebPush(channel.config, body, title, url);
  else if (channel.type === "telegram") await sendTelegram(channel.config, title, body);
  else if (channel.type === "slack") await sendSlack(channel.config, title, body);
  else if (channel.type === "teams") await sendTeams(channel.config, title, body, { url, status });
  // SMS sender lands once a provider is chosen (see spec.md deferred
  // items) — an enabled sms channel is a no-op for now, not an error.
}

// includeEscalation: also send to the rule's escalation channels (once an
// incident has escalated, its reminders and recovery go there too).
// escalationOnly: just the escalation channels (the escalation notice itself).
async function notify(alertRuleId: string, ctx: AlertContext, includeEscalation: boolean, escalationOnly = false) {
  const links = await db.query.alertRuleChannels.findMany({ where: eq(alertRuleChannels.alertRuleId, alertRuleId) });
  const chosen = links.filter((l) => (escalationOnly ? l.escalation : !l.escalation || includeEscalation));
  for (const link of chosen) {
    const channel = await db.query.notificationChannels.findFirst({ where: eq(notificationChannels.id, link.channelId) });
    if (!channel || !channel.enabled) continue;
    try {
      await deliver(channel, ctx);
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
