// Tests the warning shown when an agent isn't running as a service: the wording rules
// (dashboard/app/lib/agentRun.ts, tested here because the engine holds the project's
// test runner) and that what an agent reports reaches the endpoint page through the
// real HTTP routes. Runs against the real local test database. Everything created is
// removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import request from "supertest";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { endpoints, sites, users } from "../src/db/schema.js";
import { agentRunNotice } from "../../dashboard/app/lib/agentRun.js";

const email = `test-agentrun-${crypto.randomUUID()}@example.com`;
let cookie: string;
let siteId: string;
let endpointId: string;
let agentKey: string;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash("TestPass123", 10) });
  cookie = await loginWith2fa(email, "TestPass123");
  siteId = (await db.insert(sites).values({ name: `agentrun-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "agentrun-host" }).returning())[0].id;
  agentKey = (await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie)).body.agentApiKey;
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

describe("agentRunNotice", () => {
  // A normal install stays quiet. A Linux service without root is how the installer
  // sets it up on purpose, so it must not read as a problem.
  it("says nothing for a service", () => {
    expect(agentRunNotice({ service: true, elevated: true }, "windows")).toBeNull();
    expect(agentRunNotice({ service: true, elevated: false }, "linux")).toBeNull();
  });

  // An older agent doesn't report this, and must not be told off for it.
  it("says nothing when the agent hasn't said", () => {
    expect(agentRunNotice(undefined, "windows")).toBeNull();
    expect(agentRunNotice(null, null)).toBeNull();
  });

  // Windows without rights is the case that loses readings, so it says so.
  it("warns about missing rights on Windows", () => {
    const notice = agentRunNotice({ service: false, elevated: false }, "Microsoft Windows 11 Pro");
    expect(notice).toContain("isn't running as a service");
    expect(notice).toContain("no administrator rights");
  });

  // Elsewhere, or with rights, only the "stops when closed" part applies.
  it("only mentions rights where they matter", () => {
    for (const notice of [agentRunNotice({ service: false, elevated: true }, "windows"), agentRunNotice({ service: false, elevated: false }, "ubuntu")]) {
      expect(notice).toContain("isn't running as a service");
      expect(notice).not.toContain("administrator");
    }
  });
});

describe("agent reports", () => {
  // Proves the agent's answer reaches the endpoint page through the real routes.
  it("carries how the agent runs through to the endpoint page", async () => {
    const res = await request(app).post("/api/agent/report").set("Authorization", `Bearer ${agentKey}`).send({ metrics: { cpuPercent: 1, memPercent: 1, diskPercent: 1, extended: { agentRun: { service: false, elevated: false } } } });
    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/endpoints/${endpointId}`).set("Cookie", cookie);
    expect(detail.body.lastSnapshot.agentRun).toEqual({ service: false, elevated: false });
  });
});
