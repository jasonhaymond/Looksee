// Tests for alert-rule editing and the ways a check recovers without a new
// result of its own: by hand (single and bulk), through its recovery URL,
// together with another check, by a "clear" event, after its auto-recovery
// delay, and with excluded messages ignored — plus excluding results from
// uptime statistics. Runs against the real local
// test database; each test comment says what it proves. Everything created
// here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checkResults, checks, events, notificationChannels, sites, users } from "../src/db/schema.js";
import { probeEventMatch } from "../src/services/probes/internal.js";
import { autoRecoverPushed } from "../src/services/scheduler.js";

const email = `test-recovery-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let channelId: string;
// A unique sender address so event queries only see this file's events.
const sender = `192.0.2.${Math.floor(Math.random() * 200) + 20}`;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `recovery-${crypto.randomUUID()}` }).returning())[0].id;
  channelId = (await db.insert(notificationChannels).values({ name: "recovery test hook", type: "webhook", config: { url: "http://127.0.0.1:9/never" } }).returning())[0].id;
});

afterAll(async () => {
  await db.delete(events).where(eq(events.sourceIp, sender));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(notificationChannels).where(eq(notificationChannels.id, channelId));
  await db.delete(users).where(eq(users.email, email));
});

/**
 * Creates a check directly in the database with a given status. Disabled
 * unless asked otherwise, so a locally running engine's scheduler (sharing
 * the test database) never runs it and changes its status mid-test.
 */
async function makeCheck(values: Partial<typeof checks.$inferInsert> & { name: string; type: (typeof checks.$inferInsert)["type"] }) {
  return (await db.insert(checks).values({ siteId, config: {}, enabled: false, ...values }).returning())[0];
}
const statusOf = async (id: string) => (await db.query.checks.findFirst({ where: eq(checks.id, id) }))!;
/** A moment `min` minutes ago. */
const ago = (min: number) => new Date(Date.now() - min * 60_000);

describe("editing alert rules", () => {
  // Proves an existing rule can be changed after creation — including only
  // its channels, which previously failed — and that a nonsense "results in
  // a row" is clamped instead of stored.
  it("updates every field, channels on their own, and clamps bad numbers", async () => {
    const c = await makeCheck({ name: "rule edit", type: "ping", config: { host: "127.0.0.1" } });
    const created = await request(app).post("/api/alert-rules").set("Cookie", cookie).send({ checkId: c.id, channelIds: [channelId], consecutiveFailures: 2 });
    expect(created.status).toBe(201);
    const id = created.body.id;
    const onlyChannels = await request(app).patch(`/api/alert-rules/${id}`).set("Cookie", cookie).send({ channelIds: [], escalationChannelIds: [channelId] });
    expect(onlyChannels.status).toBe(200);
    const all = await request(app).patch(`/api/alert-rules/${id}`).set("Cookie", cookie).send({ consecutiveFailures: -5, triggerOn: "warn", renotifyMinutes: 30, escalateAfterMinutes: 60 });
    expect(all.body.consecutiveFailures).toBe(1);
    expect(all.body.triggerOn).toBe("warn");
    const list = (await request(app).get(`/api/alert-rules?checkId=${c.id}`).set("Cookie", cookie)).body;
    expect(list[0].channelIds).toEqual([]);
    expect(list[0].escalationChannelIds).toEqual([channelId]);
    expect(list[0].renotifyMinutes).toBe(30);
  });
});

describe("manual resolve", () => {
  // Proves a failing check can be marked recovered by hand, with the note
  // kept, and that the moment is remembered for event checks.
  it("records an up result with the note", async () => {
    const c = await makeCheck({ name: "resolve me", type: "trap_match", lastStatus: "down" });
    const res = await request(app).post(`/api/checks/${c.id}/resolve`).set("Cookie", cookie).send({ note: "replaced the cable" });
    expect(res.status).toBe(200);
    const after = await statusOf(c.id);
    expect(after.lastStatus).toBe("up");
    expect(after.lastMessage).toBe("Manually resolved: replaced the cable");
    expect((after.state as Record<string, unknown>).resolvedAt).toBeTruthy();
  });

  // Proves bulk resolve works on several checks at once.
  it("resolves in bulk", async () => {
    const a = await makeCheck({ name: "bulk a", type: "trap_match", lastStatus: "down" });
    const b = await makeCheck({ name: "bulk b", type: "syslog_match", lastStatus: "warn" });
    const res = await request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ ids: [a.id, b.id], action: "resolve" });
    expect(res.body.affected).toBe(2);
    expect((await statusOf(a.id)).lastStatus).toBe("up");
    expect((await statusOf(b.id)).lastStatus).toBe("up");
  });

  // Proves resolving requires a session — an outsider can't silence alerts.
  it("requires a session", async () => {
    const c = await makeCheck({ name: "no session", type: "trap_match", lastStatus: "down" });
    expect((await request(app).post(`/api/checks/${c.id}/resolve`)).status).toBe(401);
    expect((await statusOf(c.id)).lastStatus).toBe("down");
  });
});

describe("recovery URL", () => {
  // Proves any check can get a recovery URL that recovers it on status=up,
  // and that the URL can't be used to report a failure.
  it("recovers on up and refuses anything else", async () => {
    const c = await makeCheck({ name: "recovery url", type: "trap_match", lastStatus: "down" });
    const withToken = await request(app).post(`/api/checks/${c.id}/regenerate-token`).set("Cookie", cookie);
    const token = String(withToken.body.pushUrl).split("/api/hb/")[1];
    expect(token).toBeTruthy();
    expect((await request(app).get(`/api/hb/${token}?status=down`)).status).toBe(400);
    expect((await statusOf(c.id)).lastStatus).toBe("down");
    const ok = await request(app).get(`/api/hb/${token}?status=up&msg=fixed%20by%20script`);
    expect(ok.status).toBe(200);
    const after = await statusOf(c.id);
    expect(after.lastStatus).toBe("up");
    expect(after.lastMessage).toContain("fixed by script");
    // Turning it off makes the old URL unknown.
    await request(app).post(`/api/checks/${c.id}/remove-token`).set("Cookie", cookie);
    expect((await request(app).get(`/api/hb/${token}?status=up`)).status).toBe(404);
  });
});

describe("recover together with another check", () => {
  // Proves a check set to follow another recovers when that one does, and
  // that a chain of followers recovers in turn.
  it("recovers followers, and their followers", async () => {
    const parent = await makeCheck({ name: "parent ping", type: "ping", lastStatus: "down", config: { host: "127.0.0.1" } });
    const child = await makeCheck({ name: "child trap", type: "trap_match", lastStatus: "down", config: { recoverWithCheckId: parent.id } });
    const grandchild = await makeCheck({ name: "grandchild", type: "syslog_match", lastStatus: "warn", config: { recoverWithCheckId: child.id } });
    const unrelated = await makeCheck({ name: "unrelated", type: "trap_match", lastStatus: "down" });
    await request(app).post(`/api/checks/${parent.id}/resolve`).set("Cookie", cookie).send({});
    expect((await statusOf(child.id)).lastStatus).toBe("up");
    expect((await statusOf(child.id)).lastMessage).toBe('Recovered together with "parent ping"');
    expect((await statusOf(grandchild.id)).lastStatus).toBe("up");
    expect((await statusOf(unrelated.id)).lastStatus).toBe("down");
  });
});

describe("event checks", () => {
  const base = { sourceIp: sender, windowMinutes: 10 };
  const ctx = (state: Record<string, unknown> = {}) => ({ checkId: crypto.randomUUID(), endpointId: null, siteId, intervalSeconds: 60, state });
  /** Stores a syslog event from this file's test sender. */
  const syslog = (message: string, at: Date) => db.insert(events).values({ source: "syslog", siteId, sourceIp: sender, severity: 3, message, receivedAt: at });

  // Proves a matching "clear" event after the failure recovers the check,
  // and a failing event after the clear fails it again.
  it("clears on a matching clear event", async () => {
    await syslog(`port 7 linkDown ${sender}`, ago(3));
    expect((await probeEventMatch("syslog", { ...base, pattern: "linkDown", clearPattern: "linkUp" }, ctx())).status).toBe("down");
    await syslog(`port 7 linkUp ${sender}`, ago(2));
    const cleared = await probeEventMatch("syslog", { ...base, pattern: "linkDown", clearPattern: "linkUp" }, ctx());
    expect(cleared.status).toBe("up");
    expect(cleared.message).toContain("Cleared by a matching message");
    await syslog(`port 7 linkDown again ${sender}`, ago(1));
    expect((await probeEventMatch("syslog", { ...base, pattern: "linkDown", clearPattern: "linkUp" }, ctx())).status).toBe("down");
  });

  // Proves auto-recovery: the check stays failing only this long after the
  // newest matching event, independently of the counting window.
  it("recovers after autoRecoverMinutes with no new match", async () => {
    await syslog(`disk error A ${sender}`, ago(4));
    expect((await probeEventMatch("syslog", { ...base, pattern: "disk error A", autoRecoverMinutes: 5 }, ctx())).status).toBe("down");
    expect((await probeEventMatch("syslog", { ...base, pattern: "disk error A", autoRecoverMinutes: 3 }, ctx())).status).toBe("up");
  });

  // Proves events before a manual resolve are ignored afterwards, so old
  // messages can't make a resolved check fail again.
  it("ignores events from before a resolve", async () => {
    await syslog(`fan failure ${sender}`, ago(2));
    expect((await probeEventMatch("syslog", { ...base, pattern: "fan failure" }, ctx())).status).toBe("down");
    expect((await probeEventMatch("syslog", { ...base, pattern: "fan failure" }, ctx({ resolvedAt: ago(1).toISOString() }))).status).toBe("up");
  });

  // Proves excluded texts are ignored entirely (list or one-per-line text),
  // including when they'd otherwise be the only match.
  it("ignores excluded messages", async () => {
    await syslog(`auth failure from scanner-noise ${sender}`, ago(1));
    expect((await probeEventMatch("syslog", { ...base, pattern: "auth failure" }, ctx())).status).toBe("down");
    expect((await probeEventMatch("syslog", { ...base, pattern: "auth failure", exclude: "something else\nSCANNER-NOISE" }, ctx())).status).toBe("up");
    expect((await probeEventMatch("syslog", { ...base, pattern: "auth failure", exclude: ["scanner-noise"] }, ctx())).status).toBe("up");
  });
});

describe("pushed values auto-recover", () => {
  // Proves a failure pushed into a push_value check recovers on its own once
  // nothing new has arrived for autoRecoverMinutes — and not before.
  it("recovers after the delay", async () => {
    const fresh = await makeCheck({ name: "push fresh", type: "push_value", enabled: true, lastStatus: "down", lastCheckedAt: ago(2), config: { autoRecoverMinutes: 10 } });
    const stale = await makeCheck({ name: "push stale", type: "push_value", enabled: true, lastStatus: "down", lastCheckedAt: ago(15), config: { autoRecoverMinutes: 10 } });
    const noSetting = await makeCheck({ name: "push none", type: "push_value", enabled: true, lastStatus: "down", lastCheckedAt: ago(60) });
    await autoRecoverPushed();
    expect((await statusOf(fresh.id)).lastStatus).toBe("down");
    expect((await statusOf(stale.id)).lastStatus).toBe("up");
    expect((await statusOf(noSetting.id)).lastStatus).toBe("down");
  });
});

describe("excluding results from statistics", () => {
  /** Adds results to a check: one per status, `min` minutes ago each. */
  async function addResults(checkId: string, rows: { status: "up" | "down"; min: number }[]) {
    return db
      .insert(checkResults)
      .values(rows.map((r) => ({ checkId, status: r.status, checkedAt: ago(r.min) })))
      .returning();
  }
  const uptimeOf = async (id: string) => (await request(app).get(`/api/checks/${id}/stats?hours=1`).set("Cookie", cookie)).body;

  // Proves excluding specific results removes them from uptime, keeps them
  // stored, and that "count again" restores them.
  it("excludes chosen results and counts them again", async () => {
    const c = await makeCheck({ name: "exclude ids", type: "ping", config: { host: "127.0.0.1" } });
    const [, bad] = await addResults(c.id, [
      { status: "up", min: 10 },
      { status: "down", min: 8 },
      { status: "up", min: 6 },
    ]);
    expect((await uptimeOf(c.id)).uptimePercent).toBeLessThan(100);
    const res = await request(app).post(`/api/checks/${c.id}/results/exclude`).set("Cookie", cookie).send({ resultIds: [bad.id], reason: "planned power test" });
    expect(res.body.changed).toBe(1);
    const stored = await db.query.checkResults.findFirst({ where: eq(checkResults.id, bad.id) });
    expect(stored?.excluded).toBe(true);
    expect(stored?.excludedReason).toBe("planned power test");
    const after = await uptimeOf(c.id);
    expect(after.uptimePercent).toBe(100);
    await request(app).post(`/api/checks/${c.id}/results/exclude`).set("Cookie", cookie).send({ resultIds: [bad.id], exclude: false });
    const restored = await db.query.checkResults.findFirst({ where: eq(checkResults.id, bad.id) });
    expect(restored?.excluded).toBe(false);
    expect(restored?.excludedReason).toBeNull();
  });

  // Proves a time range excludes only that check's results inside the range.
  it("excludes a time range", async () => {
    const c = await makeCheck({ name: "exclude range", type: "ping", config: { host: "127.0.0.1" } });
    await addResults(c.id, [
      { status: "down", min: 30 },
      { status: "down", min: 20 },
      { status: "up", min: 5 },
    ]);
    const res = await request(app).post(`/api/checks/${c.id}/results/exclude`).set("Cookie", cookie).send({ from: ago(25).toISOString(), to: ago(15).toISOString() });
    expect(res.body.changed).toBe(1);
  });

  // Proves results of another check can't be changed by sending their IDs
  // under this check's URL — without the check filter, one request could
  // hide any check's outages.
  it("only changes this check's results", async () => {
    const mine = await makeCheck({ name: "exclude mine", type: "ping", config: { host: "127.0.0.1" } });
    const other = await makeCheck({ name: "exclude other", type: "ping", config: { host: "127.0.0.1" } });
    const [theirs] = await addResults(other.id, [{ status: "down", min: 3 }]);
    const res = await request(app).post(`/api/checks/${mine.id}/results/exclude`).set("Cookie", cookie).send({ resultIds: [theirs.id] });
    expect(res.body.changed).toBe(0);
    expect((await db.query.checkResults.findFirst({ where: eq(checkResults.id, theirs.id) }))?.excluded).toBe(false);
  });

  // Proves malformed input is refused cleanly (400, not a server error) and
  // that the route requires a session.
  it("refuses bad input and outsiders", async () => {
    const c = await makeCheck({ name: "exclude bad", type: "ping", config: { host: "127.0.0.1" } });
    const url = `/api/checks/${c.id}/results/exclude`;
    expect((await request(app).post(url).set("Cookie", cookie).send({})).status).toBe(400);
    expect((await request(app).post(url).set("Cookie", cookie).send({ resultIds: ["not-a-uuid'; DROP TABLE check_results;--"] })).status).toBe(400);
    expect((await request(app).post(url).set("Cookie", cookie).send({ from: ago(1).toISOString(), to: ago(5).toISOString() })).status).toBe(400);
    expect((await request(app).post(url).send({ resultIds: [crypto.randomUUID()] })).status).toBe(401);
  });
});
