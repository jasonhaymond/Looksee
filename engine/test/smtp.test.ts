import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, smtpSettings } from "../src/db/schema.js";

const email = `test-smtp-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  cookie = loginRes.headers["set-cookie"]![0];
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(smtpSettings).where(eq(smtpSettings.id, 1));
});

describe("smtp settings", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/smtp/settings");
    expect(res.status).toBe(401);
  });

  it("never returns the password, only whether one is set", async () => {
    const patchRes = await request(app)
      .patch("/api/smtp/settings")
      .set("Cookie", cookie)
      .send({ host: "smtp.example.com", port: 587, user: "alerts@example.com", password: "s3cret", from: "Looksee <alerts@example.com>" });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.settings.host).toBe("smtp.example.com");
    expect(patchRes.body.settings.passwordSet).toBe(true);
    expect(patchRes.body.settings.password).toBeUndefined();

    const getRes = await request(app).get("/api/smtp/settings").set("Cookie", cookie);
    expect(getRes.body.settings.passwordSet).toBe(true);
    expect(getRes.body.settings.password).toBeUndefined();
  });

  it("an empty password on PATCH leaves the existing one in place rather than clearing it", async () => {
    const res = await request(app).patch("/api/smtp/settings").set("Cookie", cookie).send({ host: "smtp2.example.com" });
    expect(res.status).toBe(200);
    expect(res.body.settings.passwordSet).toBe(true);
  });

  it("rejects a non-integer port", async () => {
    const res = await request(app).patch("/api/smtp/settings").set("Cookie", cookie).send({ port: "not-a-number" });
    expect(res.status).toBe(400);
  });
});
