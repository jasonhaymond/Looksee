import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, endpoints, hosts } from "../src/db/schema.js";

const email = `test-checks-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let endpointId: string;
let hostId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  cookie = loginRes.headers["set-cookie"]![0];

  const [endpoint] = await db.insert(endpoints).values({ name: `test-checks-endpoint-${crypto.randomUUID()}` }).returning();
  endpointId = endpoint.id;
  const [host] = await db.insert(hosts).values({ endpointId, name: "test-host" }).returning();
  hostId = host.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(endpoints).where(eq(endpoints.id, endpointId));
});

describe("checks", () => {
  it("rejects creating an agent_service check with no hostId", async () => {
    const res = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ endpointId, name: "svc", type: "agent_service", config: { serviceName: "nginx" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/hostId/);
  });

  it("creates an agent_service check with a hostId, then updates its hostId via PATCH", async () => {
    const createRes = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ endpointId, hostId, name: "svc", type: "agent_service", config: { serviceName: "nginx" } });
    expect(createRes.status).toBe(201);
    expect(createRes.body.hostId).toBe(hostId);
    const checkId = createRes.body.id;

    const [otherHost] = await db.insert(hosts).values({ endpointId, name: "other-host" }).returning();
    const patchRes = await request(app).patch(`/api/checks/${checkId}`).set("Cookie", cookie).send({ hostId: otherHost.id });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.hostId).toBe(otherHost.id);

    // Clearing hostId on an agent_service check is rejected the same way
    // creating one with no hostId is — it would silently stop being polled.
    const clearRes = await request(app).patch(`/api/checks/${checkId}`).set("Cookie", cookie).send({ hostId: null });
    expect(clearRes.status).toBe(400);

    await request(app).delete(`/api/checks/${checkId}`).set("Cookie", cookie);
    await db.delete(hosts).where(eq(hosts.id, otherHost.id));
  });

  it("allows a non-agent_service check to have no hostId", async () => {
    const res = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ endpointId, name: "ping-check", type: "ping", config: { host: "1.1.1.1" } });
    expect(res.status).toBe(201);
    expect(res.body.hostId).toBeNull();
    await request(app).delete(`/api/checks/${res.body.id}`).set("Cookie", cookie);
  });
});
