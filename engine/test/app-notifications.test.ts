// Tests for the Looksee Android app's server side: signing in from the app
// (bearer session token), registering phones, the notification stream
// (/api/app/stream WebSocket), the "Notifications" channel (type web_push,
// which reaches phones as well as browsers), and the queue that holds
// notifications for a phone that's offline.
//
// Runs against the real local test database, through the real HTTP routes
// and a real WebSocket connection to a real listening server (port chosen by
// the OS). Each test says what behavior (or attack) it proves. Everything
// created is removed in afterAll.
//
// Requests carry their own X-Forwarded-For address (the engine trusts that
// header from loopback), so the IP block test can't block other test files.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import bcrypt from "bcryptjs";
import { and, eq, inArray } from "drizzle-orm";
import request from "supertest";
import WebSocket from "ws";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { appDevices, appNotifications, ipBlocks, notificationChannels, securityEvents, sessions, users } from "../src/db/schema.js";
import { generateTotpSecret, totpCode } from "../src/lib/totp.js";
import { attachAppStream, hashDeviceToken } from "../src/services/appStream.js";
import { invalidateSecurityCache } from "../src/services/security.js";
import { loginWith2fa } from "./helpers.js";

const run = crypto.randomUUID().slice(0, 8);
const emailA = `test-app-a-${run}@example.com`;
const emailB = `test-app-b-${run}@example.com`;
const IP = "198.51.100.41";
const BLOCKED_IP = "198.51.100.42";
let server: Server;
let wsBase: string;
let bearer: string;
let cookieB: string;
const channelIds: string[] = [];

beforeAll(async () => {
  server = app.listen(0);
  attachAppStream(server, app);
  wsBase = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  for (const email of [emailA, emailB]) await db.insert(users).values({ email, passwordHash: await bcrypt.hash("TestPass123", 10) });
  // User A signs in the way the app does (below, in the first test's helper);
  // user B the way the dashboard does, for the ownership tests.
  bearer = await appLogin(emailA);
  cookieB = await loginWith2fa(emailB, "TestPass123");
});

afterAll(async () => {
  const ids = (await db.select({ id: users.id }).from(users).where(inArray(users.email, [emailA, emailB]))).map((u) => u.id);
  if (ids.length) await db.delete(appDevices).where(inArray(appDevices.userId, ids));
  if (channelIds.length) await db.delete(notificationChannels).where(inArray(notificationChannels.id, channelIds));
  await db.delete(ipBlocks).where(eq(ipBlocks.ip, BLOCKED_IP));
  await db.delete(users).where(inArray(users.email, [emailA, emailB]));
  invalidateSecurityCache();
  await new Promise((resolve) => server.close(resolve));
});

/** Signs in through both steps with client "app", as the Android app does. Out: the session token. */
async function appLogin(email: string) {
  const secret = generateTotpSecret();
  await db.update(users).set({ totpSecret: secret, totpEnabled: true }).where(eq(users.email, email));
  const step1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", IP).send({ email, password: "TestPass123" });
  const step2 = await request(app).post("/api/auth/login/verify").set("X-Forwarded-For", IP).send({ challengeId: step1.body.challengeId, code: totpCode(secret), client: "app" });
  if (step2.status !== 200) throw new Error(`app login failed: ${step2.status}`);
  expect(step2.headers["set-cookie"]).toBeUndefined();
  return step2.body.sessionToken as string;
}

/** Registers a phone for user A. Out: its ID and notification token. */
async function register(name = "Pixel test") {
  const res = await request(app).post("/api/app/devices").set("Authorization", `Bearer ${bearer}`).set("X-Forwarded-For", IP).send({ name, appVersion: "5.8.0", platform: "Android 16" });
  expect(res.status).toBe(201);
  return { id: res.body.device.id as string, token: res.body.token as string };
}

type Msg = { type: string; items?: { id: string; title: string; status: string; checkId: string | null }[] };

/**
 * Opens the stream with the given headers and collects what the server sends.
 * Out: the socket, the messages so far, a helper that waits for the next
 * message of a type, and the HTTP status if the upgrade was refused.
 */
function connect(headers: Record<string, string>) {
  const ws = new WebSocket(`${wsBase}/api/app/stream`, { headers: { "X-Forwarded-For": IP, ...headers } });
  const messages: Msg[] = [];
  const waiters: { type: string; resolve: (m: Msg) => void }[] = [];
  ws.on("message", (data) => {
    const m = JSON.parse(data.toString()) as Msg;
    messages.push(m);
    for (const w of waiters.filter((w) => w.type === m.type)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
  });
  const refused = new Promise<number | null>((resolve) => {
    ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? null));
    ws.on("open", () => resolve(null));
    ws.on("error", () => resolve(-1));
  });
  const next = (type: string, ms = 3000) =>
    new Promise<Msg>((resolve, reject) => {
      const seen = messages.find((m) => m.type === type && !(m as { used?: boolean }).used);
      if (seen) {
        (seen as { used?: boolean }).used = true;
        return resolve(seen);
      }
      waiters.push({ type, resolve });
      setTimeout(() => reject(new Error(`no "${type}" message within ${ms} ms`)), ms);
    });
  const closed = new Promise<number>((resolve) => ws.on("close", (code) => resolve(code)));
  return { ws, messages, next, refused, closed };
}

const auth = (r: request.Test) => r.set("Authorization", `Bearer ${bearer}`).set("X-Forwarded-For", IP);

describe("signing in from the app", () => {
  // The app gets its session in the body, never as a cookie, and the bearer
  // token works on protected routes.
  it("returns a session token that works as a bearer header", async () => {
    const me = await auth(request(app).get("/api/auth/me"));
    expect(me.status).toBe(200);
    expect(me.body.email).toBe(emailA);
    const row = await db.query.sessions.findFirst({ where: eq(sessions.token, bearer) });
    expect(row?.userAgent).toMatch(/^Looksee app/);
  });

  // Two-factor stays mandatory: the password step alone never yields a token.
  it("gives no token for the password step alone", async () => {
    const step1 = await request(app).post("/api/auth/login").set("X-Forwarded-For", IP).send({ email: emailA, password: "TestPass123", client: "app" });
    expect(step1.status).toBe(200);
    expect(step1.body.sessionToken).toBeUndefined();
    expect(step1.body.step).toBe("totp");
  });

  // A made-up bearer token is refused like a missing cookie.
  it("refuses an unknown bearer token", async () => {
    expect((await request(app).get("/api/auth/me").set("Authorization", "Bearer not-a-real-session")).status).toBe(401);
    expect((await request(app).get("/api/app/devices")).status).toBe(401);
  });
});

describe("phones", () => {
  // The token is shown once; the database holds only its hash, and lists
  // never include either.
  it("registers a phone, storing only a hash of its token", async () => {
    const { id, token } = await register();
    expect(token).toMatch(/^lsa_[A-Za-z0-9_-]{43}$/);
    const row = await db.query.appDevices.findFirst({ where: eq(appDevices.id, id) });
    expect(row?.tokenHash).toBe(hashDeviceToken(token));
    expect(JSON.stringify(row)).not.toContain(token);
    const list = await auth(request(app).get("/api/app/devices"));
    expect(list.body.find((d: { id: string }) => d.id === id)).toMatchObject({ name: "Pixel test", appVersion: "5.8.0", connected: false });
    expect(JSON.stringify(list.body)).not.toMatch(/tokenHash|lsa_/);
    const added = await db.query.securityEvents.findFirst({ where: and(eq(securityEvents.kind, "app_device_added"), eq(securityEvents.ip, IP)) });
    expect(added).toBeTruthy();
  });

  // IDOR: another account can't see, rename, test or remove this phone by
  // its ID; it gets the same 404 as for an ID that doesn't exist.
  it("keeps phones private to their own account", async () => {
    const { id } = await register("Private phone");
    const asB = (r: request.Test) => r.set("Cookie", cookieB);
    expect((await asB(request(app).get("/api/app/devices"))).body).toEqual([]);
    expect((await asB(request(app).patch(`/api/app/devices/${id}`)).send({ name: "stolen" })).status).toBe(404);
    expect((await asB(request(app).get(`/api/app/devices/${id}/notifications`))).status).toBe(404);
    expect((await asB(request(app).post(`/api/app/devices/${id}/test`))).status).toBe(404);
    await asB(request(app).delete(`/api/app/devices/${id}`)).expect(204);
    expect(await db.query.appDevices.findFirst({ where: eq(appDevices.id, id) })).toBeTruthy();
    expect((await auth(request(app).patch("/api/app/devices/not-a-uuid")).send({ name: "x" })).status).toBe(404);
  });
});

describe("the notification stream", () => {
  // Only a registered phone's token opens the stream; a wrong one is refused
  // and recorded (the "App token guessing" rule counts these).
  it("refuses a missing or wrong token and records it", async () => {
    expect(await connect({}).refused).toBe(401);
    expect(await connect({ Authorization: "Bearer lsa_wrong" }).refused).toBe(401);
    // A session token isn't a phone token: it can't open the stream either.
    expect(await connect({ Authorization: `Bearer ${bearer}` }).refused).toBe(401);
    const events = await db.select().from(securityEvents).where(and(eq(securityEvents.kind, "bad_app_token"), eq(securityEvents.ip, IP)));
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  // Blocked addresses are refused before the token is even looked at.
  it("refuses a blocked address", async () => {
    const { token } = await register("Blocked phone");
    await db.insert(ipBlocks).values({ ip: BLOCKED_IP, reason: "test" });
    invalidateSecurityCache();
    expect(await connect({ Authorization: `Bearer ${token}`, "X-Forwarded-For": BLOCKED_IP }).refused).toBe(403);
  });

  // The main path: a channel's alert arrives on a connected phone, and an
  // acknowledged notification is marked delivered and never sent again.
  it("delivers a Notifications channel's alert live and marks it delivered on ack", async () => {
    const { id, token } = await register("Live phone");
    const c = connect({ Authorization: `Bearer ${token}` });
    expect(await c.refused).toBeNull();
    const hello = (await c.next("hello")) as Msg & { device: { id: string } };
    expect(hello.device.id).toBe(id);
    const ch = await auth(request(app).post("/api/channels")).send({ name: `notify-${run}`, type: "web_push", config: {} });
    channelIds.push(ch.body.id);
    await auth(request(app).post(`/api/channels/${ch.body.id}/test`)).expect(200);
    const got = await c.next("notify");
    expect(got.items).toHaveLength(1);
    const item = got.items![0];
    expect(item.status).toBe("DOWN");
    c.ws.send(JSON.stringify({ type: "ack", ids: [item.id] }));
    await expect.poll(async () => (await db.query.appNotifications.findFirst({ where: eq(appNotifications.id, item.id) }))?.deliveredAt).toBeTruthy();
    c.ws.close();
    // Reconnecting doesn't send the acknowledged one again.
    const again = connect({ Authorization: `Bearer ${token}` });
    await again.next("hello");
    await new Promise((r) => setTimeout(r, 300));
    expect(again.messages.filter((m) => m.type === "notify")).toHaveLength(0);
    again.ws.close();
  });

  // A phone that was offline gets what it missed when it reconnects, but not
  // notifications older than the 24-hour queue window.
  it("queues notifications for an offline phone, within 24 hours", async () => {
    const { id, token } = await register("Offline phone");
    await db.insert(appNotifications).values([
      { deviceId: id, title: "stale", body: "two days old", createdAt: new Date(Date.now() - 48 * 3_600_000) },
      { deviceId: id, title: "missed", body: "while offline", status: "WARN" },
    ]);
    const c = connect({ Authorization: `Bearer ${token}` });
    const got = await c.next("notify");
    expect(got.items!.map((i) => i.title)).toEqual(["missed"]);
    c.ws.close();
  });

  // A phone can only acknowledge its own notifications: acking another
  // phone's IDs changes nothing.
  it("ignores acknowledgements for another phone's notifications", async () => {
    const a = await register("Phone A");
    const b = await register("Phone B");
    const [row] = await db.insert(appNotifications).values({ deviceId: b.id, title: "for B", body: "x" }).returning();
    const c = connect({ Authorization: `Bearer ${a.token}` });
    await c.next("hello");
    c.ws.send(JSON.stringify({ type: "ack", ids: [row.id, "not-a-uuid", { $ne: null }] }));
    c.ws.send(JSON.stringify({ type: "ping" }));
    await c.next("pong");
    expect((await db.query.appNotifications.findFirst({ where: eq(appNotifications.id, row.id) }))?.deliveredAt).toBeNull();
    c.ws.close();
  });

  // Removing a phone (Security page or signing out) cuts its live connection
  // at once, and its token stops working.
  it("disconnects and refuses a removed phone", async () => {
    const { id, token } = await register("Lost phone");
    const c = connect({ Authorization: `Bearer ${token}` });
    await c.next("hello");
    await auth(request(app).delete(`/api/app/devices/${id}`)).expect(204);
    expect(await c.closed).toBe(4001);
    expect(await connect({ Authorization: `Bearer ${token}` }).refused).toBe(401);
  });

  // Resource exhaustion: one phone token can't hold more than 5 connections;
  // opening a sixth closes the oldest.
  it("caps connections per phone, closing the oldest", async () => {
    const { token } = await register("Busy phone");
    const conns = [];
    for (let i = 0; i < 6; i++) {
      const c = connect({ Authorization: `Bearer ${token}` });
      await c.next("hello");
      conns.push(c);
    }
    expect(await conns[0].closed).toBe(4002);
    expect(conns[5].ws.readyState).toBe(WebSocket.OPEN);
    for (const c of conns) c.ws.close();
  });

  // A phone can't send an oversized message (memory exhaustion): the server
  // closes the connection instead of reading it.
  it("closes a connection that sends more than 64 KB at once", async () => {
    const { token } = await register("Noisy phone");
    const c = connect({ Authorization: `Bearer ${token}` });
    await c.next("hello");
    c.ws.send("x".repeat(70_000));
    expect(await c.closed).toBe(1009);
  });
});

describe("the Notifications channel", () => {
  // The channel needs no settings: whatever is sent as config is not stored
  // as anything but an object, and never returned (channel settings are
  // write-only).
  it("never returns its settings", async () => {
    const res = await auth(request(app).post("/api/channels")).send({ name: `notify2-${run}`, type: "web_push", config: { anything: "x" } });
    channelIds.push(res.body.id);
    expect(res.status).toBe(201);
    expect(res.body.config).toBeUndefined();
  });

  // The old separate "app" type no longer exists.
  it("refuses the removed app channel type", async () => {
    expect((await auth(request(app).post("/api/channels")).send({ name: "x", type: "app", config: {} })).status).toBe(400);
  });

  // "Send test" explains why nothing arrived instead of claiming success,
  // when no browser has push on and no phone is signed in. (This suite's
  // phones are removed first; the check below makes sure no others exist,
  // so a stray phone in the test database fails loudly instead of hiding it.)
  it("reports when nothing would receive it", async () => {
    const ids = (await db.select({ id: users.id }).from(users).where(inArray(users.email, [emailA, emailB]))).map((u) => u.id);
    await db.delete(appDevices).where(inArray(appDevices.userId, ids));
    expect(await db.select().from(appDevices)).toHaveLength(0);
    const res = await auth(request(app).post("/api/channels")).send({ name: `notify3-${run}`, type: "web_push", config: {} });
    channelIds.push(res.body.id);
    const test = await auth(request(app).post(`/api/channels/${res.body.id}/test`));
    expect(test.status).toBe(502);
    expect(test.body.error).toMatch(/Enable push|Android app/);
  });
});
