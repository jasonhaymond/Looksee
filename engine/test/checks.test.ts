import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { users, sites, endpoints } from "../src/db/schema.js";

const email = `test-checks-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let endpointId: string;

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  cookie = await loginWith2fa(email, password);

  const [endpoint] = await db.insert(sites).values({ name: `test-checks-endpoint-${crypto.randomUUID()}` }).returning();
  siteId = endpoint.id;
  const [host] = await db.insert(endpoints).values({ siteId, name: "test-host" }).returning();
  endpointId = host.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(eq(sites.id, siteId));
});

describe("checks", () => {
  it("rejects creating an agent_service check with no endpointId", async () => {
    const res = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, name: "svc", type: "agent_service", config: { serviceName: "nginx" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/endpointId/);
  });

  it("creates an agent_service check with a endpointId, then updates its endpointId via PATCH", async () => {
    const createRes = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, endpointId, name: "svc", type: "agent_service", config: { serviceName: "nginx" } });
    expect(createRes.status).toBe(201);
    expect(createRes.body.endpointId).toBe(endpointId);
    const checkId = createRes.body.id;

    const [otherEndpoint] = await db.insert(endpoints).values({ siteId, name: "other-host" }).returning();
    const patchRes = await request(app).patch(`/api/checks/${checkId}`).set("Cookie", cookie).send({ endpointId: otherEndpoint.id });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.endpointId).toBe(otherEndpoint.id);

    // Clearing endpointId on an agent_service check is rejected the same way
    // creating one with no endpointId is — it would silently stop being polled.
    const clearRes = await request(app).patch(`/api/checks/${checkId}`).set("Cookie", cookie).send({ endpointId: null });
    expect(clearRes.status).toBe(400);

    await request(app).delete(`/api/checks/${checkId}`).set("Cookie", cookie);
    await db.delete(endpoints).where(eq(endpoints.id, otherEndpoint.id));
  });

  it("allows a non-agent_service check to have no endpointId", async () => {
    const res = await request(app)
      .post("/api/checks")
      .set("Cookie", cookie)
      .send({ siteId, name: "ping-check", type: "ping", config: { host: "1.1.1.1" } });
    expect(res.status).toBe(201);
    expect(res.body.endpointId).toBeNull();
    await request(app).delete(`/api/checks/${res.body.id}`).set("Cookie", cookie);
  });
});
