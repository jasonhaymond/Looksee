import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { users } from "../db/schema.js";
import { SESSION_COOKIE_NAME, createSession, deleteSessionByToken, sessionCookieOptions } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

// Brute-force guard on the one credential-guessable endpoint this app has.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts. Please try again later." },
});

authRouter.post("/login", loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }

  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;
  if (!user || !valid) {
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const { token, expiresAt } = await createSession(user.id);
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions());
  res.json({ id: user.id, email: user.email, expiresAt });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (token) await deleteSessionByToken(token);
  res.clearCookie(SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ id: req.user!.id, email: req.user!.email });
});
