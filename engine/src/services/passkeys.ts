import { and, eq } from "drizzle-orm";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { db } from "../db/index.js";
import { loginChallenges, webauthnCredentials, type users } from "../db/schema.js";

type User = typeof users.$inferSelect;

// The relying party is the dashboard's own site: its hostname is the RP ID,
// and passkeys only work from the dashboard's origin(s). Both come from the
// URLs Looksee is already configured with; WEBAUTHN_RP_ID / WEBAUTHN_ORIGINS
// override them for unusual proxy setups.
function dashboardOrigin(): string {
  const url = process.env.DASHBOARD_URL || process.env.PUBLIC_URL || "http://localhost:3100";
  return new URL(url).origin;
}
export function rpId(): string {
  return process.env.WEBAUTHN_RP_ID || new URL(dashboardOrigin()).hostname;
}
export function expectedOrigins(): string[] {
  const list = process.env.WEBAUTHN_ORIGINS
    ? process.env.WEBAUTHN_ORIGINS.split(",")
    : [dashboardOrigin(), ...(process.env.CORS_ALLOWED_ORIGINS ?? "").split(",")];
  return [...new Set(list.map((o) => o.trim()).filter(Boolean))];
}

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const unb64 = (s: string) => new Uint8Array(Buffer.from(s, "base64url"));

export async function credentialsFor(userId: string) {
  return db.query.webauthnCredentials.findMany({ where: eq(webauthnCredentials.userId, userId), orderBy: (c, { asc }) => asc(c.createdAt) });
}

// Registration: options for the browser, with the challenge kept on a
// short-lived challenge row (the same table sign-in uses).
export async function startRegistration(user: User, ip: string) {
  const existing = await credentialsFor(user.id);
  const options = await generateRegistrationOptions({
    rpName: "Looksee",
    rpID: rpId(),
    userName: user.email,
    userID: new Uint8Array(Buffer.from(user.id)),
    attestationType: "none",
    excludeCredentials: existing.map((c) => ({ id: c.credentialId, transports: c.transports })),
    authenticatorSelection: { residentKey: "preferred", userVerification: "preferred" },
  });
  const [row] = await db
    .insert(loginChallenges)
    .values({ userId: user.id, ip, needsTotp: false, webauthnChallenge: options.challenge, expiresAt: new Date(Date.now() + 5 * 60_000) })
    .returning();
  return { challengeId: row.id, options };
}

export async function finishRegistration(user: User, challengeId: string, name: string, response: RegistrationResponseJSON) {
  const row = await db.query.loginChallenges.findFirst({ where: and(eq(loginChallenges.id, challengeId), eq(loginChallenges.userId, user.id)) });
  if (!row?.webauthnChallenge || row.expiresAt < new Date()) throw new Error("This passkey setup expired — start again.");
  await db.delete(loginChallenges).where(eq(loginChallenges.id, row.id));
  const result = await verifyRegistrationResponse({ response, expectedChallenge: row.webauthnChallenge, expectedOrigin: expectedOrigins(), expectedRPID: rpId() });
  if (!result.verified) throw new Error("The passkey couldn't be verified.");
  const { credential, credentialDeviceType, credentialBackedUp } = result.registrationInfo;
  const [saved] = await db
    .insert(webauthnCredentials)
    .values({
      userId: user.id,
      credentialId: credential.id,
      publicKey: b64(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
      name: name.trim().slice(0, 60) || "Passkey",
      deviceType: credentialDeviceType,
      backedUp: credentialBackedUp,
    })
    .returning();
  return saved;
}

// Sign-in: options limited to this user's passkeys; the challenge is stored
// on the sign-in challenge row, so it's bound to that attempt and its IP.
export async function authenticationOptions(user: User, challengeId: string) {
  const creds = await credentialsFor(user.id);
  if (!creds.length) return null;
  const options = await generateAuthenticationOptions({
    rpID: rpId(),
    allowCredentials: creds.map((c) => ({ id: c.credentialId, transports: c.transports })),
    userVerification: "preferred",
  });
  await db.update(loginChallenges).set({ webauthnChallenge: options.challenge }).where(eq(loginChallenges.id, challengeId));
  return options;
}

export async function verifyPasskey(user: User, expectedChallenge: string, response: AuthenticationResponseJSON): Promise<boolean> {
  const cred = await db.query.webauthnCredentials.findFirst({ where: and(eq(webauthnCredentials.userId, user.id), eq(webauthnCredentials.credentialId, response.id)) });
  if (!cred) return false;
  try {
    const result = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: expectedOrigins(),
      expectedRPID: rpId(),
      credential: { id: cred.credentialId, publicKey: unb64(cred.publicKey), counter: cred.counter, transports: cred.transports },
    });
    if (!result.verified) return false;
    await db.update(webauthnCredentials).set({ counter: result.authenticationInfo.newCounter, lastUsedAt: new Date(), backedUp: result.authenticationInfo.credentialBackedUp }).where(eq(webauthnCredentials.id, cred.id));
    return true;
  } catch {
    // A replayed or cloned authenticator (counter went backwards), wrong
    // origin, or a malformed response — all just "not verified".
    return false;
  }
}
