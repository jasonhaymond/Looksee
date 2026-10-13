import { Router } from "express";
import { and, desc, eq, gte, ilike, isNull, or, gt, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { ipBlocks, securityEvents, securityRules, securitySettings, sessions, trustedIps, users } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { clientIp, ipInList, parseIpOrCidr } from "../lib/ipMatch.js";
import { SESSION_COOKIE_NAME, sessionId } from "../lib/session.js";
import { SECURITY_EVENT_KINDS, blockIp, getSecuritySettings, invalidateSecurityCache, notifySecurity, recordSecurityEvent } from "../services/security.js";

export const securityRouter = Router();
securityRouter.use(requireAuth);

const intIn = (v: unknown, min: number, max: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : undefined;
};

securityRouter.get("/overview", async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  res.json({
    settings: await getSecuritySettings(),
    yourIp: clientIp(req),
    totpEnabled: user?.totpEnabled ?? false,
    recoveryCodesLeft: user?.recoveryCodes.length ?? 0,
    passwordChangedAt: user?.passwordChangedAt ?? null,
    kinds: Object.entries(SECURITY_EVENT_KINDS).map(([kind, m]) => ({ kind, ...m })),
    trustProxy: process.env.TRUST_PROXY || "loopback, linklocal, uniquelocal (default)",
  });
});

securityRouter.patch("/settings", async (req, res) => {
  const b = req.body ?? {};
  const current = await getSecuritySettings();
  const u: Partial<typeof securitySettings.$inferInsert> = { updatedAt: new Date() };
  if (b.allowlist !== undefined) {
    const raw: string[] = Array.isArray(b.allowlist) ? b.allowlist.map(String) : String(b.allowlist).split(/[\s,]+/);
    const entries = [...new Set(raw.map((x) => x.trim()).filter(Boolean))];
    const bad = entries.find((e) => !parseIpOrCidr(e));
    if (bad) {
      res.status(400).json({ error: `"${bad}" isn't an IP address or CIDR range` });
      return;
    }
    u.allowlist = entries;
  }
  if (b.allowlistEnabled !== undefined) u.allowlistEnabled = Boolean(b.allowlistEnabled);
  if (b.allowlistAgents !== undefined) u.allowlistAgents = Boolean(b.allowlistAgents);
  // Refuse a change that would lock out the browser making it.
  const enabled = u.allowlistEnabled ?? current.allowlistEnabled;
  const list = u.allowlist ?? current.allowlist;
  if (enabled && (!list.length || !ipInList(clientIp(req), list))) {
    res.status(400).json({ error: `Your current IP (${clientIp(req)}) isn't in the allowlist — add it first, or you'd lock yourself out.` });
    return;
  }
  if (b.newIpConfirmation !== undefined) u.newIpConfirmation = Boolean(b.newIpConfirmation);
  if (b.detectScans !== undefined) u.detectScans = Boolean(b.detectScans);
  if (b.lockoutThreshold !== undefined) u.lockoutThreshold = intIn(b.lockoutThreshold, 0, 100);
  if (b.lockoutMinutes !== undefined) u.lockoutMinutes = intIn(b.lockoutMinutes, 1, 1440);
  if (b.sessionHours !== undefined) u.sessionHours = intIn(b.sessionHours, 1, 8760);
  if (b.idleTimeoutMinutes !== undefined) u.idleTimeoutMinutes = b.idleTimeoutMinutes ? intIn(b.idleTimeoutMinutes, 5, 10080) : null;
  if (b.minPasswordLength !== undefined) u.minPasswordLength = intIn(b.minPasswordLength, 8, 128);
  if (b.notifyEmail !== undefined) u.notifyEmail = b.notifyEmail ? String(b.notifyEmail).trim() : null;
  if (b.notifyChannelIds !== undefined) u.notifyChannelIds = Array.isArray(b.notifyChannelIds) ? b.notifyChannelIds.map(String) : [];
  const [row] = await db.update(securitySettings).set(u).where(eq(securitySettings.id, 1)).returning();
  invalidateSecurityCache();
  await recordSecurityEvent("settings_changed", { req, detail: Object.keys(u).filter((k) => k !== "updatedAt").join(", ") });
  res.json(row);
});

securityRouter.post("/test-notification", async (_req, res) => {
  await notifySecurity("Security: test notification", "This is a test of Looksee's security notifications. If you can read this, attack and sign-in alerts will reach you here.");
  res.json({ sent: true });
});

// ---- events ------------------------------------------------------------

securityRouter.get("/events", async (req, res) => {
  const q = (k: string) => (typeof req.query[k] === "string" && req.query[k] ? String(req.query[k]) : undefined);
  const hours = intIn(q("hours") ?? 168, 1, 24 * 365)!;
  const limit = intIn(q("limit") ?? 300, 1, 2000)!;
  const rows = await db
    .select()
    .from(securityEvents)
    .where(
      and(
        gte(securityEvents.createdAt, new Date(Date.now() - hours * 3_600_000)),
        q("kind") ? eq(securityEvents.kind, q("kind")!) : undefined,
        q("ip") ? eq(securityEvents.ip, q("ip")!) : undefined,
        q("severity") ? eq(securityEvents.severity, q("severity")!) : undefined,
        q("q") ? or(ilike(securityEvents.ip, `%${q("q")}%`), ilike(securityEvents.detail, `%${q("q")}%`), ilike(securityEvents.path, `%${q("q")}%`), ilike(securityEvents.userAgent, `%${q("q")}%`)) : undefined
      )
    )
    .orderBy(desc(securityEvents.createdAt))
    .limit(limit);
  res.json(rows);
});

// ---- rules -------------------------------------------------------------

function ruleFields(b: Record<string, unknown>): Partial<typeof securityRules.$inferInsert> | { error: string } {
  const out: Partial<typeof securityRules.$inferInsert> = {};
  if (b.name !== undefined) out.name = String(b.name).trim();
  if (b.kinds !== undefined) {
    const kinds = Array.isArray(b.kinds) ? b.kinds.map(String).filter((k) => k in SECURITY_EVENT_KINDS) : [];
    if (!kinds.length) return { error: "Pick at least one event type" };
    out.kinds = kinds;
  }
  if (b.enabled !== undefined) out.enabled = Boolean(b.enabled);
  if (b.threshold !== undefined) out.threshold = intIn(b.threshold, 1, 10000);
  if (b.windowMinutes !== undefined) out.windowMinutes = intIn(b.windowMinutes, 1, 10080);
  if (b.perIp !== undefined) out.perIp = Boolean(b.perIp);
  if (b.notify !== undefined) out.notify = Boolean(b.notify);
  if (b.blockMinutes !== undefined) out.blockMinutes = b.blockMinutes ? intIn(b.blockMinutes, 1, 525600) : null;
  if (b.cooldownMinutes !== undefined) out.cooldownMinutes = intIn(b.cooldownMinutes, 0, 10080);
  if (out.blockMinutes && out.perIp === false) return { error: "Blocking needs a per-IP rule" };
  return out;
}

securityRouter.get("/rules", async (_req, res) => {
  await getSecuritySettings(); // seeds defaults on first use
  res.json(await db.query.securityRules.findMany({ orderBy: (r, { asc }) => asc(r.createdAt) }));
});

securityRouter.post("/rules", async (req, res) => {
  const f = ruleFields(req.body ?? {});
  if ("error" in f) {
    res.status(400).json(f);
    return;
  }
  if (!f.name || !f.kinds) {
    res.status(400).json({ error: "name and kinds are required" });
    return;
  }
  const [rule] = await db.insert(securityRules).values(f as typeof securityRules.$inferInsert).returning();
  res.status(201).json(rule);
});

securityRouter.patch("/rules/:id", async (req, res) => {
  const f = ruleFields(req.body ?? {});
  if ("error" in f) {
    res.status(400).json(f);
    return;
  }
  const [rule] = await db.update(securityRules).set(f).where(eq(securityRules.id, req.params.id)).returning();
  if (!rule) {
    res.status(404).json({ error: "Rule not found" });
    return;
  }
  res.json(rule);
});

securityRouter.delete("/rules/:id", async (req, res) => {
  await db.delete(securityRules).where(eq(securityRules.id, req.params.id));
  res.status(204).end();
});

// ---- blocks ------------------------------------------------------------

securityRouter.get("/blocks", async (_req, res) => {
  res.json(await db.select().from(ipBlocks).where(or(isNull(ipBlocks.until), gt(ipBlocks.until, new Date()))).orderBy(desc(ipBlocks.createdAt)));
});

securityRouter.post("/blocks", async (req, res) => {
  const ip = String(req.body?.ip ?? "").trim();
  if (!parseIpOrCidr(ip)) {
    res.status(400).json({ error: "Enter an IP address or CIDR range" });
    return;
  }
  if (ipInList(clientIp(req), [ip])) {
    res.status(400).json({ error: "That would block your own current IP." });
    return;
  }
  await blockIp(ip, req.body?.minutes ? intIn(req.body.minutes, 1, 525600)! : null, String(req.body?.reason || "Blocked by hand"));
  res.status(201).json({ ok: true });
});

securityRouter.delete("/blocks/:id", async (req, res) => {
  await db.delete(ipBlocks).where(eq(ipBlocks.id, req.params.id));
  invalidateSecurityCache();
  res.status(204).end();
});

// ---- trusted IPs and sessions -----------------------------------------

securityRouter.get("/trusted-ips", async (req, res) => {
  res.json(await db.query.trustedIps.findMany({ where: eq(trustedIps.userId, req.user!.id), orderBy: (t, { desc }) => desc(t.lastSeenAt) }));
});

securityRouter.delete("/trusted-ips/:id", async (req, res) => {
  await db.delete(trustedIps).where(and(eq(trustedIps.id, req.params.id), eq(trustedIps.userId, req.user!.id)));
  res.status(204).end();
});

securityRouter.get("/sessions", async (req, res) => {
  const current = req.cookies?.[SESSION_COOKIE_NAME];
  const rows = await db.query.sessions.findMany({ where: and(eq(sessions.userId, req.user!.id), gt(sessions.expiresAt, new Date())), orderBy: (s, { desc }) => desc(s.lastSeenAt) });
  res.json(rows.map((s) => ({ id: sessionId(s.token), ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, expiresAt: s.expiresAt, current: s.token === current })));
});

// id "others" signs out every session except this one.
securityRouter.delete("/sessions/:id", async (req, res) => {
  const current = req.cookies?.[SESSION_COOKIE_NAME];
  const rows = await db.query.sessions.findMany({ where: eq(sessions.userId, req.user!.id) });
  const doomed = rows.filter((s) => (req.params.id === "others" ? s.token !== current : sessionId(s.token) === req.params.id)).map((s) => s.token);
  if (doomed.length) await db.delete(sessions).where(inArray(sessions.token, doomed));
  await recordSecurityEvent("session_revoked", { req, detail: `${doomed.length} session(s)` });
  res.json({ revoked: doomed.length });
});
