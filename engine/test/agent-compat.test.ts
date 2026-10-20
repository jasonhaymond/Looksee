// Agent protocol compatibility: agents and site collectors already deployed
// (4.x) must keep working against a 5.0 engine without being updated. This
// test sends exactly what a 4.3 agent sends and checks the answers contain
// everything a 4.3 agent reads, with the same names. Runs against the real
// local test database; everything created here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, sites, users } from "../src/db/schema.js";

const email = `test-compat-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let endpointId: string;
let agentAuth: Record<string, string>;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `compat-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "old-agent", agentVersion: "4.3.0" }).returning())[0].id;
  agentAuth = { Authorization: `Bearer ${(await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie)).body.agentApiKey}` };
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

describe("4.x agents against a 5.0 engine", () => {
  // Proves GET /api/agent/config still answers with the 4.x field names
  // (checks[].id/type/config/intervalSeconds, updateAvailable, collector) —
  // new 5.0 fields are only additions an old agent ignores — and withholds
  // check types the old agent doesn't know instead of sending them.
  it("serves config an old agent understands", async () => {
    const svc = (await db.insert(checks).values({ siteId, endpointId, name: "sshd", type: "agent_service", config: { serviceName: "sshd" } }).returning())[0];
    const res = await request(app).get("/api/agent/config").set(agentAuth);
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(expect.arrayContaining(["checks", "updateAvailable", "collector"]));
    const sent = res.body.checks.find((c: { id: string }) => c.id === svc.id);
    expect(Object.keys(sent).sort()).toEqual(["config", "id", "intervalSeconds", "type"]);
    expect(sent.config).toEqual({ serviceName: "sshd" });
    expect(res.body.updateAvailable).toBe(false);
  });

  // Proves a 4.3-shaped report (no software report, no watchdog status,
  // results plus the legacy services[] array) is accepted and recorded.
  it("accepts an old agent's report", async () => {
    const svc = (await db.insert(checks).values({ siteId, endpointId, name: "nginx", type: "agent_service", config: { serviceName: "nginx" } }).returning())[0];
    const cpu = (await db.insert(checks).values({ siteId, endpointId, name: "cpu", type: "host_cpu", config: { warnPercent: 80 } }).returning())[0];
    const res = await request(app)
      .post("/api/agent/report")
      .set(agentAuth)
      .send({
        version: "4.3.0",
        metrics: { cpuPercent: 91, memPercent: 40, diskPercent: 50, netRxBytes: 1, netTxBytes: 2, extended: { cpu: { percent: 91 }, disks: [{ mount: "/", total: 100, used: 50, free: 50, percent: 50 }] } },
        services: [{ checkId: svc.id, running: true, message: "active" }],
        availableServices: ["nginx", "sshd"],
        inventory: { os: "Ubuntu 24.04" },
      });
    expect(res.status).toBe(200);
    const row = await db.query.checks.findFirst({ where: eq(checks.id, svc.id) });
    expect(row?.lastStatus).toBe("up");
    expect((await db.query.checks.findFirst({ where: eq(checks.id, cpu.id) }))?.lastStatus).toBe("warn");
    const ep = await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) });
    expect(ep?.software).toBeNull();
    expect(ep?.availableServices).toEqual(["nginx", "sshd"]);
  });

  // Proves 5.0-only check types are withheld from a 4.x agent with an
  // explanation, rather than sent and reported as failures.
  it("withholds checks an old agent can't run", async () => {
    const pkgs = (await db.insert(checks).values({ siteId, endpointId, name: "updates", type: "host_packages", config: {} }).returning())[0];
    await request(app).post("/api/agent/report").set(agentAuth).send({ version: "4.3.0", metrics: { cpuPercent: 5 } });
    const row = await db.query.checks.findFirst({ where: eq(checks.id, pkgs.id) });
    expect(row?.lastStatus).toBe("unknown");
    expect(row?.lastMessage).toMatch(/agent 5\.0/);
  });
});
