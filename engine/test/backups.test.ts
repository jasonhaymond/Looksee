import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users } from "../src/db/schema.js";

// Unique per run so this suite can run repeatedly against a shared dev
// database without colliding with a leftover row from a previous run.
const email = `test-backups-${crypto.randomUUID()}@example.com`;
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
});

describe("backups", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/backups/settings");
    expect(res.status).toBe(401);
  });

  it("reports unconfigured settings with the passphrase never returned", async () => {
    const res = await request(app).get("/api/backups/settings").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.settings.passphraseSet).toBe(false);
    expect(res.body.settings.passphrase).toBeUndefined();
    expect(typeof res.body.borgAvailable).toBe("boolean");
  });

  it("returns an empty archive list before a repository is configured", async () => {
    const res = await request(app).get("/api/backups/archives").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.archives).toEqual([]);
  });

  it("saves settings and redacts the passphrase on read-back", async () => {
    const patchRes = await request(app)
      .patch("/api/backups/settings")
      .set("Cookie", cookie)
      .send({ repoUrl: "/tmp/test-repo", passphrase: "supersecret", retentionCount: 5 });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.settings.repoUrl).toBe("/tmp/test-repo");
    expect(patchRes.body.settings.passphraseSet).toBe(true);
    expect(patchRes.body.settings.passphrase).toBeUndefined();

    const getRes = await request(app).get("/api/backups/settings").set("Cookie", cookie);
    expect(getRes.body.settings.passphraseSet).toBe(true);

    // Clean up: restore the singleton settings row to unconfigured so other
    // runs/tests see a clean slate.
    await request(app)
      .patch("/api/backups/settings")
      .set("Cookie", cookie)
      .send({ repoUrl: "", passphrase: "", schedule: null, retentionCount: null });
  });

  it("rejects a restore whose confirmation text doesn't match the archive name", async () => {
    const res = await request(app)
      .post("/api/backups/restore")
      .set("Cookie", cookie)
      .send({ archiveName: "some-archive", confirmArchiveName: "wrong-name", restoreDb: true });
    expect(res.status).toBe(400);
  });
});
