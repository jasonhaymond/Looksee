// Security tests for sign-in and the protective layer around it: mandatory
// two-factor (TOTP and recovery codes), IP-bound login challenges, lockouts,
// automatic blocking by security rules, scanner and key-guessing detection,
// the IP allowlist's self-lockout guard, session listing, single-use codes,
// secrets kept out of the security log, and passkeys.
//
// Runs against the real local test database (see README → Local
// development). Each test comment names the attack or failure it proves is
// handled. Every request carries its own X-Forwarded-For address (the test
// client is on loopback, which the default TRUST_PROXY trusts), so lockouts
// and blocks created here never touch the address other test files sign in
// from; all of them are removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// Sign-in does deliberate bcrypt work (cost 12) on every attempt.
vi.setConfig({ testTimeout: 30_000, hookTimeout: 30_000 });
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { ipBlocks, securityEvents, users } from "../src/db/schema.js";
import { totpCode, verifyTotp, base32Decode, base32Encode } from "../src/lib/totp.js";
import { ipInList } from "../src/lib/ipMatch.js";

// Test client addresses from 198.51.100.0/24 (a range reserved for
// documentation, never a real host). Each call returns an address not used
// before in this file: several tests deliberately get their address locked
// out or blocked, and a later test drawing the same address at random would
// be refused by that block and fail for the wrong reason. Starting from a
// random offset keeps repeated runs from reusing the same addresses.
let nextHost = Math.floor(Math.random() * 200);
const ip = () => `198.51.100.${20 + (nextHost++ % 200)}`;
const email = `test-security-${crypto.randomUUID()}@example.com`;
const password = "CorrectHorse123!";
// Every address used, so afterAll can remove the blocks and events they caused.
const usedIps: string[] = [];
const from = (addr: string) => {
  usedIps.push(addr);
  return addr;
};

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  if (usedIps.length) {
    await db.delete(ipBlocks).where(inArray(ipBlocks.ip, usedIps));
    await db.delete(securityEvents).where(inArray(securityEvents.ip, usedIps));
  }
});

describe("totp", () => {
  // Proves the authenticator-code maths matches the RFC 6238 standard, so
  // codes from any authenticator app are accepted and wrong codes aren't.
  it("round-trips base32 and matches RFC 6238's SHA-1 test vector", () => {
    const secret = base32Encode(Buffer.from("12345678901234567890"));
    expect(base32Decode(secret).toString()).toBe("12345678901234567890");
    // RFC 6238 appendix B: T = 59 s -> 94287082 (8 digits); 6 digits = 287082.
    expect(totpCode(secret, 59_000)).toBe("287082");
    expect(verifyTotp(secret, "287 082", 59_000)).toBe(true);
    expect(verifyTotp(secret, "000000", 59_000)).toBe(false);
  });

  // Proves allowlist/block matching handles IPv4, IPv4-mapped IPv6 (how Node
  // often reports IPv4 clients) and IPv6 ranges — a mismatch here would let a
  // blocked address through or lock out an allowed one.
  it("matches IPs against v4/v6 CIDR lists", () => {
    expect(ipInList("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipInList("::ffff:10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipInList("11.1.2.3", ["10.0.0.0/8", "192.168.1.5"])).toBe(false);
    expect(ipInList("2001:db8::5", ["2001:db8::/32"])).toBe(true);
  });
});

describe("sign-in with mandatory two-factor", () => {
  const addr = from(ip());
  let secret = "";
  let recovery: string[] = [];

  // Proves a stolen password alone never yields a session: the first sign-in
  // forces authenticator enrolment, a wrong code is refused, and the session
  // cookie is SameSite=Strict (other websites can't use it).
  it("never issues a session on the password alone, and enrolls on first sign-in", async () => {
    const step1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", addr).send({ email, password });
    expect(step1.status).toBe(200);
    expect(step1.headers["set-cookie"]).toBeUndefined();
    expect(step1.body.step).toBe("enroll");
    secret = step1.body.enroll.secret;
    expect(step1.body.enroll.uri).toMatch(/^otpauth:\/\/totp\//);

    const wrong = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", addr).send({ challengeId: step1.body.challengeId, code: "000000" });
    expect(wrong.status).toBe(401);

    const ok = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", addr).send({ challengeId: step1.body.challengeId, code: totpCode(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.recoveryCodes).toHaveLength(10);
    recovery = ok.body.recoveryCodes;
    const cookie = ok.headers["set-cookie"]![0];
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect((await request(app).get("/api/auth/me").set("Cookie", cookie)).status).toBe(200);
  });

  // Proves a recovery code works once and can't be replayed (it's removed
  // from the account when used).
  it("asks for the code next time, and accepts a recovery code exactly once", async () => {
    const step1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", addr).send({ email, password });
    expect(step1.body.step).toBe("totp");
    const viaRecovery = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", addr).send({ challengeId: step1.body.challengeId, recoveryCode: recovery[0] });
    expect(viaRecovery.status).toBe(200);

    const again = await request(app).post("/api/auth/login").set("X-Forwarded-For", addr).send({ email, password });
    const reused = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", addr).send({ challengeId: again.body.challengeId, recoveryCode: recovery[0] });
    expect(reused.status).toBe(401);
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    expect(user!.recoveryCodes).toHaveLength(9);
  });

  // Proves a half-finished sign-in can't be completed from another address:
  // an attacker who sees a challenge ID can't use it from elsewhere.
  it("rejects a challenge from a different IP", async () => {
    const step1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", addr).send({ email, password });
    const other = from(ip());
    const res = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", other).send({ challengeId: step1.body.challengeId, code: totpCode(secret) });
    expect(res.status).toBe(401);
  });
});

describe("lockout, rules and blocking", () => {
  // Proves password guessing is stopped: after repeated failures the address
  // is locked out and the "Password guessing" rule blocks it entirely, while
  // the health endpoint stays reachable for monitoring.
  it("locks out an IP after repeated failures and blocks it via the password-guessing rule", async () => {
    const attacker = from(ip());
    for (let i = 0; i < 5; i++) {
      const r = await request(app).post("/api/auth/login").set("X-Forwarded-For", attacker).send({ email: `nobody-${i}@example.com`, password: "wrong" });
      expect([401, 403]).toContain(r.status);
    }
    // The rule blocked the IP: everything (except health) is now refused.
    const blocked = await request(app).post("/api/auth/login").set("X-Forwarded-For", attacker).send({ email, password });
    expect(blocked.status).toBe(403);
    expect((await request(app).get("/api/health").set("X-Forwarded-For", attacker)).status).toBe(200);
    const rows = await db.query.ipBlocks.findMany({ where: eq(ipBlocks.ip, attacker) });
    expect(rows.length).toBe(1);
    expect(rows[0].reason).toMatch(/Password guessing/);
  });

  // Proves vulnerability scanners (requests for /.env, WordPress and
  // phpMyAdmin paths) are logged and then blocked.
  it("records scanner probes and blocks the scanner", async () => {
    const scanner = from(ip());
    for (const path of ["/.env", "/wp-login.php", "/phpmyadmin/index.php"]) {
      expect((await request(app).get(path).set("X-Forwarded-For", scanner)).status).toBe(404);
    }
    const probes = await db.query.securityEvents.findMany({ where: eq(securityEvents.ip, scanner) });
    expect(probes.filter((e) => e.kind === "scan_probe").length).toBe(3);
    expect((await request(app).get("/api/auth/me").set("X-Forwarded-For", scanner)).status).toBe(403);
  });

  // Proves agent-key guessing is recorded, which feeds the "Agent key
  // guessing" rule that blocks repeat offenders.
  it("logs bad agent keys", async () => {
    const guesser = from(ip());
    await request(app).get("/api/agent/config").set("X-Forwarded-For", guesser).set("Authorization", "Bearer not-a-real-key");
    const ev = await db.query.securityEvents.findMany({ where: eq(securityEvents.ip, guesser) });
    expect(ev.some((e) => e.kind === "bad_agent_key")).toBe(true);
  });
});

describe("security settings", () => {
  let cookie: string;
  const admin = `test-security-admin-${crypto.randomUUID()}@example.com`;
  const adminIp = from(ip());

  // A signed-in admin (password + authenticator code) for the settings routes.
  beforeAll(async () => {
    await db.insert(users).values({ email: admin, passwordHash: await bcrypt.hash(password, 10) });
    const secret = "JBSWY3DPEHPK3PXP";
    await db.update(users).set({ totpSecret: secret, totpEnabled: true }).where(eq(users.email, admin));
    const s1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", adminIp).send({ email: admin, password });
    const s2 = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", adminIp).send({ challengeId: s1.body.challengeId, code: totpCode(secret) });
    cookie = s2.headers["set-cookie"]![0];
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.email, admin));
  });

  // Proves the admin can't accidentally lock themselves out with an
  // allowlist that excludes their own address, and that malformed entries
  // are rejected rather than silently ignored.
  it("refuses an allowlist that would lock out the current IP, and rejects bad entries", async () => {
    const lockout = await request(app).patch("/api/security/settings").set("Cookie", cookie).set("X-Forwarded-For", adminIp).send({ allowlistEnabled: true, allowlist: ["203.0.113.0/24"] });
    expect(lockout.status).toBe(400);
    expect(lockout.body.error).toMatch(/lock yourself out/);
    const bad = await request(app).patch("/api/security/settings").set("Cookie", cookie).set("X-Forwarded-For", adminIp).send({ allowlist: ["not-an-ip"] });
    expect(bad.status).toBe(400);
  });

  // Proves the default protective rules exist, and the admin can't block
  // their own address by hand.
  it("lists the seeded rules and can't block its own IP by hand", async () => {
    const rules = await request(app).get("/api/security/rules").set("Cookie", cookie).set("X-Forwarded-For", adminIp);
    expect(rules.body.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(["Password guessing", "Vulnerability scanner"]));
    const self = await request(app).post("/api/security/blocks").set("Cookie", cookie).set("X-Forwarded-For", adminIp).send({ ip: adminIp });
    expect(self.status).toBe(400);
  });

  // Proves the session list never reveals session tokens, which would let
  // anyone who sees the page hijack another session.
  it("shows sessions without exposing their tokens", async () => {
    const res = await request(app).get("/api/security/sessions").set("Cookie", cookie).set("X-Forwarded-For", adminIp);
    expect(res.status).toBe(200);
    expect(res.body.some((s: { current: boolean }) => s.current)).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(cookie.split(";")[0].split("=")[1]);
  });
});

describe("review fixes", () => {
  // Proves an authenticator code can't be replayed: an attacker who sees a
  // code being typed can't reuse it within its 30-second window.
  it("accepts each authenticator code only once", async () => {
    const { consumeTotp } = await import("../src/lib/totp.js");
    const secret = "JBSWY3DPEHPK3PXP";
    const code = totpCode(secret);
    const id = `replay-${crypto.randomUUID()}`;
    expect(consumeTotp(id, secret, code)).toBe(true);
    expect(consumeTotp(id, secret, code)).toBe(false);
  });

  // Proves an attacker can't lock the real owner out (a denial of service)
  // by failing sign-ins as them from other addresses, and that the owner's
  // own typos at home are never auto-blocked.
  it("doesn't let failures elsewhere lock the account out from a known IP, and never auto-blocks it", async () => {
    const owner = `test-owner-${crypto.randomUUID()}@example.com`;
    const home = from(ip());
    const secret = "JBSWY3DPEHPK3PXP";
    await db.insert(users).values({ email: owner, passwordHash: await bcrypt.hash(password, 10), totpSecret: secret, totpEnabled: true });
    const { trustedIps } = await import("../src/db/schema.js");
    const u = await db.query.users.findFirst({ where: eq(users.email, owner) });
    await db.insert(trustedIps).values({ userId: u!.id, ip: home });
    // An attacker fails as this account from several IPs.
    for (let i = 0; i < 6; i++) await request(app).post("/api/auth/login").set("X-Forwarded-For", from(ip())).send({ email: owner, password: "wrong" });
    // The owner, from home, still gets the second step.
    const ok = await request(app).post("/api/auth/login").set("X-Forwarded-For", home).send({ email: owner, password });
    expect(ok.status).toBe(200);
    // Five typos at home: not blocked (the rule notifies instead).
    for (let i = 0; i < 5; i++) await request(app).post("/api/auth/login").set("X-Forwarded-For", home).send({ email: owner, password: "typo" });
    expect(await db.query.ipBlocks.findFirst({ where: eq(ipBlocks.ip, home) })).toBeUndefined();
    await db.delete(users).where(eq(users.email, owner));
  });

  // Proves a mistyped or guessed heartbeat token is logged without the token
  // itself — a real token one character off must not end up in the log.
  it("never stores heartbeat tokens in the security log", async () => {
    const who = from(ip());
    await request(app).get("/api/hb/super-secret-token-value").set("X-Forwarded-For", who);
    const ev = await db.query.securityEvents.findMany({ where: eq(securityEvents.ip, who) });
    expect(ev.length).toBeGreaterThan(0);
    expect(JSON.stringify(ev)).not.toContain("super-secret-token-value");
  });
});

describe("passkeys", () => {
  const pkUser = `test-passkey-${crypto.randomUUID()}@example.com`;
  const pkIp = from(ip());
  // RFC 6238 test-vector secret (not a real credential; allowlisted in .gitleaks.toml).
  const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
  let cookie = "";
  // A signed-in user with an authenticator and no passkeys yet.
  beforeAll(async () => {
    await db.insert(users).values({ email: pkUser, passwordHash: await bcrypt.hash(password, 10), totpSecret: secret, totpEnabled: true });
    const s1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", pkIp).send({ email: pkUser, password });
    expect(s1.body.passkey).toBeNull();
    const s2 = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", pkIp).send({ challengeId: s1.body.challengeId, code: totpCode(secret) });
    cookie = s2.headers["set-cookie"]![0];
  });
  afterAll(async () => {
    await db.delete(users).where(eq(users.email, pkUser));
  });

  // Proves a stolen session alone can't add the attacker's own passkey (a
  // current authenticator code is required), and a forged registration is
  // rejected.
  it("needs a current authenticator code to start adding a passkey", async () => {
    const bad = await request(app).post("/api/auth/passkeys/options").set("Cookie", cookie).set("X-Forwarded-For", pkIp).send({ code: "000000" });
    expect(bad.status).toBe(400);
    // Next 30 s step, since codes are single-use.
    const ok = await request(app).post("/api/auth/passkeys/options").set("Cookie", cookie).set("X-Forwarded-For", pkIp).send({ code: totpCode(secret, Date.now() + 30_000) });
    expect(ok.status).toBe(200);
    expect(ok.body.options.rp.name).toBe("Looksee");
    expect(ok.body.options.user.name).toBe(pkUser);
    const forged = await request(app).post("/api/auth/passkeys").set("Cookie", cookie).set("X-Forwarded-For", pkIp).send({ challengeId: ok.body.challengeId, name: "x", response: { id: "AAAA", rawId: "AAAA", type: "public-key", response: { clientDataJSON: "e30", attestationObject: "AA" }, clientExtensionResults: {} } });
    expect(forged.status).toBe(400);
    expect((await request(app).get("/api/auth/passkeys").set("Cookie", cookie)).body).toEqual([]);
  });

  // Proves a forged passkey signature never yields a session.
  it("offers passkey sign-in once one exists, and rejects a forged assertion", async () => {
    const u = await db.query.users.findFirst({ where: eq(users.email, pkUser) });
    const { webauthnCredentials } = await import("../src/db/schema.js");
    await db.insert(webauthnCredentials).values({ userId: u!.id, credentialId: "dGVzdC1jcmVk", publicKey: "AAAA", name: "Fake key" });
    const s1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", pkIp).send({ email: pkUser, password });
    expect(s1.body.passkey.allowCredentials[0].id).toBe("dGVzdC1jcmVk");
    const forged = await request(app)
      .post("/api/auth/login/verify")
      .set("X-Forwarded-For", pkIp)
      .send({ challengeId: s1.body.challengeId, passkey: { id: "dGVzdC1jcmVk", rawId: "dGVzdC1jcmVk", type: "public-key", response: { clientDataJSON: "e30", authenticatorData: "AA", signature: "AA" }, clientExtensionResults: {} } });
    expect(forged.status).toBe(401);
    expect(forged.headers["set-cookie"]).toBeUndefined();
  });
});
