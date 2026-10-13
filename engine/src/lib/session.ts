import crypto from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";

export const SESSION_COOKIE_NAME = "looksee_session";
const DEFAULT_TTL_HOURS = 720;

export function sessionCookieOptions(hours = DEFAULT_TTL_HOURS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    // strict: the session cookie is never sent on a request started from
    // another site, which closes off cross-site request forgery outright.
    sameSite: "strict" as const,
    maxAge: hours * 3_600_000,
  };
}

export async function createSession(userId: string, opts: { hours?: number; ip?: string | null; userAgent?: string | null } = {}) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + (opts.hours ?? DEFAULT_TTL_HOURS) * 3_600_000);
  await db.insert(sessions).values({ token, userId, expiresAt, ip: opts.ip ?? null, userAgent: opts.userAgent?.slice(0, 300) ?? null, lastSeenAt: new Date() });
  return { token, expiresAt };
}

export async function deleteSessionByToken(token: string) {
  await db.delete(sessions).where(eq(sessions.token, token));
}

export async function pruneExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}

// Sessions are listed and revoked by a hash of the token, so the Security
// page never handles a live session token.
export const sessionId = (token: string) => crypto.createHash("sha256").update(token).digest("hex").slice(0, 16);
