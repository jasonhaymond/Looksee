import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, events, hosts, users } from "../src/db/schema.js";
import { runOneCheck, takeCollectorChecks } from "../src/services/scheduler.js";
import { storeEvents } from "../src/services/receivers/index.js";

const email = `test-collector-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string; // remote site, has a collector
let localId: string; // the engine's own LAN
let pushSiteId: string; // remote site with direct push only
let collectorHostId: string;
let otherHostId: string;
let collectorAuth: { Authorization: string };
let otherAuth: { Authorization: string };
const pushIp = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;

const auth = () => ({ Cookie: cookie });
async function makeCheck(endpointId: string, type: string, config: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const res = await request(app).post("/api/checks").set(auth()).send({ endpointId, name: `${type}-${crypto.randomUUID().slice(0, 6)}`, type, config, ...extra });
  expect(res.status).toBe(201);
  return res.body as { id: string };
}

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = (await request(app).post("/api/auth/login").send({ email, password })).headers["set-cookie"]![0];

  const [site, local, pushSite] = await db
    .insert(endpoints)
    .values([{ name: `test-site-${crypto.randomUUID()}` }, { name: `test-local-${crypto.randomUUID()}` }, { name: `test-push-${crypto.randomUUID()}` }])
    .returning();
  siteId = site.id;
  localId = local.id;
  pushSiteId = pushSite.id;
  const [collector, other] = await db
    .insert(hosts)
    .values([
      { endpointId: siteId, name: "test-collector-host" },
      { endpointId: siteId, name: "test-sleepy-host", macAddress: "00:11:22:33:44:55" },
    ])
    .returning();
  collectorHostId = collector.id;
  otherHostId = other.id;
  collectorAuth = { Authorization: `Bearer ${(await request(app).post(`/api/hosts/${collectorHostId}/agent-key`).set(auth())).body.agentApiKey}` };
  otherAuth = { Authorization: `Bearer ${(await request(app).post(`/api/hosts/${otherHostId}/agent-key`).set(auth())).body.agentApiKey}` };
});

afterAll(async () => {
  await db.delete(endpoints).where(inArray(endpoints.id, [siteId, localId, pushSiteId]));
  await db.delete(users).where(eq(users.email, email));
});

describe("site collector setup", () => {
  it("only an agent host can be a site's collector", async () => {
    const [bare] = await db.insert(hosts).values({ endpointId: siteId, name: "test-no-agent" }).returning();
    const res = await request(app).patch(`/api/endpoints/${siteId}`).set(auth()).send({ collectorHostId: bare.id });
    expect(res.status).toBe(400);
    await db.delete(hosts).where(eq(hosts.id, bare.id));
  });

  it("rejects public IPs that aren't addresses", async () => {
    const res = await request(app).patch(`/api/endpoints/${pushSiteId}`).set(auth()).send({ publicIps: "203.0.113.5, not-an-ip" });
    expect(res.status).toBe(400);
  });

  it("refuses the collector API before the host is a collector", async () => {
    const res = await request(app).get("/api/collector/config").set(collectorAuth);
    expect(res.status).toBe(403);
  });

  it("tells the agent to run the collector once assigned", async () => {
    const before = await request(app).get("/api/agent/config").set(collectorAuth);
    expect(before.body.collector).toBeNull();

    const res = await request(app).patch(`/api/endpoints/${siteId}`).set(auth()).send({ collectorHostId });
    expect(res.status).toBe(200);
    expect(res.body.collectorHostId).toBe(collectorHostId);

    const after = await request(app).get("/api/agent/config").set(collectorAuth);
    if (after.body.collector) {
      expect(typeof after.body.collector.bundleSha256).toBe("string");
    } else {
      // No collector build on this machine: the host says why instead.
      const host = await db.query.hosts.findFirst({ where: eq(hosts.id, collectorHostId) });
      expect(host?.collectorError).toMatch(/hasn't been built/);
    }
    // Another agent at the same site isn't the collector.
    expect((await request(app).get("/api/agent/config").set(otherAuth)).body.collector).toBeNull();
    expect((await request(app).get("/api/collector/config").set(otherAuth)).status).toBe(403);
  });
});

describe("collector config and results", () => {
  let pingId: string;
  let matchId: string;
  let localPingId: string;

  beforeAll(async () => {
    pingId = (await makeCheck(siteId, "ping", { host: "10.9.9.9" })).id;
    matchId = (await makeCheck(siteId, "syslog_match", { pattern: "collector-test-marker" })).id;
    localPingId = (await makeCheck(localId, "ping", { host: "127.0.0.1" })).id;
  });

  it("hands the collector its site's network checks only, and marks it seen", async () => {
    const res = await request(app).get("/api/collector/config?version=3.2.0-test").set(collectorAuth);
    expect(res.status).toBe(200);
    const ids = res.body.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain(pingId);
    expect(ids).not.toContain(matchId); // event matching stays on the engine
    expect(ids).not.toContain(localPingId);
    expect(res.body.receivers.syslog).toBeGreaterThan(0);
    const host = await db.query.hosts.findFirst({ where: eq(hosts.id, collectorHostId) });
    expect(host?.collectorVersion).toBe("3.2.0-test");
    expect(Date.now() - host!.collectorLastSeenAt!.getTime()).toBeLessThan(10_000);
    expect(host?.collectorError).toBeNull();
  });

  it("records posted results and ignores checks it doesn't own", async () => {
    const ranAt = new Date(Date.now() - 5000).toISOString();
    const res = await request(app)
      .post("/api/collector/results")
      .set(collectorAuth)
      .send({ results: [{ checkId: pingId, status: "down", message: "100% packet loss", latencyMs: null, ranAt }, { checkId: localPingId, status: "down", message: "spoofed" }] });
    expect(res.body.accepted).toBe(1);
    const ping = await db.query.checks.findFirst({ where: eq(checks.id, pingId) });
    expect(ping?.lastStatus).toBe("down");
    expect(ping?.lastRunAt?.toISOString()).toBe(ranAt);
    const local = await db.query.checks.findFirst({ where: eq(checks.id, localPingId) });
    expect(local?.lastMessage).not.toBe("spoofed");
  });

  it("queues Run now on the collector instead of running it on the engine", async () => {
    const res = await request(app).post(`/api/checks/${pingId}/run`).set(auth());
    expect(res.status).toBe(202);
    const cfg = await request(app).get("/api/collector/config").set(collectorAuth);
    expect(cfg.body.checks.find((c: { id: string }) => c.id === pingId).lastRunAt).toBeNull();
  });

  it("the scheduler leaves a live collector's checks alone and marks a silent one unknown", async () => {
    const due = await db.query.checks.findMany({ where: inArray(checks.id, [pingId, matchId, localPingId]) });
    const engineRuns = (await takeCollectorChecks(due)).map((c) => c.id);
    expect(engineRuns).toEqual(expect.arrayContaining([matchId, localPingId]));
    expect(engineRuns).not.toContain(pingId);

    await db.update(hosts).set({ collectorLastSeenAt: new Date(Date.now() - 3600_000) }).where(eq(hosts.id, collectorHostId));
    await takeCollectorChecks(due);
    const ping = await db.query.checks.findFirst({ where: eq(checks.id, pingId) });
    expect(ping?.lastStatus).toBe("unknown");
    expect(ping?.lastMessage).toMatch(/Site collector on test-collector-host is offline/);
  });

  it("files received events under the site, matched only by that site's checks", async () => {
    const res = await request(app)
      .post("/api/collector/events")
      .set(collectorAuth)
      .send({
        events: [{ source: "syslog", sourceIp: "10.9.9.1", severity: 3, facility: 1, message: "link down collector-test-marker", data: null, receivedAt: new Date().toISOString() }],
        flows: [{ bucket: new Date().toISOString(), exporter: "10.9.9.1", srcAddr: "10.9.9.2", dstAddr: "8.8.8.8", protocol: 6, dstPort: 443, bytes: 1000, packets: 3 }],
      });
    expect(res.body).toEqual({ events: 1, flows: 1 });
    const [stored] = await db.select().from(events).where(eq(events.sourceIp, "10.9.9.1"));
    expect(stored.endpointId).toBe(siteId);

    const siteMatch = await runOneCheck((await db.query.checks.findFirst({ where: eq(checks.id, matchId) }))!);
    expect(siteMatch.value).toBe(1);
    const localMatch = await makeCheck(localId, "syslog_match", { pattern: "collector-test-marker" });
    const local = await runOneCheck((await db.query.checks.findFirst({ where: eq(checks.id, localMatch.id) }))!);
    expect(local.value).toBe(0);
  });
});

describe("one-off work", () => {
  it("runs a remote site's discovery scan on its collector", async () => {
    const res = await request(app).post("/api/insights/discovery/scans").set(auth()).send({ cidr: "10.9.9.0/30", endpointId: siteId });
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("queued");

    const cfg = await request(app).get("/api/collector/config").set(collectorAuth);
    expect(cfg.body.scans).toEqual([{ id: res.body.id, cidr: "10.9.9.0/30", community: "public" }]);
    // Handed out once.
    expect((await request(app).get("/api/collector/config").set(collectorAuth)).body.scans).toEqual([]);

    const device = { ip: "10.9.9.1", hostname: "switch1", mac: null, pingable: true, openPorts: [{ port: 22, service: "ssh" }], snmp: null };
    await request(app).post(`/api/collector/scans/${res.body.id}`).set(collectorAuth).send({ devices: [device], done: true }).expect(200);
    const scan = (await request(app).get(`/api/insights/discovery/scans/${res.body.id}`).set(auth())).body;
    expect(scan.status).toBe("done");
    expect(scan.results[0].suggestedChecks.map((c: { type: string }) => c.type)).toEqual(expect.arrayContaining(["ping", "protocol"]));
  });

  it("sends Wake-on-LAN through the target's site collector", async () => {
    const res = await request(app).post(`/api/hosts/${otherHostId}/wake`).set(auth());
    expect(res.body).toEqual({ sent: true, viaCollector: true });
    const cfg = await request(app).get("/api/collector/config").set(collectorAuth);
    const job = cfg.body.jobs.find((j: { payload: { mac: string } }) => j.payload.mac === "00:11:22:33:44:55");
    expect(job.kind).toBe("wake");
    await request(app).post(`/api/collector/jobs/${job.id}`).set(collectorAuth).send({ ok: true, message: "sent" }).expect(200);
  });
});

describe("direct push", () => {
  it("files events from a site's public IP under that site", async () => {
    await request(app).patch(`/api/endpoints/${pushSiteId}`).set(auth()).send({ publicIps: pushIp }).expect(200);
    await storeEvents([{ source: "syslog", sourceIp: pushIp, severity: 4, facility: 1, message: "pushed", data: null, receivedAt: new Date().toISOString() }], null);
    const [stored] = await db.select().from(events).where(eq(events.sourceIp, pushIp));
    expect(stored.endpointId).toBe(pushSiteId);
  });
});
