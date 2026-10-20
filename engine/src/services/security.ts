// Security events and responses: settings, the event log (failed logins,
// lockouts, scans, allowlist denials…), rules that notify or block an address
// automatically, IP blocks, and recognising known exploit/scanner paths.
//
// Blocks never apply to the admin's own known addresses, so a rule can't lock
// the admin out.

import type { Request } from "express";
import { and, eq, gt, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { ipBlocks, notificationChannels, securityEvents, securityRules, securitySettings, trustedIps, users } from "../db/schema.js";
import { buildList, clientIp, ipInList, listHas } from "../lib/ipMatch.js";
import { logger } from "../lib/logger.js";
import { sendEmail } from "./notifications/email.js";
import { deliverText } from "./alerting.js";
import { dashboardUrl } from "./notifications/templates.js";
import { own } from "../lib/own.js";

export type SecuritySettings = typeof securitySettings.$inferSelect;

// Every kind the engine records, with a plain description for the rule
// editor and the event log filter.
export const SECURITY_EVENT_KINDS: Record<string, { label: string; severity: "info" | "warn" | "critical" }> = {
  login_success: { label: "Successful sign-in", severity: "info" },
  login_failed: { label: "Failed sign-in (wrong email or password)", severity: "warn" },
  login_locked: { label: "Sign-in refused: account or IP locked out", severity: "warn" },
  login_new_ip: { label: "Sign-in from a new IP address", severity: "warn" },
  new_ip_confirmed: { label: "New IP confirmed by emailed code", severity: "info" },
  totp_failed: { label: "Wrong two-factor code, passkey or email code", severity: "warn" },
  totp_enrolled: { label: "Two-factor authentication set up", severity: "info" },
  passkey_added: { label: "Passkey added", severity: "warn" },
  passkey_removed: { label: "Passkey removed", severity: "info" },
  recovery_code_used: { label: "Two-factor recovery code used", severity: "warn" },
  password_changed: { label: "Password changed", severity: "warn" },
  session_revoked: { label: "Session signed out remotely", severity: "info" },
  allowlist_denied: { label: "Request from an IP not on the allowlist", severity: "warn" },
  ip_blocked: { label: "IP blocked (by a rule or by hand)", severity: "warn" },
  scan_probe: { label: "Scanner/exploit probe (e.g. /.env, /wp-login.php)", severity: "warn" },
  bad_agent_key: { label: "Agent/collector request with an invalid key", severity: "warn" },
  bad_push_token: { label: "Heartbeat URL with an unknown token", severity: "info" },
  rate_limited: { label: "Rate limit hit", severity: "warn" },
  settings_changed: { label: "Security settings changed", severity: "warn" },
};

export const DEFAULT_RULES: Omit<typeof securityRules.$inferInsert, "id">[] = [
  { name: "Password guessing", kinds: ["login_failed", "totp_failed"], threshold: 5, windowMinutes: 10, perIp: true, notify: true, blockMinutes: 60, cooldownMinutes: 60 },
  { name: "Vulnerability scanner", kinds: ["scan_probe"], threshold: 3, windowMinutes: 10, perIp: true, notify: true, blockMinutes: 1440, cooldownMinutes: 360 },
  { name: "Agent key guessing", kinds: ["bad_agent_key"], threshold: 10, windowMinutes: 10, perIp: true, notify: true, blockMinutes: 60, cooldownMinutes: 60 },
  { name: "Heartbeat token guessing", kinds: ["bad_push_token"], threshold: 30, windowMinutes: 10, perIp: true, notify: true, blockMinutes: 60, cooldownMinutes: 60 },
  { name: "Sign-in from a new IP", kinds: ["login_new_ip"], threshold: 1, windowMinutes: 1, perIp: true, notify: true, blockMinutes: null, cooldownMinutes: 0 },
  { name: "Lockout or password change", kinds: ["login_locked", "password_changed", "recovery_code_used"], threshold: 1, windowMinutes: 1, perIp: false, notify: true, blockMinutes: null, cooldownMinutes: 0 },
];

let settingsCache: { at: number; value: SecuritySettings } | null = null;

export async function getSecuritySettings(): Promise<SecuritySettings> {
  if (settingsCache && Date.now() - settingsCache.at < 10_000) return settingsCache.value;
  let [row] = await db.select().from(securitySettings).where(eq(securitySettings.id, 1));
  if (!row) {
    [row] = await db.insert(securitySettings).values({ id: 1 }).onConflictDoNothing().returning();
    row ??= (await db.select().from(securitySettings).where(eq(securitySettings.id, 1)))[0];
    // First run: seed the default rules alongside the settings row.
    if (!(await db.select({ id: securityRules.id }).from(securityRules).limit(1)).length) await db.insert(securityRules).values(DEFAULT_RULES);
  }
  settingsCache = { at: Date.now(), value: row };
  return row;
}

export function invalidateSecurityCache() {
  settingsCache = null;
  blockCache = null;
}

// ---- IP blocks ---------------------------------------------------------

let blockCache: { at: number; list: ReturnType<typeof buildList>; entries: string[] } | null = null;

export async function isBlocked(ip: string): Promise<boolean> {
  if (!blockCache || Date.now() - blockCache.at > 10_000) {
    const rows = await db.select({ ip: ipBlocks.ip }).from(ipBlocks).where(or(isNull(ipBlocks.until), gt(ipBlocks.until, new Date())));
    const entries = rows.map((r) => r.ip);
    blockCache = { at: Date.now(), list: buildList(entries), entries };
  }
  return listHas(blockCache.list, ip);
}

export async function blockIp(ip: string, minutes: number | null, reason: string) {
  await db.insert(ipBlocks).values({ ip, reason, until: minutes ? new Date(Date.now() + minutes * 60_000) : null });
  blockCache = null;
  await recordSecurityEvent("ip_blocked", { ip, detail: `${reason}${minutes ? ` — for ${minutes} min` : " — until removed"}` });
}

// ---- events and rules --------------------------------------------------

type EventInput = { ip?: string | null; req?: Request; detail?: string; path?: string };

// Heartbeat URLs carry their credential in the path; never log it.
const maskPath = (p: string) => p.replace(/(\/api\/hb\/)[^/?#]+/i, "$1…");

export async function recordSecurityEvent(kind: string, input: EventInput = {}) {
  const ip = input.ip ?? (input.req ? clientIp(input.req) : null);
  const meta = own(SECURITY_EVENT_KINDS, kind) ?? { severity: "info" };
  try {
    await db.insert(securityEvents).values({
      kind,
      severity: meta.severity,
      ip,
      userAgent: input.req?.get("user-agent")?.slice(0, 300) ?? null,
      path: (() => {
        const p = input.path ?? input.req?.originalUrl;
        return p ? maskPath(p).slice(0, 300) : null;
      })(),
      detail: input.detail?.slice(0, 1000) ?? null,
    });
    await evaluateRules(kind, ip, input.detail);
  } catch (err) {
    logger.error("security", `Recording security event ${kind} failed: ${err instanceof Error ? err.message : String(err)}`, "A security event couldn't be recorded.");
  }
}

async function evaluateRules(kind: string, ip: string | null, detail?: string) {
  const rules = (await db.query.securityRules.findMany({ where: eq(securityRules.enabled, true) })).filter((r) => r.kinds.includes(kind));
  for (const rule of rules) {
    if (rule.perIp && !ip) continue;
    const since = new Date(Date.now() - rule.windowMinutes * 60_000);
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(securityEvents)
      .where(and(inArray(securityEvents.kind, rule.kinds), gte(securityEvents.createdAt, since), rule.perIp ? eq(securityEvents.ip, ip!) : undefined));
    if (n < rule.threshold) continue;
    // Cooldown is per rule (and per IP for per-IP rules, tracked in memory)
    // so one attacker doesn't produce an email per request.
    const key = `${rule.id}|${rule.perIp ? ip : "*"}`;
    const last = lastFired.get(key) ?? (rule.perIp ? 0 : rule.lastFiredAt?.getTime() ?? 0);
    if (rule.cooldownMinutes > 0 && Date.now() - last < rule.cooldownMinutes * 60_000) continue;
    lastFired.set(key, Date.now());
    await db.update(securityRules).set({ lastFiredAt: new Date() }).where(eq(securityRules.id, rule.id));
    const what = own(SECURITY_EVENT_KINDS, kind)?.label ?? kind;
    let action = "";
    if (rule.blockMinutes && ip && !(await isBlocked(ip))) {
      // Never auto-block an address you've told Looksee is yours — five
      // typos at home shouldn't lock you out for an hour. You still get the
      // notification.
      if (await isOwnAddress(ip)) action = ` ${ip} wasn't blocked because it's on your allowlist or one you've signed in from before.`;
      else {
        await blockIp(ip, rule.blockMinutes, `Rule "${rule.name}"`);
        action = ` ${ip} has been blocked for ${rule.blockMinutes} minutes.`;
      }
    }
    logger.warn("security", `Security rule "${rule.name}" fired (${n} × ${rule.kinds.join("/")} in ${rule.windowMinutes} min, ip ${ip ?? "any"})`, `Security rule "${rule.name}" fired.${action}`, { ip, rule: rule.id });
    if (rule.notify) {
      await notifySecurity(
        `Security: ${rule.name}${ip && rule.perIp ? ` from ${ip}` : ""}`,
        `${rule.name}: ${n} event(s) in the last ${rule.windowMinutes} minute(s).\nLatest: ${what}${ip ? ` from ${ip}` : ""}${detail ? ` — ${detail}` : ""}.${action}\n\nReview it on the Security page: ${dashboardUrl()}/security`
      );
    }
  }
}
const lastFired = new Map<string, number>();

export async function notifySecurity(title: string, body: string) {
  const s = await getSecuritySettings();
  const to = s.notifyEmail || (await db.query.users.findFirst())?.email;
  if (to) await sendEmail({ to }, body, title).catch((err) => logger.error("security", `Security email failed: ${err instanceof Error ? err.message : String(err)}`, "A security notification email couldn't be sent — check SMTP settings on the Channels page."));
  if (s.notifyChannelIds.length) {
    const channels = await db.query.notificationChannels.findMany({ where: inArray(notificationChannels.id, s.notifyChannelIds) });
    for (const ch of channels) {
      if (!ch.enabled || ch.type === "email") continue;
      await deliverText(ch, title, body, `${dashboardUrl()}/security`).catch((err) => logger.error("security", `Security notification via ${ch.type} failed: ${err instanceof Error ? err.message : String(err)}`, `A security notification couldn't be sent through "${ch.name}".`));
    }
  }
}

// An allowlisted IP, or one any user has signed in from.
export async function isOwnAddress(ip: string): Promise<boolean> {
  const s = await getSecuritySettings();
  if (s.allowlist.length && ipInList(ip, s.allowlist)) return true;
  return Boolean(await db.query.trustedIps.findFirst({ where: eq(trustedIps.ip, ip) }));
}

// ---- lockout -----------------------------------------------------------

// Locked out when the IP, or the account (by email), has reached the
// threshold of failed sign-ins within the lockout window. The account-wide
// lockout doesn't apply from IPs the account has signed in from before —
// otherwise anyone could lock the admin out just by failing as them.
export async function lockedOut(ip: string, email: string): Promise<boolean> {
  const s = await getSecuritySettings();
  if (s.lockoutThreshold <= 0) return false;
  const since = new Date(Date.now() - s.lockoutMinutes * 60_000);
  const [{ byIp }] = await db.select({ byIp: sql<number>`count(*)::int` }).from(securityEvents).where(and(inArray(securityEvents.kind, ["login_failed", "totp_failed"]), eq(securityEvents.ip, ip), gte(securityEvents.createdAt, since)));
  const [{ byEmail }] = await db
    .select({ byEmail: sql<number>`count(*)::int` })
    .from(securityEvents)
    .where(and(inArray(securityEvents.kind, ["login_failed", "totp_failed"]), eq(securityEvents.detail, `account ${email}`), gte(securityEvents.createdAt, since)));
  if (byIp >= s.lockoutThreshold) return true;
  if (byEmail < s.lockoutThreshold) return false;
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  const known = user ? await db.query.trustedIps.findFirst({ where: and(eq(trustedIps.userId, user.id), eq(trustedIps.ip, ip)) }) : undefined;
  return !known;
}

export async function adminEmail(): Promise<string | undefined> {
  return (await db.select({ email: users.email }).from(users).limit(1))[0]?.email;
}

// Known exploit/scanner paths — nothing in Looksee lives at any of these,
// so a request for one is a probe, not a typo. Compared as plain text
// (lower-case), so checking costs the same whatever a request sends.
const SCAN_CONTAINS = ["/.env", "/.git", "/wp-login", "/wp-admin", "/wp-content", "/wp-includes", "xmlrpc.php", "/phpmyadmin", "/pma/", "/cgi-bin", "/actuator", "/server-status", "/vendor/phpunit", "/boaform", "/hnap1", "/.aws", "/admin.php", "/shell", "/.ds_store", "../", "%2e%2e", "/etc/passwd", "/owa/", "/remote/fgt_lang", "/geoserver", "/solr/", "/console/", "/manager/html"];
const SCAN_ENDS = ["/config.json", ".php", ".asp", ".aspx", ".jsp"];

/** Whether a requested URL is a known exploit/scanner path. */
export function looksLikeScan(url: string): boolean {
  const u = url.toLowerCase();
  return SCAN_CONTAINS.some((s) => u.includes(s)) || SCAN_ENDS.some((s) => u.endsWith(s));
}
