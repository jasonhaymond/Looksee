import crypto from "node:crypto";
import { eq, lt } from "drizzle-orm";
import { db } from "../db/index.js";
import { sessions } from "../db/schema.js";

export const SESSION_COOKIE_NAME = "looksee_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    maxAge: SESSION_TTL_MS,
  };
}

export async function createSession(userId: string) {
  const token = crypto.randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  await db.insert(sessions).values({ token, userId, expiresAt });
  return { token, expiresAt };
}

export async function deleteSessionByToken(token: string) {
  await db.delete(sessions).where(eq(sessions.token, token));
}

// Not scheduled anywhere yet — cheap enough to call opportunistically (e.g.
// from a future admin "housekeeping" action) once there's an admin UI action
// to hang it off; expired sessions are already rejected on read regardless.
export async function pruneExpiredSessions() {
  await db.delete(sessions).where(lt(sessions.expiresAt, new Date()));
}
