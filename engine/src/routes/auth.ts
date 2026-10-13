import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { and, eq, gt, ne } from "drizzle-orm";
import { db } from "../db/index.js";
import { loginChallenges, sessions, trustedIps, users } from "../db/schema.js";
import { SESSION_COOKIE_NAME, createSession, deleteSessionByToken, sessionCookieOptions } from "../lib/session.js";
import { requireAuth } from "../middleware/auth.js";
import { clientIp } from "../lib/ipMatch.js";
import { consumeTotp, generateRecoveryCodes, generateTotpSecret, otpauthUri } from "../lib/totp.js";
import { getSecuritySettings, lockedOut, recordSecurityEvent } from "../services/security.js";
import { sendEmail } from "../services/notifications/email.js";

export const authRouter = Router();

// A coarse ceiling per IP on top of the lockout rules below.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    void recordSecurityEvent("rate_limited", { req, detail: "sign-in" });
    res.status(429).json({ error: "Too many attempts. Please try again later." });
  },
});

const CHALLENGE_MINUTES = 10;
const DUMMY_HASH = bcrypt.hashSync("not-a-real-password", 12);
const MAX_CHALLENGE_ATTEMPTS = 5;

// Step 1: email + password. Never issues a session by itself — two-factor
// is mandatory, so a right password always leads to a challenge: enrol an
// authenticator (first sign-in) or enter its code, plus an emailed code when
// new-IP confirmation is on and this IP hasn't been confirmed before.
authRouter.post("/login", loginLimiter, async (req, res) => {
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  const ip = clientIp(req);
  if (!email || !password) {
    res.status(400).json({ error: "Email and password are required" });
    return;
  }
  if (await lockedOut(ip, email)) {
    await recordSecurityEvent("login_locked", { req, detail: `account ${email}` });
    res.status(429).json({ error: "Too many failed sign-ins — try again later." });
    return;
  }
  const user = await db.query.users.findFirst({ where: eq(users.email, email) });
  // Compare against a dummy hash when the user doesn't exist so timing
  // doesn't reveal which emails have accounts.
  const valid = await bcrypt.compare(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !valid) {
    await recordSecurityEvent("login_failed", { req, detail: `account ${email}` });
    res.status(401).json({ error: "Invalid credentials" });
    return;
  }

  const settings = await getSecuritySettings();
  const trusted = await db.query.trustedIps.findFirst({ where: and(eq(trustedIps.userId, user.id), eq(trustedIps.ip, ip)) });
  const needsEmail = settings.newIpConfirmation && !trusted;
  const enrollSecret = user.totpEnabled ? null : generateTotpSecret();
  let emailCode: string | null = null;
  if (needsEmail) {
    emailCode = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await sendEmail(
        { to: user.email },
        `Someone (hopefully you) signed in to Looksee from a new IP address: ${ip}.\n\nYour confirmation code is: ${emailCode}\n\nIt expires in ${CHALLENGE_MINUTES} minutes. If this wasn't you, change your password now — your password is known to whoever is signing in.`,
        `Sign-in code ${emailCode}`
      );
    } catch {
      res.status(503).json({ error: "This IP needs email confirmation, but the confirmation email couldn't be sent. Check SMTP settings, or turn new-IP confirmation off from the server (npm run security:reset)." });
      return;
    }
  }
  const [challenge] = await db
    .insert(loginChallenges)
    .values({ userId: user.id, ip, needsTotp: true, enrollSecret, emailCodeHash: emailCode ? await bcrypt.hash(emailCode, 10) : null, expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000) })
    .returning();
  res.json({
    challengeId: challenge.id,
    step: enrollSecret ? "enroll" : "totp",
    emailCode: needsEmail,
    ...(enrollSecret ? { enroll: { secret: enrollSecret, uri: otpauthUri(enrollSecret, user.email) } } : {}),
  });
});

// Step 2: the authenticator code (or a recovery code), and the emailed code
// when one was sent. Issues the session.
authRouter.post("/login/verify", loginLimiter, async (req, res) => {
  const ip = clientIp(req);
  const challenge = await db.query.loginChallenges.findFirst({ where: and(eq(loginChallenges.id, String(req.body?.challengeId ?? "")), gt(loginChallenges.expiresAt, new Date())) });
  if (!challenge || challenge.ip !== ip) {
    res.status(401).json({ error: "This sign-in has expired — start again." });
    return;
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, challenge.userId) });
  if (!user) {
    res.status(401).json({ error: "This sign-in has expired — start again." });
    return;
  }
  const attempts = challenge.attempts + 1;
  if (attempts > MAX_CHALLENGE_ATTEMPTS) {
    await db.delete(loginChallenges).where(eq(loginChallenges.id, challenge.id));
    res.status(429).json({ error: "Too many wrong codes — sign in again." });
    return;
  }
  await db.update(loginChallenges).set({ attempts }).where(eq(loginChallenges.id, challenge.id));
  const fail = async (what: string) => {
    await recordSecurityEvent("totp_failed", { req, detail: `account ${user.email}` });
    res.status(401).json({ error: `That ${what} isn't right.` });
  };

  if (challenge.emailCodeHash && !(await bcrypt.compare(String(req.body?.emailCode ?? "").trim(), challenge.emailCodeHash))) return fail("emailed code");

  const code = String(req.body?.code ?? "").trim();
  const recovery = String(req.body?.recoveryCode ?? "").trim().toLowerCase();
  let recoveryCodes: string[] | undefined;
  if (challenge.enrollSecret) {
    if (!consumeTotp(user.id, challenge.enrollSecret, code)) return fail("authenticator code");
    recoveryCodes = generateRecoveryCodes();
    await db
      .update(users)
      .set({ totpSecret: challenge.enrollSecret, totpEnabled: true, recoveryCodes: await Promise.all(recoveryCodes.map((c) => bcrypt.hash(c, 10))) })
      .where(eq(users.id, user.id));
    await recordSecurityEvent("totp_enrolled", { req, detail: user.email });
  } else if (recovery) {
    let match = -1;
    for (let i = 0; i < user.recoveryCodes.length; i++) if (await bcrypt.compare(recovery, user.recoveryCodes[i])) match = i;
    if (match < 0) return fail("recovery code");
    await db.update(users).set({ recoveryCodes: user.recoveryCodes.filter((_, i) => i !== match) }).where(eq(users.id, user.id));
    await recordSecurityEvent("recovery_code_used", { req, detail: `${user.recoveryCodes.length - 1} recovery code(s) left` });
  } else if (!user.totpSecret || !consumeTotp(user.id, user.totpSecret, code)) {
    return fail("authenticator code");
  }

  await db.delete(loginChallenges).where(eq(loginChallenges.id, challenge.id));
  const known = await db.query.trustedIps.findFirst({ where: and(eq(trustedIps.userId, user.id), eq(trustedIps.ip, ip)) });
  if (known) await db.update(trustedIps).set({ lastSeenAt: new Date() }).where(eq(trustedIps.id, known.id));
  else {
    await db.insert(trustedIps).values({ userId: user.id, ip }).onConflictDoNothing();
    // The first sign-in ever isn't "new" — there's nothing to compare with.
    const anyBefore = await db.query.trustedIps.findFirst({ where: and(eq(trustedIps.userId, user.id), ne(trustedIps.ip, ip)) });
    if (anyBefore) await recordSecurityEvent(challenge.emailCodeHash ? "new_ip_confirmed" : "login_new_ip", { req, detail: `${user.email} from ${ip}` });
    if (anyBefore && challenge.emailCodeHash) await recordSecurityEvent("login_new_ip", { req, detail: `${user.email} from ${ip} (confirmed by email)` });
  }
  const settings = await getSecuritySettings();
  const { token, expiresAt } = await createSession(user.id, { hours: settings.sessionHours, ip, userAgent: req.get("user-agent") });
  res.cookie(SESSION_COOKIE_NAME, token, sessionCookieOptions(settings.sessionHours));
  await recordSecurityEvent("login_success", { req, detail: user.email });
  res.json({ id: user.id, email: user.email, expiresAt, ...(recoveryCodes ? { recoveryCodes } : {}) });
});

authRouter.post("/logout", async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE_NAME];
  if (token) await deleteSessionByToken(token);
  res.clearCookie(SESSION_COOKIE_NAME, { sameSite: "strict", secure: process.env.NODE_ENV === "production", httpOnly: true });
  res.json({ ok: true });
});

authRouter.get("/me", requireAuth, async (req, res) => {
  res.json({ id: req.user!.id, email: req.user!.email });
});

// Needs the current password and a current authenticator code; signs out
// every other session.
authRouter.post("/password", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  const settings = await getSecuritySettings();
  const next = String(req.body?.newPassword ?? "");
  if (!user || !(await bcrypt.compare(String(req.body?.currentPassword ?? ""), user.passwordHash))) {
    res.status(400).json({ error: "Current password is wrong" });
    return;
  }
  if (!user.totpSecret || !consumeTotp(user.id, user.totpSecret, String(req.body?.code ?? ""))) {
    res.status(400).json({ error: "Authenticator code is wrong" });
    return;
  }
  if (next.length < settings.minPasswordLength) {
    res.status(400).json({ error: `Use at least ${settings.minPasswordLength} characters` });
    return;
  }
  await db.update(users).set({ passwordHash: await bcrypt.hash(next, 12), passwordChangedAt: new Date() }).where(eq(users.id, user.id));
  const current = req.cookies?.[SESSION_COOKIE_NAME];
  await db.delete(sessions).where(and(eq(sessions.userId, user.id), ne(sessions.token, current)));
  await recordSecurityEvent("password_changed", { req, detail: user.email });
  res.json({ ok: true });
});

// New recovery codes (the old ones stop working). Needs a current code.
authRouter.post("/recovery-codes", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  if (!user?.totpSecret || !consumeTotp(user.id, user.totpSecret, String(req.body?.code ?? ""))) {
    res.status(400).json({ error: "Authenticator code is wrong" });
    return;
  }
  const codes = generateRecoveryCodes();
  await db.update(users).set({ recoveryCodes: await Promise.all(codes.map((c) => bcrypt.hash(c, 10))) }).where(eq(users.id, user.id));
  res.json({ recoveryCodes: codes });
});

// Moving to a new phone: start returns a fresh secret; confirm swaps it in
// once a code from the new authenticator verifies. The old one keeps
// working until then.
authRouter.post("/totp/rotate", requireAuth, async (req, res) => {
  const user = await db.query.users.findFirst({ where: eq(users.id, req.user!.id) });
  if (!user?.totpSecret || !consumeTotp(user.id, user.totpSecret, String(req.body?.code ?? ""))) {
    res.status(400).json({ error: "Enter a current code from your existing authenticator" });
    return;
  }
  const secret = generateTotpSecret();
  const [challenge] = await db.insert(loginChallenges).values({ userId: user.id, ip: clientIp(req), needsTotp: true, enrollSecret: secret, expiresAt: new Date(Date.now() + CHALLENGE_MINUTES * 60_000) }).returning();
  res.json({ challengeId: challenge.id, secret, uri: otpauthUri(secret, user.email) });
});

authRouter.post("/totp/rotate/confirm", requireAuth, async (req, res) => {
  const challenge = await db.query.loginChallenges.findFirst({ where: and(eq(loginChallenges.id, String(req.body?.challengeId ?? "")), eq(loginChallenges.userId, req.user!.id), gt(loginChallenges.expiresAt, new Date())) });
  if (!challenge?.enrollSecret || !consumeTotp(`${req.user!.id}:rotate`, challenge.enrollSecret, String(req.body?.code ?? ""))) {
    res.status(400).json({ error: "That code isn't right for the new authenticator" });
    return;
  }
  await db.update(users).set({ totpSecret: challenge.enrollSecret, totpEnabled: true }).where(eq(users.id, req.user!.id));
  await db.delete(loginChallenges).where(eq(loginChallenges.id, challenge.id));
  await recordSecurityEvent("totp_enrolled", { req, detail: `${req.user!.email} moved to a new authenticator` });
  res.json({ ok: true });
});
