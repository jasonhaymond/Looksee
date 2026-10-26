// Sign-in checks that run before protected routes.
//
// requireAuth: the dashboard's session cookie must match an unexpired session
// in the database, or the request gets 401. requireAgentAuth: an agent's (or
// site collector's) bearer key must belong to an endpoint. Without these,
// anyone who can reach the server could read or change everything. Middleware
// are functions Express runs before a route's own code.

import type { NextFunction, Request, Response } from "express";
import { eq, gt, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, users, endpoints } from "../db/schema.js";
import { SESSION_COOKIE_NAME } from "../lib/session.js";
import { getSecuritySettings, recordSecurityEvent } from "../services/security.js";
import { own } from "../lib/own.js";
import { clientIp } from "../lib/ipMatch.js";

// Adds the signed-in user / authenticated agent to Express's request type
// (TypeScript "module augmentation": extends a library's own type).
declare module "express-serve-static-core" {
  interface Request {
    user?: { id: string; email: string };
    // name/hostname ride along so log lines can say which machine they're
    // about, not just its ID.
    agentEndpoint?: { id: string; siteId: string; name: string; hostname: string | null };
  }
}

// Single-admin-user auth: any valid, non-expired session cookie is enough —
// there's no role check because there's only one role. See CLAUDE.md.
export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = own(req.cookies as Record<string, string> | undefined, SESSION_COOKIE_NAME);
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
//
// app.ts runs this once for /api/agent and /api/collector *before* the
// request body is read, so a body-parser failure (a report over the size
// limit) can still be logged against the right endpoint; the routers run it
// again as their own guard, and the second run returns straight away.
//
// Side effect: remembers the address the endpoint's agent last connected
// from (endpoints.last_agent_ip), written only when it changes. The security
// rules use it to tell a site's shared address, where good agents are
// checking in, from a stranger guessing keys (services/security.ts).
export async function requireAgentAuth(req: Request, res: Response, next: NextFunction) {
  if (req.agentEndpoint) return next();
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
  req.agentEndpoint = { id: host.id, siteId: host.siteId, name: host.name, hostname: host.hostname };
  const ip = clientIp(req);
  if (ip && ip !== host.lastAgentIp) await db.update(endpoints).set({ lastAgentIp: ip }).where(eq(endpoints.id, host.id));
  next();
}
