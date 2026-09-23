import type { NextFunction, Request, Response } from "express";
import { eq, gt, and } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions, users, hosts } from "../db/schema.js";
import { SESSION_COOKIE_NAME } from "../lib/session.js";

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string };
      agentHost?: { id: string; endpointId: string };
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
  const user = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!user) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }
  req.user = { id: user.id, email: user.email };
  next();
}

// Auth for the agent-ingest endpoint: a bearer token that must match a
// host's own agentApiKey, scoping the request to exactly that host.
export async function requireAgentAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (!token) {
    res.status(401).json({ error: "Missing agent token" });
    return;
  }
  const host = await db.query.hosts.findFirst({ where: eq(hosts.agentApiKey, token) });
  if (!host) {
    res.status(401).json({ error: "Invalid agent token" });
    return;
  }
  req.agentHost = { id: host.id, endpointId: host.endpointId };
  next();
}
