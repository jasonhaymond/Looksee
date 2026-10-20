import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { users, sites } from "../src/db/schema.js";

const email = `test-endpoints-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  cookie = await loginWith2fa(email, password);

  const [endpoint] = await db.insert(sites).values({ name: `test-endpoints-endpoint-${crypto.randomUUID()}` }).returning();
  siteId = endpoint.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(eq(sites.id, siteId));
});

describe("endpoints agent-key", () => {
  it("returns both a unix and a windows install command", async () => {
    const createRes = await request(app).post("/api/endpoints").set("Cookie", cookie).send({ siteId, name: "key-test-host" });
    const endpointId = createRes.body.id;

    const res = await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.agentApiKey).toBeTruthy();
    expect(res.body.installCommands.unix).toContain("curl -fsSL");
    expect(res.body.installCommands.unix).toContain(res.body.agentApiKey);
    expect(res.body.installCommands.unix).toContain("sudo bash -s --");
    expect(res.body.installCommands.windows).toContain("LOOKSEE_AGENT_KEY");
    expect(res.body.installCommands.windows).toContain(res.body.agentApiKey);
    expect(res.body.installCommands.windows).toContain("iex");

    await request(app).delete(`/api/endpoints/${endpointId}`).set("Cookie", cookie);
  });
});

describe("push-to-update", () => {
  it("flags updateAvailable one-shot: true on the first poll after a request, false after", async () => {
    const createRes = await request(app).post("/api/endpoints").set("Cookie", cookie).send({ siteId, name: "update-test-host" });
    const endpointId = createRes.body.id;
    const keyRes = await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie);
    const agentAuth = { Authorization: `Bearer ${keyRes.body.agentApiKey}` };

    const beforeRequest = await request(app).get("/api/agent/config").set(agentAuth);
    expect(beforeRequest.body.updateAvailable).toBe(false);

    const requestRes = await request(app).post(`/api/endpoints/${endpointId}/request-update`).set("Cookie", cookie);
    expect(requestRes.status).toBe(200);

    const firstPoll = await request(app).get("/api/agent/config").set(agentAuth);
    expect(firstPoll.body.updateAvailable).toBe(true);

    const secondPoll = await request(app).get("/api/agent/config").set(agentAuth);
    expect(secondPoll.body.updateAvailable).toBe(false);

    await request(app).delete(`/api/endpoints/${endpointId}`).set("Cookie", cookie);
  });

  it("stores the agent's reported version and surfaces it on the host", async () => {
    const createRes = await request(app).post("/api/endpoints").set("Cookie", cookie).send({ siteId, name: "version-test-host" });
    const endpointId = createRes.body.id;
    const keyRes = await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie);

    await request(app)
      .post("/api/agent/report")
      .set("Authorization", `Bearer ${keyRes.body.agentApiKey}`)
      .send({ metrics: {}, version: "1.2.3" });

    const listRes = await request(app).get("/api/endpoints").set("Cookie", cookie);
    const host = listRes.body.find((h: { id: string }) => h.id === endpointId);
    expect(host.agentVersion).toBe("1.2.3");

    await request(app).delete(`/api/endpoints/${endpointId}`).set("Cookie", cookie);
  });
});

describe("host metrics history", () => {
  it("returns reported metrics newest-first, for the dashboard's host-metrics widget", async () => {
    const createRes = await request(app).post("/api/endpoints").set("Cookie", cookie).send({ siteId, name: "metrics-test-host" });
    const endpointId = createRes.body.id;
    const keyRes = await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie);
    const agentAuth = { Authorization: `Bearer ${keyRes.body.agentApiKey}` };

    await request(app).post("/api/agent/report").set(agentAuth).send({ metrics: { cpuPercent: 10, memPercent: 20, diskPercent: 30 } });
    await new Promise((resolve) => setTimeout(resolve, 10));
    await request(app).post("/api/agent/report").set(agentAuth).send({ metrics: { cpuPercent: 15, memPercent: 25, diskPercent: 35 } });

    const res = await request(app).get(`/api/endpoints/${endpointId}/metrics`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(2);
    // Newest first: the second report (cpuPercent 15) should come before the first (10).
    expect(res.body[0].cpuPercent).toBe(15);
    expect(res.body[1].cpuPercent).toBe(10);

    await request(app).delete(`/api/endpoints/${endpointId}`).set("Cookie", cookie);
  });
});
