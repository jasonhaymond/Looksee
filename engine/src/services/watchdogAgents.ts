// Watchdog agents: endpoints whose agent alerts on its own when it can't
// reach Looksee — the alert path that still works when the Looksee server
// (or its database) is down, since Looksee can't alert about itself then.
//
// Where this sits: settings are saved on the endpoint (endpoints.watchdog)
// through PATCH /api/endpoints/:id/watchdog (routes/endpoints.ts). Every
// config poll from that endpoint's agent (GET /api/agent/config,
// routes/agent.ts) includes the spec built here: how long to wait, the SMTP
// settings and recipients, and the chat channels' delivery settings. The
// agent keeps a copy on disk so it still has it during an outage
// (agent/internal/watchdog).
//
// Security: the spec carries secrets — the SMTP password, chat bot tokens
// and webhook URLs. It is only sent to an agent that authenticated with its
// own key, only for an endpoint an admin has made a watchdog, only over the
// agent's existing connection (HTTPS in production), and only for the
// channel types the agent can deliver. The agent stores it readable by its
// own service account only. Everywhere else (dashboard, API reads) these
// settings stay write-only, as before.

import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { notificationChannels, type WatchdogSetting, type endpoints } from "../db/schema.js";
import { resolveSettings } from "./notifications/email.js";
import { dashboardUrl } from "./notifications/templates.js";
import { own, setOwn } from "../lib/own.js";
import { isUuid } from "../lib/ids.js";

/** Channel types a watchdog agent can deliver to (besides email). */
export const WATCHDOG_CHANNEL_TYPES = ["telegram", "slack", "teams", "webhook"] as const;

// An email address: something@something.tld, no spaces — enough to catch
// typos; the mail server is the real judge.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Validates watchdog settings from the dashboard.
 *
 * @param body { enabled, afterMinutes, emailTo (list or comma/line text), channelIds }
 * @returns the settings to store, or an error message for a 400 response
 */
export async function parseWatchdog(body: Record<string, unknown>): Promise<{ value?: WatchdogSetting; error?: string }> {
  const enabled = body.enabled === true;
  // 1 minute to 1 day; 5 by default.
  const after = Number(body.afterMinutes ?? 5);
  const afterMinutes = Number.isFinite(after) ? Math.min(1440, Math.max(1, Math.round(after))) : 5;
  const rawTo = Array.isArray(body.emailTo) ? body.emailTo.map(String) : typeof body.emailTo === "string" ? body.emailTo.split(/[\s,;]+/) : [];
  const emailTo = [...new Set(rawTo.map((e) => e.trim()).filter(Boolean))].slice(0, 20);
  const bad = emailTo.find((e) => !EMAIL_RE.test(e) || e.length > 254);
  if (bad) return { error: `"${bad.slice(0, 80)}" isn't an email address` };
  const channelIds = Array.isArray(body.channelIds) ? [...new Set(body.channelIds.map(String))].slice(0, 20) : [];
  if (channelIds.some((id) => !isUuid(id))) return { error: "channelIds must be channel IDs" };
  if (channelIds.length) {
    // Each channel must exist and be a type the agent can deliver.
    const found = await db.select({ id: notificationChannels.id, type: notificationChannels.type }).from(notificationChannels).where(inArray(notificationChannels.id, channelIds));
    if (found.length !== channelIds.length) return { error: "One or more channels don't exist" };
    const unsupported = found.find((c) => !(WATCHDOG_CHANNEL_TYPES as readonly string[]).includes(c.type));
    if (unsupported) return { error: `A watchdog agent can post to ${WATCHDOG_CHANNEL_TYPES.join(", ")} channels, not ${unsupported.type}` };
  }
  if (enabled && !emailTo.length && !channelIds.length) return { error: "Choose at least one email address or channel to alert" };
  return { value: { enabled, afterMinutes, emailTo, channelIds } };
}

/** What a watchdog agent receives with its config (see the file header). */
export type WatchdogSpec = {
  afterSeconds: number;
  endpointName: string;
  dashboardUrl: string;
  email: { host: string; port: number; user: string; password: string; from: string; to: string[] } | null;
  chats: { type: string; name: string; config: Record<string, string> }[];
  // Changes each time "Send test" is pressed; the agent sends one test
  // message per new value.
  testId: string | null;
};

/**
 * The watchdog spec for an endpoint's agent, or null when the endpoint
 * isn't an enabled watchdog.
 *
 * @param endpoint the endpoint row (its watchdog settings and name)
 */
export async function watchdogSpecFor(endpoint: Pick<typeof endpoints.$inferSelect, "name" | "watchdog">): Promise<WatchdogSpec | null> {
  const w = endpoint.watchdog;
  if (!w?.enabled) return null;
  let email: WatchdogSpec["email"] = null;
  if (w.emailTo?.length) {
    const smtp = await resolveSettings();
    // Without a mail server configured, email can't be sent from anywhere.
    if (smtp.host) email = { host: smtp.host, port: Number(smtp.port) || 587, user: smtp.user ?? "", password: smtp.password ?? "", from: smtp.from, to: w.emailTo };
  }
  const chats: WatchdogSpec["chats"] = [];
  if (w.channelIds?.length) {
    const rows = await db.query.notificationChannels.findMany({ where: and(inArray(notificationChannels.id, w.channelIds), eq(notificationChannels.enabled, true)) });
    for (const c of rows) {
      if (!(WATCHDOG_CHANNEL_TYPES as readonly string[]).includes(c.type)) continue;
      // Only the plain-text settings the agent's senders use.
      const config = Object.fromEntries(Object.entries((c.config as Record<string, unknown>) ?? {}).filter(([, v]) => typeof v === "string" || typeof v === "number").map(([k, v]) => [k, String(v)]));
      chats.push({ type: c.type, name: c.name, config });
    }
  }
  return { afterSeconds: w.afterMinutes * 60, endpointName: endpoint.name, dashboardUrl: dashboardUrl(), email, chats, testId: w.testRequestedAt ?? null };
}

/**
 * Cleans the status a watchdog agent reports (when it last alerted, tested,
 * recovered, or failed to send) before it's stored: known keys only, short
 * strings, so an agent can't store arbitrary data.
 *
 * @param raw body.watchdogStatus from the agent's report
 */
export function cleanWatchdogStatus(raw: unknown): Record<string, string | boolean> | null {
  if (!raw || typeof raw !== "object") return null;
  const keys = ["unreachableSince", "lastAlertAt", "lastRecoveryAt", "lastTestAt", "lastTestId", "lastError", "lastErrorAt"];
  const out: Record<string, string | boolean> = {};
  for (const k of keys) {
    const v = own(raw as Record<string, unknown>, k);
    if (typeof v === "string" && v) setOwn(out, k, v.slice(0, 500));
  }
  out.alerting = (raw as Record<string, unknown>).alerting === true;
  return out;
}
