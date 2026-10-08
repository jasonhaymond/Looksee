import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, desc } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, endpoints, hosts, checks, checkResults, alertEvents, hostMetrics, notificationChannels } from "../src/db/schema.js";
import { processOpenAlerts } from "../src/services/alerting.js";
import { windowIsActive } from "../src/services/maintenance.js";
import { runOneCheck } from "../src/services/scheduler.js";
import { forecastDaysToFull } from "../src/services/probes/internal.js";
import { expandCidr } from "../src/services/discovery.js";
import { MASK } from "../src/lib/secrets.js";

const email = `test-platform-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let endpointId: string;
let otherEndpointId: string;
let hostId: string;
let agentAuth: { Authorization: string };
let webhookChannelId: string;
let escalationChannelId: string;
const received: { path: string; body: string }[] = [];
let hookServer: http.Server;

beforeAll(async () => {
  hookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url!, body });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
  const hookBase = `http://127.0.0.1:${(hookServer.address() as net.AddressInfo).port}`;

  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = (await request(app).post("/api/auth/login").send({ email, password })).headers["set-cookie"]![0];
  endpointId = (await db.insert(endpoints).values({ name: `platform-${crypto.randomUUID()}` }).returning())[0].id;
  otherEndpointId = (await db.insert(endpoints).values({ name: `platform-other-${crypto.randomUUID()}` }).returning())[0].id;
  hostId = (await db.insert(hosts).values({ endpointId, name: "platform-host" }).returning())[0].id;
  const key = await request(app).post(`/api/hosts/${hostId}/agent-key`).set("Cookie", cookie);
  agentAuth = { Authorization: `Bearer ${key.body.agentApiKey}` };
  webhookChannelId = (await db.insert(notificationChannels).values({ name: "test hook", type: "webhook", config: { url: `${hookBase}/primary` } }).returning())[0].id;
  escalationChannelId = (await db.insert(notificationChannels).values({ name: "test escalation", type: "webhook", config: { url: `${hookBase}/escalation` } }).returning())[0].id;
});

afterAll(async () => {
  await db.delete(endpoints).where(eq(endpoints.id, endpointId));
  await db.delete(endpoints).where(eq(endpoints.id, otherEndpointId));
  await db.delete(notificationChannels).where(eq(notificationChannels.id, webhookChannelId));
  await db.delete(notificationChannels).where(eq(notificationChannels.id, escalationChannelId));
  await db.delete(users).where(eq(users.email, email));
  hookServer.close();
});

async function createCheck(body: Record<string, unknown>) {
  const res = await request(app).post("/api/checks").set("Cookie", cookie).send({ endpointId, intervalSeconds: 60, ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; pushToken: string | null; config: Record<string, unknown> };
}
const push = (token: string, query: string) => request(app).get(`/api/hb/${token}?${query}`);
const waitFor = async (pred: () => boolean, ms = 2000) => {
  const start = Date.now();
  while (!pred() && Date.now() - start < ms) await new Promise((r) => setTimeout(r, 25));
};
const openEvents = async (checkId: string) => {
  const rules = await db.query.alertRules.findMany({ where: (r, { eq }) => eq(r.checkId, checkId) });
  const evs = await db.query.alertEvents.findMany({ orderBy: desc(alertEvents.triggeredAt) });
  return evs.filter((e) => rules.some((r) => r.id === e.alertRuleId));
};

describe("heartbeat / push URLs (K1, K2)", () => {
  it("records pings, applies thresholds to pushed values, and rejects bad tokens", async () => {
    const hb = await createCheck({ name: "nightly backup", type: "heartbeat" });
    expect(hb.pushToken).toBeTruthy();
    expect((await push(hb.pushToken!, "")).text).toBe("OK");
    expect((await push(hb.pushToken!, "status=fail&msg=rsync%20exit%2023")).status).toBe(200);
    const latest = await db.query.checks.findFirst({ where: eq(checks.id, hb.id) });
    expect(latest?.lastStatus).toBe("down");
    expect(latest?.lastMessage).toBe("rsync exit 23");

    const pv = await createCheck({ name: "queue depth", type: "push_value", config: { warnAbove: 100, criticalAbove: 500 } });
    expect((await push(pv.pushToken!, "")).status).toBe(400);
    await push(pv.pushToken!, "value=250");
    expect((await db.query.checks.findFirst({ where: eq(checks.id, pv.id) }))?.lastStatus).toBe("warn");
    expect((await request(app).get("/api/hb/not-a-real-token")).status).toBe(404);
  });

  it("goes down when a heartbeat is overdue", async () => {
    const hb = await createCheck({ name: "overdue job", type: "heartbeat", config: { graceSeconds: 1 } });
    await db.update(checks).set({ createdAt: new Date(Date.now() - 3_600_000), intervalSeconds: 60 }).where(eq(checks.id, hb.id));
    const row = (await db.query.checks.findFirst({ where: eq(checks.id, hb.id) }))!;
    const r = await runOneCheck(row);
    expect(r.status).toBe("down");
    expect(r.message).toMatch(/No ping received yet/);
  });
});

describe("alerting (L3, L5, L12)", () => {
  it("triggers on warn when asked, names the check, resolves, and escalates", async () => {
    const pv = await createCheck({ name: "Disk queue", type: "push_value", config: { warnAbove: 10 } });
    await request(app).post("/api/alert-rules").set("Cookie", cookie).send({ checkId: pv.id, consecutiveFailures: 2, triggerOn: "warn", channelIds: [webhookChannelId], escalationChannelIds: [escalationChannelId], escalateAfterMinutes: 5, renotifyMinutes: 10 });
    received.length = 0;
    await push(pv.pushToken!, "value=20");
    expect((await openEvents(pv.id)).length).toBe(0);
    await push(pv.pushToken!, "value=30");
    await waitFor(() => received.length > 0);
    expect(received[0].path).toBe("/primary");
    expect(JSON.parse(received[0].body).content).toMatch(/\[Looksee\] Disk queue is WARN: 30 is above warn threshold 10/);

    const [event] = await openEvents(pv.id);
    await processOpenAlerts(new Date(event.triggeredAt.getTime() + 6 * 60_000));
    await waitFor(() => received.some((r) => r.path === "/escalation"));
    expect(received.filter((r) => r.path === "/escalation")).toHaveLength(1);
    expect((await db.query.alertEvents.findFirst({ where: eq(alertEvents.id, event.id) }))?.escalatedAt).toBeTruthy();

    received.length = 0;
    await push(pv.pushToken!, "value=1");
    await waitFor(() => received.length >= 2);
    expect(received.map((r) => r.path).sort()).toEqual(["/escalation", "/primary"]);
    expect(JSON.parse(received[0].body).content).toMatch(/recovered/);
  });

  it("re-notifies while still open", async () => {
    const pv = await createCheck({ name: "Renotify me", type: "push_value", config: { criticalAbove: 1 } });
    await request(app).post("/api/alert-rules").set("Cookie", cookie).send({ checkId: pv.id, consecutiveFailures: 1, channelIds: [webhookChannelId], renotifyMinutes: 10 });
    await push(pv.pushToken!, "value=5");
    const [event] = await openEvents(pv.id);
    received.length = 0;
    await processOpenAlerts(new Date(Date.now() + 11 * 60_000));
    await waitFor(() => received.length > 0);
    expect(JSON.parse(received[0].body).content).toMatch(/Still failing — Renotify me/);
    void event;
  });

  it("suppresses a child's alert while its parent is down (L2)", async () => {
    const parent = await createCheck({ name: "Router", type: "heartbeat" });
    const child = await createCheck({ name: "Printer behind router", type: "heartbeat", dependsOn: [parent.id] });
    await request(app).post("/api/alert-rules").set("Cookie", cookie).send({ checkId: child.id, consecutiveFailures: 1, channelIds: [webhookChannelId] });
    await push(parent.pushToken!, "status=down");
    received.length = 0;
    await push(child.pushToken!, "status=down");
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
    expect(await openEvents(child.id)).toHaveLength(0);
    await push(parent.pushToken!, "status=up");
    await push(child.pushToken!, "status=down");
    await waitFor(() => received.length > 0);
    expect(received).toHaveLength(1);
  });

  it("holds alerts for a flapping check (L4)", async () => {
    const hb = await createCheck({ name: "Flappy", type: "heartbeat" });
    await request(app).post("/api/alert-rules").set("Cookie", cookie).send({ checkId: hb.id, consecutiveFailures: 1, channelIds: [webhookChannelId] });
    for (let i = 0; i < 4; i++) {
      await push(hb.pushToken!, "status=up");
      await push(hb.pushToken!, "status=down");
      await push(hb.pushToken!, "status=up");
    }
    // Opening incidents during the early flips is expected; once flapping
    // is detected, the open incident may resolve but no new one may open.
    const row = await db.query.checks.findFirst({ where: eq(checks.id, hb.id) });
    expect(row?.flapping).toBe(true);
    const before = (await openEvents(hb.id)).length;
    await push(hb.pushToken!, "status=down");
    expect((await openEvents(hb.id)).length).toBe(before);
  });

  it("records maintenance-window results without alerting (L1)", async () => {
    const hb = await createCheck({ name: "Patching tonight", type: "heartbeat" });
    await request(app).post("/api/alert-rules").set("Cookie", cookie).send({ checkId: hb.id, consecutiveFailures: 1, channelIds: [webhookChannelId] });
    const m = await request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ ids: [hb.id], action: "maintenance", minutes: 30 });
    expect(m.body.affected).toBe(1);
    await new Promise((r) => setTimeout(r, 50));
    received.length = 0;
    await push(hb.pushToken!, "status=down");
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toHaveLength(0);
    const [result] = await db.query.checkResults.findMany({ where: eq(checkResults.checkId, hb.id), orderBy: desc(checkResults.checkedAt), limit: 1 });
    expect(result.inMaintenance).toBe(true);
  });
});

describe("maintenance window schedule", () => {
  it("handles one-off and weekly windows, including one that crosses midnight", () => {
    const now = new Date("2026-10-10T23:30:00"); // a Saturday, local time
    const base = { enabled: true, startsAt: null, endsAt: null, daysOfWeek: null, startTime: null, durationMinutes: null };
    expect(windowIsActive({ ...base, startsAt: new Date(now.getTime() - 60_000), endsAt: new Date(now.getTime() + 60_000) }, now)).toBe(true);
    expect(windowIsActive({ ...base, daysOfWeek: [6], startTime: "23:00", durationMinutes: 120 }, now)).toBe(true);
    const sundayEarly = new Date("2026-10-11T00:30:00");
    expect(windowIsActive({ ...base, daysOfWeek: [6], startTime: "23:00", durationMinutes: 120 }, sundayEarly)).toBe(true);
    expect(windowIsActive({ ...base, daysOfWeek: [6], startTime: "23:00", durationMinutes: 30 }, sundayEarly)).toBe(false);
    expect(windowIsActive({ ...base, daysOfWeek: [1], startTime: "23:00", durationMinutes: 120 }, now)).toBe(false);
    expect(windowIsActive({ ...base, enabled: false, daysOfWeek: [6], startTime: "23:00", durationMinutes: 120 }, now)).toBe(false);
  });
});

describe("check management API", () => {
  it("never returns stored secrets, and keeps them when the mask is sent back", async () => {
    const c = await createCheck({ name: "db", type: "database", config: { engine: "postgres", host: "db.local", username: "mon", password: "hunter2" } });
    expect(c.config.password).toBe(MASK);
    const list = await request(app).get(`/api/checks?endpointId=${endpointId}`).set("Cookie", cookie);
    expect(JSON.stringify(list.body)).not.toContain("hunter2");
    await request(app).patch(`/api/checks/${c.id}`).set("Cookie", cookie).send({ config: { engine: "postgres", host: "db2.local", username: "mon", password: MASK } });
    const stored = await db.query.checks.findFirst({ where: eq(checks.id, c.id) });
    expect((stored!.config as Record<string, unknown>).password).toBe("hunter2");
    expect((stored!.config as Record<string, unknown>).host).toBe("db2.local");
  });

  it("applies bulk actions to many checks at once", async () => {
    const a = await createCheck({ name: "bulk-a", type: "ping", config: { host: "127.0.0.1" } });
    const b = await createCheck({ name: "bulk-b", type: "tcp", config: { host: "127.0.0.1", port: 1 } });
    const ids = [a.id, b.id];
    const bulk = (body: Record<string, unknown>) => request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ ids, ...body });
    expect((await bulk({ action: "disable" })).body.affected).toBe(2);
    expect((await db.query.checks.findFirst({ where: eq(checks.id, a.id) }))?.enabled).toBe(false);
    await bulk({ action: "add_tags", tags: ["lan", "core"] });
    await bulk({ action: "remove_tags", tags: ["core"] });
    expect((await db.query.checks.findFirst({ where: eq(checks.id, b.id) }))?.tags).toEqual(["lan"]);
    await bulk({ action: "set_interval", seconds: 300 });
    await bulk({ action: "set_retry_interval", seconds: 30 });
    const rowB = await db.query.checks.findFirst({ where: eq(checks.id, b.id) });
    expect([rowB?.intervalSeconds, rowB?.retryIntervalSeconds]).toEqual([300, 30]);
    await bulk({ action: "move", endpointId: otherEndpointId });
    expect((await db.query.checks.findFirst({ where: eq(checks.id, a.id) }))?.endpointId).toBe(otherEndpointId);
    const probe = await bulk({ action: "set_probe_host", hostId });
    expect(probe.body.affected).toBe(2);
    const dup = await bulk({ action: "duplicate" });
    expect(dup.body.affected).toBe(2);
    const ruleRes = await bulk({ action: "add_alert_rule", consecutiveFailures: 3, channelIds: [webhookChannelId] });
    expect(ruleRes.body.affected).toBe(2);
    expect((await bulk({ action: "nope" })).status).toBe(400);
    expect((await bulk({ action: "delete" })).body.affected).toBe(2);
  });

  it("refuses to pin a non-probe type to an agent", async () => {
    const c = await createCheck({ name: "snmp-x", type: "snmp", config: { host: "1.2.3.4", oid: "1.3.6.1.2.1.1.3.0" } });
    const res = await request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ ids: [c.id], action: "set_probe_host", hostId });
    expect(res.body.affected).toBe(0);
    expect(res.body.errors[0].error).toMatch(/can't run on an agent/);
  });

  it("runs a check on demand", async () => {
    const c = await createCheck({ name: "run me", type: "tcp", config: { host: "127.0.0.1", port: 1 } });
    const res = await request(app).post(`/api/checks/${c.id}/run`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("down");
  });
});

describe("status pages and SLA reports (L7, L8)", () => {
  it("serves a public page with only the chosen checks and computes uptime", async () => {
    const hb = await createCheck({ name: "Public website", type: "heartbeat" });
    const base = Date.now() - 3_600_000;
    // 3 up minutes, 1 down minute, then up again.
    for (const [i, status] of (["up", "up", "up", "down", "up"] as const).entries()) {
      await db.insert(checkResults).values({ checkId: hb.id, status, checkedAt: new Date(base + i * 60_000) });
    }
    await db.update(checks).set({ lastStatus: "up" }).where(eq(checks.id, hb.id));
    const slug = `test-${crypto.randomUUID().slice(0, 8)}`;
    const page = await request(app).post("/api/status-pages").set("Cookie", cookie).send({ title: "Status", slug, checkIds: [hb.id] });
    expect(page.status).toBe(201);
    const pub = await request(app).get(`/api/public/status/${slug}`);
    expect(pub.status).toBe(200);
    expect(pub.body.overall).toBe("operational");
    expect(pub.body.checks).toHaveLength(1);
    expect(pub.body.checks[0]).toMatchObject({ name: "Public website", status: "up" });
    expect(pub.body.checks[0].days).toHaveLength(90);
    expect(JSON.stringify(pub.body)).not.toContain(hb.id);

    const sla = await request(app).get(`/api/insights/reports/sla?days=1&endpointId=${endpointId}`).set("Cookie", cookie);
    const row = sla.body.checks.find((c: { checkId: string }) => c.checkId === hb.id);
    expect(row.incidents).toBe(1);
    expect(row.downtimeMinutes).toBe(1);
    expect(row.uptimePercent).toBeLessThan(100);
    const csv = await request(app).get(`/api/insights/reports/sla?days=1&format=csv&endpointId=${endpointId}`).set("Cookie", cookie);
    expect(csv.headers["content-type"]).toMatch(/text\/csv/);
    expect(csv.text).toMatch(/^check,type,uptime_percent/);
    await request(app).delete(`/api/status-pages/${page.body.id}`).set("Cookie", cookie);
    expect((await request(app).get(`/api/public/status/${slug}`)).status).toBe(404);
  });
});

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  cpu: { percent: 12, perCore: [10, 14] },
  load: { l1: 0.5, l5: 3.2, l15: 0.4, cores: 2 },
  mem: { total: 8e9, available: 2e9, percent: 75, swapTotal: 2e9, swapUsed: 1e9, swapPercent: 50 },
  bootTime: 1_790_000_000,
  uptimeSeconds: 7200,
  disks: [
    { mount: "/", fstype: "ext4", total: 100e9, used: 95e9, free: 5e9, percent: 95, inodesPercent: 10, readOnly: false },
    { mount: "/data", fstype: "xfs", total: 1000e9, used: 100e9, free: 900e9, percent: 10, readOnly: true },
  ],
  net: [{ name: "eth0", up: true, speedMbps: 1000, rxBytesPerSec: 1.25e6, txBytesPerSec: 0 }],
  users: { count: 1, sessions: [{ user: "jason", terminal: "pts/0" }] },
  listening: [{ port: 22, proto: "tcp" }],
  firewall: { enabled: false },
  ...overrides,
});

describe("agent protocol 3.0", () => {
  it("evaluates host_metric checks against the extended snapshot", async () => {
    const make = (name: string, config: Record<string, unknown>) => createCheck({ name, type: "host_metric", hostId, config });
    const free = await make("root free", { metric: "disk.free_gb", instance: "/", warnBelow: 10, criticalBelow: 2 });
    const ro = await make("data ro", { metric: "disk.read_only", instance: "/data", severity: "down" });
    const load = await make("load", { metric: "load.5", warnAbove: 1.5 });
    const fw = await make("fw", { metric: "firewall.enabled", severity: "warn" });
    const port = await make("ssh listening", { metric: "port.listening", instance: "22" });
    const missing = await make("no sensor", { metric: "temp.max" });
    await request(app).post("/api/agent/report").set(agentAuth).send({ version: "3.0.0", metrics: { cpuPercent: 12, memPercent: 75, diskPercent: 95, extended: snapshot() } }).expect(200);
    const status = async (id: string) => (await db.query.checks.findFirst({ where: eq(checks.id, id) }))!;
    expect((await status(free.id)).lastStatus).toBe("warn");
    expect((await status(free.id)).lastValue).toBe(5);
    expect((await status(ro.id)).lastStatus).toBe("down");
    expect((await status(load.id)).lastStatus).toBe("warn");
    expect((await status(load.id)).lastValue).toBe(1.6);
    expect((await status(fw.id)).lastStatus).toBe("warn");
    expect((await status(port.id)).lastStatus).toBe("up");
    expect((await status(missing.id)).lastStatus).toBe("unknown");
    const [row] = await db.query.hostMetrics.findMany({ where: eq(hostMetrics.hostId, hostId), orderBy: desc(hostMetrics.recordedAt), limit: 1 });
    expect((row.extended as { disks: unknown[] }).disks).toHaveLength(2);
  });

  it("detects a reboot and a new login session, holding the warn", async () => {
    const reboot = await createCheck({ name: "reboot", type: "host_reboot", hostId });
    const sessions = await createCheck({ name: "logins", type: "host_change", hostId, config: { what: "sessions" } });
    const send = (snap: Record<string, unknown>) => request(app).post("/api/agent/report").set(agentAuth).send({ version: "3.0.0", metrics: { extended: snapshot(snap) } }).expect(200);
    await send({});
    const row = async (id: string) => (await db.query.checks.findFirst({ where: eq(checks.id, id) }))!;
    expect((await row(reboot.id)).lastStatus).toBe("up");
    expect((await row(sessions.id)).lastMessage).toMatch(/Baseline recorded/);
    await send({ bootTime: 1_790_009_999, users: { count: 2, sessions: [{ user: "jason", terminal: "pts/0" }, { user: "mallory", terminal: "pts/1", host: "203.0.113.7" }] } });
    expect((await row(reboot.id)).lastStatus).toBe("warn");
    expect((await row(sessions.id)).lastStatus).toBe("warn");
    expect((await row(sessions.id)).lastMessage).toMatch(/mallory@pts\/1 from 203\.0\.113\.7/);
    await send({ bootTime: 1_790_009_999 });
    expect((await row(reboot.id)).lastStatus).toBe("warn");
  });

  it("accepts 3.x results with thresholds, still accepts legacy services[], and rejects foreign checks", async () => {
    const file = await createCheck({ name: "backup age", type: "agent_file", hostId, config: { path: "/backups", mode: "age", warnAbove: 1440 } });
    const svc = await createCheck({ name: "nginx", type: "agent_service", hostId, config: { serviceName: "nginx" } });
    const otherHost = (await db.insert(hosts).values({ endpointId, name: "other" }).returning())[0];
    const foreign = await createCheck({ name: "not yours", type: "agent_process", hostId: otherHost.id, config: { serviceName: "x" } });
    await request(app)
      .post("/api/agent/report")
      .set(agentAuth)
      .send({ version: "3.0.0", results: [{ checkId: file.id, status: "up", value: 2000, message: "newest file 2000 min old" }, { checkId: foreign.id, status: "down" }], services: [{ checkId: svc.id, running: false, message: "inactive" }] })
      .expect(200);
    const row = async (id: string) => (await db.query.checks.findFirst({ where: eq(checks.id, id) }))!;
    expect((await row(file.id)).lastStatus).toBe("warn");
    expect((await row(svc.id)).lastStatus).toBe("down");
    expect((await row(foreign.id)).lastStatus).toBeNull();
  });

  it("withholds new check types from old agents and explains why", async () => {
    const file = await createCheck({ name: "needs v3", type: "agent_file", hostId, config: { path: "/x", mode: "exists" } });
    const svc = await createCheck({ name: "legacy ok", type: "agent_service", hostId, config: { serviceName: "sshd" } });
    await request(app).post("/api/agent/report").set(agentAuth).send({ version: "1.2.0", metrics: {} });
    const cfg = await request(app).get("/api/agent/config").set(agentAuth);
    const ids = cfg.body.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain(svc.id);
    expect(ids).not.toContain(file.id);
    expect((await db.query.checks.findFirst({ where: eq(checks.id, file.id) }))?.lastMessage).toMatch(/Needs agent 3\.0\.0\+/);
    await request(app).post("/api/agent/report").set(agentAuth).send({ version: "3.0.0", metrics: {} });
    const cfg3 = await request(app).get("/api/agent/config").set(agentAuth);
    expect(cfg3.body.checks.map((c: { id: string }) => c.id)).toContain(file.id);
  });

  it("sends remote-probe checks to the agent they're pinned to", async () => {
    const c = await createCheck({ name: "lan-only http", type: "http", probeHostId: hostId, config: { url: "http://10.0.0.1/" } });
    const cfg = await request(app).get("/api/agent/config").set(agentAuth);
    expect(cfg.body.checks.find((x: { id: string }) => x.id === c.id)?.type).toBe("http");
    await request(app).post("/api/agent/report").set(agentAuth).send({ version: "3.0.0", results: [{ checkId: c.id, status: "up", latencyMs: 12 }] }).expect(200);
    expect((await db.query.checks.findFirst({ where: eq(checks.id, c.id) }))?.lastLatencyMs).toBe(12);
  });
});

describe("host suggestions and bulk host/endpoint actions (L10)", () => {
  it("suggests checks from the snapshot and applies only the chosen ones", async () => {
    const res = await request(app).get(`/api/hosts/${hostId}/suggestions`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    const keys = res.body.map((s: { key: string }) => s.key);
    expect(keys.some((k: string) => k.startsWith("host_metric|disk.used_percent|/"))).toBe(true);
    expect(keys.some((k: string) => k.startsWith("disk_forecast|"))).toBe(true);
    const pick = res.body.filter((s: { type: string }) => s.type === "agent_heartbeat").map((s: { key: string }) => s.key);
    const applied = await request(app).post(`/api/hosts/${hostId}/suggestions/apply`).set("Cookie", cookie).send({ keys: pick });
    expect(applied.body.created).toBe(1);
    const again = await request(app).get(`/api/hosts/${hostId}/suggestions`).set("Cookie", cookie);
    expect(again.body.some((s: { type: string }) => s.type === "agent_heartbeat")).toBe(false);
  });

  it("bulk-tags hosts and merges endpoints", async () => {
    const h2 = (await db.insert(hosts).values({ endpointId: otherEndpointId, name: "merge-me" }).returning())[0];
    await request(app).post("/api/hosts/bulk").set("Cookie", cookie).send({ ids: [hostId, h2.id], action: "add_tags", tags: "rack1, prod" }).expect(200);
    expect((await db.query.hosts.findFirst({ where: eq(hosts.id, h2.id) }))?.tags).toEqual(["rack1", "prod"]);
    const tmp = (await db.insert(endpoints).values({ name: "temp-merge" }).returning())[0];
    await db.update(hosts).set({ endpointId: tmp.id }).where(eq(hosts.id, h2.id));
    const merged = await request(app).post("/api/endpoints/bulk").set("Cookie", cookie).send({ ids: [tmp.id], action: "merge", targetId: otherEndpointId });
    expect(merged.body.affected).toBe(1);
    expect((await db.query.hosts.findFirst({ where: eq(hosts.id, h2.id) }))?.endpointId).toBe(otherEndpointId);
    expect(await db.query.endpoints.findFirst({ where: eq(endpoints.id, tmp.id) })).toBeUndefined();
  });

  it("serves the host metric catalog", async () => {
    const res = await request(app).get("/api/hosts/metric-catalog").set("Cookie", cookie);
    expect(res.body.find((m: { key: string }) => m.key === "disk.free_gb")).toMatchObject({ unit: " GB", instance: "mount" });
  });
});

describe("forecasting, anomaly detection, discovery helpers", () => {
  it("projects days until a disk fills", () => {
    const day = 86_400_000;
    const pts = [0, 1, 2, 3].map((d) => ({ t: d * day, used: 50e9 + d * 5e9 }));
    const f = forecastDaysToFull(pts, 100e9);
    expect(f.days).toBeCloseTo(7, 5);
    expect(forecastDaysToFull([{ t: 0, used: 5 }, { t: day, used: 4 }], 10).days).toBeNull();
  });

  it("disk_forecast reads hourly host_metrics history", async () => {
    const h = (await db.insert(hosts).values({ endpointId, name: "forecast-host" }).returning())[0];
    for (let i = 0; i < 6; i++) {
      await db.insert(hostMetrics).values({ hostId: h.id, recordedAt: new Date(Date.now() - (6 - i) * 3_600_000), extended: { disks: [{ mount: "/", total: 100e9, used: 90e9 + i * 1e9, free: 10e9 - i * 1e9, percent: 90 + i }] } });
    }
    const c = await createCheck({ name: "forecast", type: "disk_forecast", hostId: h.id, config: { mount: "/", warnDays: 14, criticalDays: 3 } });
    const r = await runOneCheck((await db.query.checks.findFirst({ where: eq(checks.id, c.id) }))!);
    expect(r.status).toBe("down");
    expect(r.value!).toBeLessThan(1);
  });

  it("anomaly flags a value far outside its baseline", async () => {
    const src = await createCheck({ name: "latency source", type: "heartbeat" });
    for (let d = 1; d <= 25; d++) {
      await db.insert(checkResults).values({ checkId: src.id, status: "up", value: 100 + (d % 5), checkedAt: new Date(Date.now() - d * 86_400_000) });
    }
    await db.insert(checkResults).values({ checkId: src.id, status: "up", value: 400, checkedAt: new Date() });
    const an = await createCheck({ name: "anomaly", type: "anomaly", config: { sourceCheckId: src.id, sensitivity: 3, minSamples: 20, lookbackDays: 30 } });
    const r = await runOneCheck((await db.query.checks.findFirst({ where: eq(checks.id, an.id) }))!);
    expect(r.status).toBe("down");
    expect(r.message).toMatch(/Anomaly/);
  });

  it("expands and bounds discovery ranges", () => {
    expect(expandCidr("192.168.1.0/30")).toEqual(["192.168.1.1", "192.168.1.2"]);
    expect(expandCidr("10.0.0.5/32")).toEqual(["10.0.0.5"]);
    expect(expandCidr("10.0.0.0/22")).toHaveLength(1022);
    expect(() => expandCidr("10.0.0.0/16")).toThrow(/limited/);
  });

  it("runs a discovery scan end to end", async () => {
    const start = await request(app).post("/api/insights/discovery/scans").set("Cookie", cookie).send({ cidr: "127.0.0.1/32" });
    expect(start.status).toBe(202);
    let scan = start.body;
    const t0 = Date.now();
    while (scan.status === "running" && Date.now() - t0 < 30_000) {
      await new Promise((r) => setTimeout(r, 500));
      scan = (await request(app).get(`/api/insights/discovery/scans/${scan.id}`).set("Cookie", cookie)).body;
    }
    expect(scan.status).toBe("done");
    expect(scan.results[0].ip).toBe("127.0.0.1");
    expect(scan.results[0].suggestedChecks.some((c: { type: string }) => c.type === "ping")).toBe(true);
    const add = await request(app).post(`/api/insights/discovery/scans/${scan.id}/add`).set("Cookie", cookie).send({ endpointId, devices: [{ ip: "127.0.0.1", createHost: true, checks: scan.results[0].suggestedChecks.slice(0, 1) }] });
    expect(add.body).toEqual({ hostsCreated: 1, checksCreated: 1 });
  }, 40_000);
});

describe("host metric instance matching", () => {
  it("prefers an exact mount over substring matches", async () => {
    const { evaluateHostMetric } = await import("../src/services/hostMetrics.js");
    const snap = { disks: [{ mount: "/etc/resolv.conf", total: 1, used: 1, free: 0, percent: 99, inodesPercent: 50 }, { mount: "/", total: 10, used: 1, free: 9, percent: 10, inodesPercent: 3 }] };
    expect(evaluateHostMetric(snap, { metric: "disk.inodes_percent", instance: "/" })?.value).toBe(3);
    expect(evaluateHostMetric(snap, { metric: "disk.used_percent", instance: "resolv" })?.value).toBe(99);
  });
});

describe("single-host API", () => {
  it("reports hasSnapshot once a 3.x agent has reported (the check form relies on it)", async () => {
    const res = await request(app).get(`/api/hosts/${hostId}`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.hasSnapshot).toBe(true);
    expect(res.body.lastSnapshot).toBeTruthy();
    expect(res.body.agentApiKey).toBeUndefined();
  });
});
