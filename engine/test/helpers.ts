import request from "supertest";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";
import { generateTotpSecret, totpCode } from "../src/lib/totp.js";

// Two-factor is mandatory, so a test user gets an authenticator secret and
// signs in through both steps, the same way the dashboard does.
export async function loginWith2fa(email: string, password: string): Promise<string> {
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecret: secret, totpEnabled: true }).where(eq(users.email, email));
  const step1 = await request(app).post("/api/auth/login").send({ email, password });
  if (step1.status !== 200) throw new Error(`login step 1 failed: ${step1.status} ${JSON.stringify(step1.body)}`);
  const step2 = await request(app).post("/api/auth/login/verify").send({ challengeId: step1.body.challengeId, code: totpCode(secret) });
  if (step2.status !== 200) throw new Error(`login step 2 failed: ${step2.status} ${JSON.stringify(step2.body)}`);
  return step2.headers["set-cookie"]![0];
}
