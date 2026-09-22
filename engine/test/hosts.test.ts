import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, sites } from "../src/db/schema.js";

const email = `test-hosts-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  cookie = loginRes.headers["set-cookie"]![0];

  const [site] = await db.insert(sites).values({ name: `test-hosts-site-${crypto.randomUUID()}` }).returning();
  siteId = site.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(eq(sites.id, siteId));
});

describe("hosts agent-key", () => {
  it("returns both a unix and a windows install command", async () => {
    const createRes = await request(app).post("/api/hosts").set("Cookie", cookie).send({ siteId, name: "key-test-host" });
    const hostId = createRes.body.id;

    const res = await request(app).post(`/api/hosts/${hostId}/agent-key`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.agentApiKey).toBeTruthy();
    expect(res.body.installCommands.unix).toContain("curl -fsSL");
    expect(res.body.installCommands.unix).toContain(res.body.agentApiKey);
    expect(res.body.installCommands.unix).toContain("sudo bash -s --");
    expect(res.body.installCommands.windows).toContain("LOOKSEE_AGENT_KEY");
    expect(res.body.installCommands.windows).toContain(res.body.agentApiKey);
    expect(res.body.installCommands.windows).toContain("iex");

    await request(app).delete(`/api/hosts/${hostId}`).set("Cookie", cookie);
  });
});

describe("push-to-update", () => {
  it("flags updateAvailable one-shot: true on the first poll after a request, false after", async () => {
    const createRes = await request(app).post("/api/hosts").set("Cookie", cookie).send({ siteId, name: "update-test-host" });
    const hostId = createRes.body.id;
    const keyRes = await request(app).post(`/api/hosts/${hostId}/agent-key`).set("Cookie", cookie);
    const agentAuth = { Authorization: `Bearer ${keyRes.body.agentApiKey}` };

    const beforeRequest = await request(app).get("/api/agent/config").set(agentAuth);
    expect(beforeRequest.body.updateAvailable).toBe(false);

    const requestRes = await request(app).post(`/api/hosts/${hostId}/request-update`).set("Cookie", cookie);
    expect(requestRes.status).toBe(200);

    const firstPoll = await request(app).get("/api/agent/config").set(agentAuth);
    expect(firstPoll.body.updateAvailable).toBe(true);

    const secondPoll = await request(app).get("/api/agent/config").set(agentAuth);
    expect(secondPoll.body.updateAvailable).toBe(false);

    await request(app).delete(`/api/hosts/${hostId}`).set("Cookie", cookie);
  });

  it("stores the agent's reported version and surfaces it on the host", async () => {
    const createRes = await request(app).post("/api/hosts").set("Cookie", cookie).send({ siteId, name: "version-test-host" });
    const hostId = createRes.body.id;
    const keyRes = await request(app).post(`/api/hosts/${hostId}/agent-key`).set("Cookie", cookie);

    await request(app)
      .post("/api/agent/report")
      .set("Authorization", `Bearer ${keyRes.body.agentApiKey}`)
      .send({ metrics: {}, version: "1.2.3" });

    const listRes = await request(app).get("/api/hosts").set("Cookie", cookie);
    const host = listRes.body.find((h: { id: string }) => h.id === hostId);
    expect(host.agentVersion).toBe("1.2.3");

    await request(app).delete(`/api/hosts/${hostId}`).set("Cookie", cookie);
  });
});
