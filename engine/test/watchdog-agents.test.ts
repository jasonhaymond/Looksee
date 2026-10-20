// Tests for watchdog agents (endpoints whose agent alerts when it can't reach
// Looksee): settings validation, that only a watchdog endpoint's own agent
// receives the delivery secrets, test requests, and the status the agent
// reports back. Runs against the real local test database; each test comment
// says what it proves. Everything created here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { endpoints, notificationChannels, sites, users } from "../src/db/schema.js";

const email = `test-wd-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let watchId: string;
let otherId: string;
let watchAuth: Record<string, string>;
let otherAuth: Record<string, string>;
let slackId: string;
let emailChannelId: string;
const channelIds: string[] = [];
// A recognisable fake secret, to prove where it does and doesn't appear.
const secretUrl = `https://hooks.slack.example/services/${crypto.randomUUID()}`;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `wd-${crypto.randomUUID()}` }).returning())[0].id;
  watchId = (await db.insert(endpoints).values({ siteId, name: "watch-01", agentVersion: "5.0.0" }).returning())[0].id;
  otherId = (await db.insert(endpoints).values({ siteId, name: "plain-01", agentVersion: "5.0.0" }).returning())[0].id;
  watchAuth = { Authorization: `Bearer ${(await request(app).post(`/api/endpoints/${watchId}/agent-key`).set("Cookie", cookie)).body.agentApiKey}` };
  otherAuth = { Authorization: `Bearer ${(await request(app).post(`/api/endpoints/${otherId}/agent-key`).set("Cookie", cookie)).body.agentApiKey}` };
  slackId = (await db.insert(notificationChannels).values({ name: "wd slack", type: "slack", config: { webhookUrl: secretUrl } }).returning())[0].id;
  emailChannelId = (await db.insert(notificationChannels).values({ name: "wd email", type: "email", config: { to: "a@example.com" } }).returning())[0].id;
  channelIds.push(slackId, emailChannelId);
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(notificationChannels).where(inArray(notificationChannels.id, channelIds));
  await db.delete(users).where(eq(users.email, email));
});

const put = (id: string, body: Record<string, unknown>) => request(app).put(`/api/endpoints/${id}/watchdog`).set("Cookie", cookie).send(body);

describe("watchdog settings", () => {
  // Proves nobody can make an endpoint a watchdog (and so receive delivery
  // secrets) or trigger test messages without signing in.
  it("requires a session", async () => {
    expect((await request(app).put(`/api/endpoints/${watchId}/watchdog`).send({ enabled: true, channelIds: [slackId] })).status).toBe(401);
    expect((await request(app).post(`/api/endpoints/${watchId}/watchdog/test`)).status).toBe(401);
  });

  // Proves malformed settings are refused: bad addresses, IDs that aren't
  // IDs or don't exist, channel types the agent can't deliver, and an
  // enabled watchdog with nowhere to send.
  it("validates settings", async () => {
    expect((await put(watchId, { enabled: true, emailTo: "not an email" })).status).toBe(400);
    expect((await put(watchId, { enabled: true, channelIds: ["1; DROP TABLE endpoints"] })).status).toBe(400);
    expect((await put(watchId, { enabled: true, channelIds: [crypto.randomUUID()] })).status).toBe(400);
    expect((await put(watchId, { enabled: true, channelIds: [emailChannelId] })).status).toBe(400);
    expect((await put(watchId, { enabled: true })).status).toBe(400);
    const ok = await put(watchId, { enabled: true, afterMinutes: 99999, emailTo: "ops@example.com, oncall@example.com", channelIds: [slackId] });
    expect(ok.status).toBe(200);
    expect(ok.body.watchdog).toEqual({ enabled: true, afterMinutes: 1440, emailTo: ["ops@example.com", "oncall@example.com"], channelIds: [slackId] });
    // The dashboard sees channel IDs, never the channel's secret URL.
    expect(JSON.stringify(ok.body)).not.toContain(secretUrl);
  });
});

describe("what agents receive", () => {
  // Proves the watchdog endpoint's own agent gets its spec with the chat
  // channel's delivery settings, and every other agent gets nothing.
  it("hands the spec only to the watchdog's agent", async () => {
    await put(watchId, { enabled: true, afterMinutes: 10, channelIds: [slackId] });
    const mine = (await request(app).get("/api/agent/config").set(watchAuth)).body;
    expect(mine.watchdog.afterSeconds).toBe(600);
    expect(mine.watchdog.endpointName).toBe("watch-01");
    expect(mine.watchdog.chats).toEqual([{ type: "slack", name: "wd slack", config: { webhookUrl: secretUrl } }]);
    const theirs = (await request(app).get("/api/agent/config").set(otherAuth)).body;
    expect(theirs.watchdog).toBeNull();
    expect(JSON.stringify(theirs)).not.toContain(secretUrl);
  });

  // Proves turning the watchdog off stops sending the spec, and a disabled
  // channel is left out.
  it("stops when turned off", async () => {
    await db.update(notificationChannels).set({ enabled: false }).where(eq(notificationChannels.id, slackId));
    expect((await request(app).get("/api/agent/config").set(watchAuth)).body.watchdog.chats).toEqual([]);
    await db.update(notificationChannels).set({ enabled: true }).where(eq(notificationChannels.id, slackId));
    await put(watchId, { enabled: false });
    expect((await request(app).get("/api/agent/config").set(watchAuth)).body.watchdog).toBeNull();
  });

  // Proves "Send test" reaches the agent as a new test ID, and only for a
  // watchdog endpoint.
  it("passes test requests on", async () => {
    expect((await request(app).post(`/api/endpoints/${otherId}/watchdog/test`).set("Cookie", cookie)).status).toBe(400);
    await put(watchId, { enabled: true, channelIds: [slackId] });
    expect((await request(app).post(`/api/endpoints/${watchId}/watchdog/test`).set("Cookie", cookie)).status).toBe(200);
    const spec = (await request(app).get("/api/agent/config").set(watchAuth)).body.watchdog;
    expect(spec.testId).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // Proves the status an agent reports is stored with only the known keys,
  // so an agent can't write arbitrary data to its endpoint.
  it("stores the agent's status, cleaned", async () => {
    await request(app)
      .post("/api/agent/report")
      .set(watchAuth)
      .send({ version: "5.0.0", watchdogStatus: { alerting: true, lastAlertAt: "2026-10-20T12:00:00Z", lastError: "x".repeat(2000), injected: { a: 1 } } })
      .expect(200);
    const row = await db.query.endpoints.findFirst({ where: eq(endpoints.id, watchId) });
    const status = row!.watchdogStatus as Record<string, unknown>;
    expect(status.alerting).toBe(true);
    expect(status.lastAlertAt).toBe("2026-10-20T12:00:00Z");
    expect(String(status.lastError).length).toBe(500);
    expect(status.injected).toBeUndefined();
  });
});
