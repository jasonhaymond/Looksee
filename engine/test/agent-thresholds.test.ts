import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, sites, hosts } from "../src/db/schema.js";

const email = `test-thresholds-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let hostId: string;
let agentAuth: { Authorization: string };

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  cookie = loginRes.headers["set-cookie"]![0];

  const [site] = await db.insert(sites).values({ name: `test-thresholds-site-${crypto.randomUUID()}` }).returning();
  siteId = site.id;
  const [host] = await db.insert(hosts).values({ siteId, name: "test-thresholds-host" }).returning();
  hostId = host.id;
  const keyRes = await request(app).post(`/api/hosts/${hostId}/agent-key`).set("Cookie", cookie);
  agentAuth = { Authorization: `Bearer ${keyRes.body.agentApiKey}` };
});

afterAll(async () => {
  await db.delete(hosts).where(eq(hosts.id, hostId));
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(eq(sites.id, siteId));
});

async function latestResult(checkId: string) {
  const res = await request(app).get(`/api/checks/${checkId}/results`).set("Cookie", cookie);
  return res.body[0];
}

describe("host_cpu/host_memory/host_disk threshold evaluation on report arrival", () => {
  it("reports up when the metric is below both thresholds", async () => {
    const createRes = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, hostId, name: "cpu-ok", type: "host_cpu", config: { warnPercent: 80, criticalPercent: 95 } });
    const checkId = createRes.body.id;

    await request(app).post("/api/agent/report").set(agentAuth).send({ metrics: { cpuPercent: 10 } });

    const result = await latestResult(checkId);
    expect(result.status).toBe("up");

    await request(app).delete(`/api/checks/${checkId}`).set("Cookie", cookie);
  });

  it("reports warn when the metric crosses warnPercent but not criticalPercent", async () => {
    const createRes = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, hostId, name: "mem-warn", type: "host_memory", config: { warnPercent: 80, criticalPercent: 95 } });
    const checkId = createRes.body.id;

    await request(app).post("/api/agent/report").set(agentAuth).send({ metrics: { memPercent: 85 } });

    const result = await latestResult(checkId);
    expect(result.status).toBe("warn");
    expect(result.message).toContain("85");

    await request(app).delete(`/api/checks/${checkId}`).set("Cookie", cookie);
  });

  it("reports down when the metric crosses criticalPercent", async () => {
    const createRes = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, hostId, name: "disk-critical", type: "host_disk", config: { warnPercent: 80, criticalPercent: 95 } });
    const checkId = createRes.body.id;

    await request(app).post("/api/agent/report").set(agentAuth).send({ metrics: { diskPercent: 99 } });

    const result = await latestResult(checkId);
    expect(result.status).toBe("down");

    await request(app).delete(`/api/checks/${checkId}`).set("Cookie", cookie);
  });

  it("doesn't cross-evaluate a different metric type (host_cpu check ignores memPercent)", async () => {
    const createRes = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, hostId, name: "cpu-cross-check", type: "host_cpu", config: { criticalPercent: 10 } });
    const checkId = createRes.body.id;

    // memPercent alone would trip a criticalPercent:10 threshold if the type mapping were wrong.
    await request(app).post("/api/agent/report").set(agentAuth).send({ metrics: { memPercent: 99 } });

    const res = await request(app).get(`/api/checks/${checkId}/results`).set("Cookie", cookie);
    expect(res.body.length).toBe(0);

    await request(app).delete(`/api/checks/${checkId}`).set("Cookie", cookie);
  });
});
