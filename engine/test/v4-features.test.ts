import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import http from "node:http";
import net from "node:net";
import { eq, inArray } from "drizzle-orm";
import * as snmp from "net-snmp";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { alertRules, checks, checkResults, sites, endpoints, locations, macIpHistory, notificationChannels, users } from "../src/db/schema.js";
import { decodeVarbindValue, displayValue } from "../src/services/probes/snmp.js";
import { evaluateScriptOutput } from "../src/services/scriptOutput.js";
import { remediationFor } from "../src/services/remediation.js";
import { render, renderFor, sampleContext } from "../src/services/notifications/templates.js";
import { recordSighting, probeIpChange } from "../src/services/addresses.js";
import { suggestChecks } from "../src/services/suggestions.js";

const email = `test-v33-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let epA: string;
let epB: string;
let endpointA: string;
let endpointB: string;
const channelIds: string[] = [];
const locationIds: string[] = [];

// A tiny webhook receiver standing in for Slack/Teams/Telegram/webhooks.
const received: { path: string; body: string }[] = [];
let hookServer: http.Server;
let hookBase: string;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  [epA, epB] = (await db.insert(sites).values([{ name: `v33-a-${crypto.randomUUID()}` }, { name: `v33-b-${crypto.randomUUID()}` }]).returning()).map((e) => e.id);
  endpointA = (await db.insert(endpoints).values({ siteId: epA, name: "alpha", hostname: "10.9.0.1" }).returning())[0].id;
  endpointB = (await db.insert(endpoints).values({ siteId: epB, name: "bravo", hostname: "10.9.0.2" }).returning())[0].id;
  hookServer = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", body });
      res.end("ok");
    });
  });
  await new Promise<void>((r) => hookServer.listen(0, "127.0.0.1", r));
  hookBase = `http://127.0.0.1:${(hookServer.address() as net.AddressInfo).port}`;
});

afterAll(async () => {
  hookServer.close();
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(inArray(sites.id, [epA, epB]));
  if (channelIds.length) await db.delete(notificationChannels).where(inArray(notificationChannels.id, channelIds));
  if (locationIds.length) await db.delete(locations).where(inArray(locations.id, locationIds));
  await db.delete(macIpHistory).where(inArray(macIpHistory.mac, ["02:00:00:00:33:01"]));
});

describe("SNMP decoding", () => {
  it("decodes Counter64 buffers into numbers (the blank interface-traffic bug)", () => {
    const buf = Buffer.from([0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06]);
    expect(decodeVarbindValue({ type: snmp.ObjectType.Counter64, value: buf })).toBe(0x010203040506);
    expect(decodeVarbindValue({ type: snmp.ObjectType.Counter64, value: Buffer.from([0x05]) })).toBe(5);
    expect(decodeVarbindValue({ type: snmp.ObjectType.Integer, value: 7 })).toBe(7);
  });
  it("shows binary octet strings as hex and text as text", () => {
    expect(displayValue(Buffer.from([0x00, 0x1a, 0x2b, 0x3c, 0x4d, 0x5e]))).toBe("00:1a:2b:3c:4d:5e");
    expect(displayValue(Buffer.from("pfSense"))).toBe("pfSense");
  });
});

describe("script expected output", () => {
  const base = { status: "up" as const, message: "ok", latencyMs: null, details: { output: "all pools are healthy\n", exitCode: 0 } };
  it("passes and fails on contains / regex / exit code", () => {
    expect(evaluateScriptOutput({ expectMode: "contains", expectText: "healthy" }, base)!.status).toBe("up");
    expect(evaluateScriptOutput({ expectMode: "not_contains", expectText: "healthy" }, base)!.status).toBe("down");
    expect(evaluateScriptOutput({ expectMode: "regex", expectText: "^ALL POOLS", expectIgnoreCase: true }, base)!.status).toBe("up");
    const exit = evaluateScriptOutput({ expectExitCode: 2, expectSeverity: "warn" }, base)!;
    expect(exit.status).toBe("warn");
    expect(exit.message).toMatch(/exited 0, expected 2/);
  });
  it("leaves the exit-code convention alone when nothing is expected, and asks old agents to update", () => {
    expect(evaluateScriptOutput({}, base)).toBeNull();
    expect(evaluateScriptOutput({ expectMode: "contains", expectText: "x" }, { ...base, details: null })!.message).toMatch(/4\.0\.0/);
  });
});

describe("remediation hints", () => {
  it("is empty for up checks and specific for failures", () => {
    expect(remediationFor({ type: "tcp", status: "up", message: null })).toEqual([]);
    const refused = remediationFor({ type: "tcp", status: "down", message: "connect ECONNREFUSED 10.0.0.5:5432" });
    expect(refused[0]).toMatch(/Nothing is listening/);
    expect(remediationFor({ type: "host_metric", status: "warn", message: "/ 91% used", config: { metric: "disk.used_percent" } }).join(" ")).toMatch(/Free space/);
    expect(remediationFor({ type: "unknown_type", status: "down", message: "weird" }).length).toBeGreaterThan(0);
  });
});

describe("templates", () => {
  it("renders variables and tidies empty ones", () => {
    expect(render("Host: {{host}} · Endpoint: {{endpoint}}", { host: "", endpoint: "LAN" })).toBe("Endpoint: LAN");
    const r = renderFor({ triggered: { title: "ALERT {{check}}" } }, sampleContext());
    expect(r.title).toBe("ALERT Example — office router ping");
    expect(r.body).toContain("Things to check");
  });
});

describe("channels", () => {
  it("creates Slack/Teams/Telegram-shaped channels, keeps config write-only, and sends a test through templates", async () => {
    const slack = await request(app).post("/api/channels").set("Cookie", cookie).send({ name: "slack", type: "slack", config: { webhookUrl: `${hookBase}/slack` }, templates: { triggered: { title: "T {{check}}", body: "B {{status}}" } } });
    expect(slack.status).toBe(201);
    channelIds.push(slack.body.id);
    expect(slack.body.config).toBeUndefined();
    expect(slack.body.templates.triggered.title).toBe("T {{check}}");
    const teams = await request(app).post("/api/channels").set("Cookie", cookie).send({ name: "teams", type: "teams", config: { webhookUrl: `${hookBase}/teams` } });
    channelIds.push(teams.body.id);

    received.length = 0;
    expect((await request(app).post(`/api/channels/${slack.body.id}/test`).set("Cookie", cookie)).status).toBe(200);
    expect((await request(app).post(`/api/channels/${teams.body.id}/test`).set("Cookie", cookie)).status).toBe(200);
    const s = JSON.parse(received.find((r) => r.path === "/slack")!.body);
    expect(s.text).toBe("*T Example — office router ping*\nB DOWN");
    const t = JSON.parse(received.find((r) => r.path === "/teams")!.body);
    expect(t.attachments[0].contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(t.attachments[0].content.body[0].text).toBe("Example — office router ping is DOWN");

    const bad = await request(app).post("/api/channels").set("Cookie", cookie).send({ name: "x", type: "carrier_pigeon" });
    expect(bad.status).toBe(400);
  });

  it("previews templates against sample data", async () => {
    const res = await request(app).post("/api/channels/preview").set("Cookie", cookie).send({ templates: { resolved: { title: "OK {{check}}" } } });
    expect(res.body.resolved.title).toBe("OK Example — office router ping");
    expect(res.body.triggered.title).toMatch(/is DOWN/);
  });
});

describe("locations", () => {
  it("groups sites and flows down to checks", async () => {
    const loc = await request(app).post("/api/locations").set("Cookie", cookie).send({ name: `Church ${crypto.randomUUID()}`, address: "1 Main St", siteIds: [epA] });
    expect(loc.status).toBe(201);
    locationIds.push(loc.body.id);
    const ep = (await request(app).get("/api/sites").set("Cookie", cookie)).body.find((e: { id: string }) => e.id === epA);
    expect(ep.locationId).toBe(loc.body.id);

    const c = await request(app).post("/api/checks").set("Cookie", cookie).send({ siteId: epA, name: "loc ping", type: "ping", config: { host: "127.0.0.1" } });
    const list = (await request(app).get("/api/checks").set("Cookie", cookie)).body as { id: string; locationId: string | null }[];
    expect(list.find((x) => x.id === c.body.id)!.locationId).toBe(loc.body.id);

    // Deleting the location keeps the endpoint, just unassigned.
    await request(app).delete(`/api/locations/${loc.body.id}`).set("Cookie", cookie);
    expect((await db.query.sites.findFirst({ where: eq(sites.id, epA) }))!.locationId).toBeNull();
  });
});

describe("batch create and duplicate", () => {
  it("creates one check per host with placeholders and an alert rule on each", async () => {
    const ch = await db.insert(notificationChannels).values({ name: "v33-email", type: "email", config: { to: "x@example.com" } }).returning();
    channelIds.push(ch[0].id);
    const res = await request(app)
      .post("/api/checks/batch")
      .set("Cookie", cookie)
      .send({ type: "ping", name: "Ping {{host}}", config: { host: "{{address}}" }, targets: [{ endpointId: endpointA }, { endpointId: endpointB }], alertRule: { channelIds: [ch[0].id], consecutiveFailures: 3 } });
    expect(res.status).toBe(201);
    expect(res.body.created.map((c: { name: string }) => c.name).sort()).toEqual(["Ping alpha", "Ping bravo"]);
    const bravo = res.body.created.find((c: { name: string }) => c.name === "Ping bravo");
    expect(bravo.config.host).toBe("10.9.0.2");
    expect(bravo.siteId).toBe(epB);
    const rules = await db.query.alertRules.findMany({ where: inArray(alertRules.checkId, res.body.created.map((c: { id: string }) => c.id)) });
    expect(rules.map((r) => r.consecutiveFailures)).toEqual([3, 3]);
  });

  it("reports targets that don't fit instead of failing the batch", async () => {
    const res = await request(app).post("/api/checks/batch").set("Cookie", cookie).send({ type: "agent_service", name: "svc", config: { serviceName: "nginx" }, targets: [{ endpointId: endpointA }, { siteId: epB }] });
    expect(res.status).toBe(201);
    expect(res.body.created).toHaveLength(1);
    expect(res.body.errors[0].error).toMatch(/endpointId/);
  });

  it("duplicates to other endpoints, staying enabled and keeping alert rules", async () => {
    const orig = await request(app).post("/api/checks").set("Cookie", cookie).send({ siteId: epA, endpointId: endpointA, name: "svc dup", type: "agent_service", config: { serviceName: "sshd" }, alertRule: { channelIds: [channelIds[channelIds.length - 1]] } });
    const dup = await request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ ids: [orig.body.id], action: "duplicate", endpointIds: [endpointB] });
    expect(dup.body.affected).toBe(1);
    const copy = await db.query.checks.findFirst({ where: eq(checks.name, "svc dup (bravo)") });
    expect(copy).toBeTruthy();
    expect(copy!.enabled).toBe(true);
    expect(copy!.endpointId).toBe(endpointB);
    expect(copy!.siteId).toBe(epB);
    expect((await db.query.alertRules.findMany({ where: eq(alertRules.checkId, copy!.id) })).length).toBe(1);

    const toSite = await request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ ids: [orig.body.id], action: "duplicate", siteIds: [epB] });
    expect(toSite.body.affected).toBe(0);
    expect(toSite.body.errors[0].error).toMatch(/endpointId/);
  });
});

describe("check page stats", () => {
  it("summarizes results and returns a bucketed series", async () => {
    const c = await request(app).post("/api/checks").set("Cookie", cookie).send({ siteId: epA, name: "stats", type: "ping", config: { host: "127.0.0.1" } });
    const now = Date.now();
    await db.insert(checkResults).values([
      { checkId: c.body.id, status: "up", latencyMs: 10, value: 1, checkedAt: new Date(now - 3_000_000) },
      { checkId: c.body.id, status: "down", latencyMs: 30, value: 3, checkedAt: new Date(now - 2_000_000) },
      { checkId: c.body.id, status: "up", latencyMs: 20, value: 2, checkedAt: new Date(now - 1_000_000) },
    ]);
    const s = (await request(app).get(`/api/checks/${c.body.id}/stats?hours=24`).set("Cookie", cookie)).body;
    expect(s.results).toBe(3);
    expect(s.uptimePercent).toBeCloseTo(66.67, 1);
    expect(s.stateChanges).toBe(2);
    expect(s.latencyMax).toBe(30);
    expect(s.series.length).toBeGreaterThan(0);
    const single = (await request(app).get(`/api/checks/${c.body.id}`).set("Cookie", cookie)).body;
    expect(single.name).toBe("stats");
  });
});

describe("IP change tracking", () => {
  it("flags a MAC seen at a new address, then settles", async () => {
    const mac = "02:00:00:00:33:01";
    await recordSighting({ mac, ip: "10.9.0.50", source: "test", endpointId: endpointA });
    const before = await probeIpChange({}, { checkId: "", endpointId: endpointA, intervalSeconds: 60, state: {} });
    expect(before.status).toBe("up");
    // Age the first sighting so the second is the newer address.
    await db.update(macIpHistory).set({ firstSeenAt: new Date(Date.now() - 3_600_000 * 48), lastSeenAt: new Date(Date.now() - 60_000) }).where(eq(macIpHistory.mac, mac));
    await recordSighting({ mac, ip: "10.9.0.77", source: "test", endpointId: endpointA });
    const after = await probeIpChange({ holdMinutes: 60 }, { checkId: "", endpointId: endpointA, intervalSeconds: 60, state: {} });
    expect(after.status).toBe("warn");
    expect(after.message).toMatch(/10\.9\.0\.50 to 10\.9\.0\.77/);
    const rows = (await request(app).get(`/api/endpoints/${endpointA}/addresses`).set("Cookie", cookie)).body;
    expect(rows.map((r: { ip: string }) => r.ip)).toEqual(expect.arrayContaining(["10.9.0.50", "10.9.0.77"]));
  });
});

describe("smart suggestions", () => {
  it("suggests from services, processes, containers and listening ports", () => {
    const sug = suggestChecks(
      {
        name: "web1",
        hostname: "10.0.0.10",
        os: "Ubuntu 24.04",
        inventory: null,
        availableServices: null,
        serviceInventory: [
          { name: "nginx", state: "active/running", startType: "enabled" },
          { name: "postgresql", state: "active/running", startType: "enabled" },
          { name: "bluetooth", state: "active/running", startType: "enabled" },
          { name: "redis-server", state: "inactive/dead", startType: "disabled" },
        ],
        processInventory: [{ name: "postgres", memoryMb: 200 }, { name: "jellyfin", memoryMb: 300 }],
        lastSnapshot: { listening: [{ port: 443, proto: "tcp", address: "0.0.0.0", process: "nginx" }, { port: 5432, proto: "tcp", address: "127.0.0.1" }], availableContainers: ["app", "db"], cpu: { percent: 5 } },
      },
      []
    );
    const names = sug.map((s) => s.name);
    expect(names).toContain("web1: service nginx");
    expect(names).toContain("web1: service postgresql");
    expect(names).not.toContain("web1: service bluetooth");
    expect(names).not.toContain("web1: service redis-server");
    expect(names).toContain("web1: process jellyfin");
    expect(names).toContain("web1: postgres memory");
    expect(names).toContain("web1: container db");
    expect(names).toContain("web1: web (HTTPS) reachable");
    expect(names).toContain("web1: TLS certificate reachable");
    // 5432 is only on loopback — nothing to check from the network.
    expect(names).not.toContain("web1: PostgreSQL port reachable");
    expect(sug.find((s) => s.name === "web1: web (HTTPS) reachable")!.config.url).toBe("https://10.0.0.10/");
    expect(new Set(sug.map((s) => s.key)).size).toBe(sug.length);
  });
});

describe("Express 5", () => {
  it("forwards errors thrown in async handlers to the error handler (no express-async-errors)", async () => {
    // An invalid uuid makes Postgres throw inside an async route.
    const res = await request(app).get("/api/checks/not-a-uuid/stats").set("Cookie", cookie).timeout(5000);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Internal server error");
  });
  it("still 404s unknown routes and parses JSON bodies", async () => {
    expect((await request(app).get("/api/does-not-exist").set("Cookie", cookie)).status).toBe(404);
    const r = await request(app).post("/api/locations").set("Cookie", cookie).send({});
    expect(r.status).toBe(400);
  });
});

describe("watchdog (outbound dead man's switch)", () => {
  it("keeps the ping URL write-only, refuses to enable without one, and pings a real receiver", async () => {
    const { db: database } = await import("../src/db/index.js");
    const { watchdogSettings } = await import("../src/db/schema.js");
    await database.delete(watchdogSettings);
    const off = await request(app).patch("/api/watchdog").set("Cookie", cookie).send({ enabled: true });
    expect(off.status).toBe(400);
    expect((await request(app).patch("/api/watchdog").set("Cookie", cookie).send({ url: "ftp://nope" })).status).toBe(400);

    const saved = await request(app).patch("/api/watchdog").set("Cookie", cookie).send({ url: `${hookBase}/ping/secret-uuid-123`, intervalSeconds: 5, enabled: true });
    expect(saved.status).toBe(200);
    expect(saved.body.urlSet).toBe(true);
    expect(saved.body.intervalSeconds).toBe(30);
    expect(JSON.stringify(saved.body)).not.toContain("secret-uuid-123");
    expect(saved.body.selfCheck.ok).toBe(true);

    received.length = 0;
    const t = await request(app).post("/api/watchdog/test").set("Cookie", cookie);
    expect(t.status).toBe(200);
    expect(t.body.healthy).toBe(true);
    expect(received.some((r) => r.path === "/ping/secret-uuid-123")).toBe(true);
    const after = (await request(app).get("/api/watchdog").set("Cookie", cookie)).body;
    expect(after.lastResult).toMatch(/healthy/);
    await database.delete(watchdogSettings);
  });
});
