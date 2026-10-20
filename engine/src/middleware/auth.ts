import type { NextFunction, Request, Response } from "express";
import { eq, gt, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, users, endpoints } from "../db/schema.js";
import { SESSION_COOKIE_NAME } from "../lib/session.js";
import { getSecuritySettings, recordSecurityEvent } from "../services/security.js";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
      agentEndpoint?: { id: string; siteId: string };
    }
  }
}

// Single-admin-user auth: any valid, non-expired session cookie is enough —
// there's no role check because there's only one role. See CLAUDE.md.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (!token) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const row = await db.query.sessions.findFirst({
    where: and(eq(sessions.token, token), gt(sessions.expiresAt, new Date())),
  });
  if (!row) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  const settings = await getSecuritySettings();
  const lastSeen = row.lastSeenAt ?? row.createdAt;
  if (settings.idleTimeoutMinutes && Date.now() - lastSeen.getTime() > settings.idleTimeoutMinutes * 60_000) {
    await db.delete(sessions).where(eq(sessions.token, token));
    res.status(401).json({ error: "Signed out after being idle" });
    return;
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  // Written at most once a minute — every dashboard poll passes through here.
  if (Date.now() - lastSeen.getTime() > 60_000) await db.update(sessions).set({ lastSeenAt: new Date() }).where(eq(sessions.token, token));
  req.user = { id: user.id, email: user.email };
  next();
}

// Auth for the agent-ingest endpoint: a bearer token that must match a
// host's own agentApiKey, scoping the request to exactly that host.
export async function requireAgentAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    await recordSecurityEvent("bad_agent_key", { req, detail: "no key sent" });
    res.status(401).json({ error: "Missing agent token" });
    return;
  }
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.agentApiKey, token) });
  if (!host) {
    await recordSecurityEvent("bad_agent_key", { req, detail: "unknown key" });
    res.status(401).json({ error: "Invalid agent token" });
    return;
  }
  req.agentEndpoint = { id: host.id, siteId: host.siteId };
  next();
}
