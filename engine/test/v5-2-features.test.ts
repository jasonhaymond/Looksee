// Tests for the 5.2 features, each against the real API and a real test
// database where the feature has an API: multi-site collectors and site
// address ranges, custom scripts run by another endpoint's agent, the script
// check's warn/down output patterns, SNMP row exclusions, the DNS zone
// history check (against a small fake DNS server), the local user accounts
// check, the folder-tree check's growth figures, and the Android installer.
// Each test says what behavior (or attack) it proves.

import "dotenv/config";
import net from "node:net";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, events, sites, users } from "../src/db/schema.js";
import { cleanRanges, parseRange, siteForAddress } from "../src/services/siteNetworks.js";
import { evaluateScriptOutput } from "../src/services/scriptOutput.js";
import { evaluateUserAccounts } from "../src/services/userAccounts.js";
import { SNMP_PRESETS, rowExcluded } from "../src/services/probes/snmp.js";
import { kindsForType } from "../src/services/probes/exclude.js";
import { buildAxfrQuery, diffZone, encodeName, probeDnsZone, readName } from "../src/services/probes/dnsZone.js";
import { MASK } from "../src/lib/secrets.js";

const email = `test-v52-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
const auth = () => ({ Cookie: cookie });
const createdSites: string[] = [];

/** A site for this test file (deleted afterwards with everything in it). */
async function makeSite(extra: Partial<typeof sites.$inferInsert> = {}) {
  const [site] = await db.insert(sites).values({ name: `test-v52-${crypto.randomUUID()}`, ...extra }).returning();
  createdSites.push(site.id);
  return site;
}

/** An endpoint with an agent key, reporting as agent `version`. */
async function makeAgent(siteId: string, version = "5.2.0") {
  const [ep] = await db.insert(endpoints).values({ siteId, name: `test-agent-${crypto.randomUUID().slice(0, 6)}`, agentVersion: version }).returning();
  const key = (await request(app).post(`/api/endpoints/${ep.id}/agent-key`).set(auth())).body.agentApiKey as string;
  await db.update(endpoints).set({ agentVersion: version }).where(eq(endpoints.id, ep.id));
  return { id: ep.id, auth: { Authorization: `Bearer ${key}` } };
}

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
});

afterAll(async () => {
  await db.delete(sites).where(inArray(sites.id, createdSites));
  await db.delete(users).where(eq(users.email, email));
});

// ---- Site address ranges and multi-site collectors ---------------------------

describe("site address ranges", () => {
  // Proves only real CIDR ranges are accepted — a typo can't silently
  // misfile events.
  it("parses and validates CIDR ranges", () => {
    expect(parseRange("10.20.0.0/24")).toEqual({ family: "ipv4", address: "10.20.0.0", prefix: 24 });
    expect(parseRange("fd00::/64")?.family).toBe("ipv6");
    expect(parseRange("10.0.0.5")?.prefix).toBe(32);
    for (const bad of ["10.0.0.0/33", "10.0.0/24", "10.0.0.0/24/1", "10.0.0.0/-1", "10.0.0.0/2x", "example.com/24", ""]) expect(parseRange(bad)).toBeNull();
    expect(cleanRanges("10.0.0.0/24, 10.0.0.0/24\n192.168.1.0/24")).toEqual({ ranges: ["10.0.0.0/24", "192.168.1.0/24"] });
    expect("error" in cleanRanges("10.0.0.0/24, nope")).toBe(true);
  });

  // Proves the most specific range wins when ranges overlap, IPv4-mapped
  // IPv6 senders match IPv4 ranges, and unknown senders match nothing.
  it("finds the site an address belongs to", () => {
    const list = [
      { id: "wide", networks: ["10.0.0.0/8"] },
      { id: "narrow", networks: ["10.20.30.0/24"] },
      { id: "v6", networks: ["fd00:1::/64"] },
    ];
    expect(siteForAddress("10.20.30.5", list)).toBe("narrow");
    expect(siteForAddress("10.99.0.1", list)).toBe("wide");
    expect(siteForAddress("::ffff:10.20.30.5", list)).toBe("narrow");
    expect(siteForAddress("fd00:1::abcd", list)).toBe("v6");
    expect(siteForAddress("192.0.2.1", list)).toBeNull();
    expect(siteForAddress("not-an-ip", list)).toBeNull();
  });

  // Proves the API stores ranges and refuses malformed ones (400, not a
  // database error).
  it("saves ranges through the sites API and rejects bad ones", async () => {
    const site = await makeSite();
    const ok = await request(app).patch(`/api/sites/${site.id}`).set(auth()).send({ networks: "10.50.0.0/24, 10.50.1.0/24" });
    expect(ok.status).toBe(200);
    expect(ok.body.networks).toEqual(["10.50.0.0/24", "10.50.1.0/24"]);
    const bad = await request(app).patch(`/api/sites/${site.id}`).set(auth()).send({ networks: ["10.50.0.0/99"] });
    expect(bad.status).toBe(400);
  });
});

describe("one agent as the collector for several sites", () => {
  let siteA: string;
  let siteB: string;
  let agent: Awaited<ReturnType<typeof makeAgent>>;

  beforeAll(async () => {
    siteA = (await makeSite({ networks: ["10.61.0.0/24"] })).id;
    siteB = (await makeSite({ networks: ["10.62.0.0/24"] })).id;
    agent = await makeAgent(siteA);
  });

  // Proves the endpoint route is admin-only: without a session it's refused.
  it("requires a signed-in session", async () => {
    expect((await request(app).put(`/api/endpoints/${agent.id}/collector-sites`).send({ siteIds: [siteA] })).status).toBe(401);
  });

  // Proves an endpoint without an agent can't be made a collector, and that
  // unknown or malformed site IDs are refused instead of half-applied.
  it("refuses endpoints without an agent and unknown sites", async () => {
    const [bare] = await db.insert(endpoints).values({ siteId: siteA, name: "test-no-agent" }).returning();
    expect((await request(app).put(`/api/endpoints/${bare.id}/collector-sites`).set(auth()).send({ siteIds: [siteA] })).status).toBe(400);
    expect((await request(app).put(`/api/endpoints/${agent.id}/collector-sites`).set(auth()).send({ siteIds: [siteA, crypto.randomUUID()] })).status).toBe(400);
    expect((await request(app).put(`/api/endpoints/${agent.id}/collector-sites`).set(auth()).send({ siteIds: ["'; drop table sites; --"] })).status).toBe(400);
  });

  // Proves one agent collects for both sites: its collector config holds
  // both sites' checks, and the agent is told to run the collector.
  it("assigns both sites and hands out both sites' checks", async () => {
    const res = await request(app).put(`/api/endpoints/${agent.id}/collector-sites`).set(auth()).send({ siteIds: [siteA, siteB] });
    expect(res.status).toBe(200);
    expect(res.body.map((s: { id: string }) => s.id).sort()).toEqual([siteA, siteB].sort());
    const a = await request(app).post("/api/checks").set(auth()).send({ siteId: siteA, name: "ping-a", type: "ping", config: { host: "10.61.0.1" } });
    const b = await request(app).post("/api/checks").set(auth()).send({ siteId: siteB, name: "ping-b", type: "ping", config: { host: "10.62.0.1" } });
    const cfg = await request(app).get("/api/collector/config").set(agent.auth);
    expect(cfg.status).toBe(200);
    const ids = cfg.body.checks.map((c: { id: string }) => c.id);
    expect(ids).toContain(a.body.id);
    expect(ids).toContain(b.body.id);
    expect(cfg.body.sites).toHaveLength(2);
  });

  // Proves received events are filed under the site whose range holds the
  // sender, and a sender in neither range goes to the first site.
  it("files each received event under the right site", async () => {
    const tag = crypto.randomUUID();
    const ev = (ip: string) => ({ source: "syslog", sourceIp: ip, severity: 3, message: `${tag} from ${ip}`, receivedAt: new Date().toISOString() });
    const res = await request(app).post("/api/collector/events").set(agent.auth).send({ events: [ev("10.61.0.9"), ev("10.62.0.9"), ev("192.0.2.9")] });
    expect(res.status).toBe(200);
    const rows = await db.query.events.findMany({ where: inArray(events.siteId, [siteA, siteB]) });
    const mine = rows.filter((r) => r.message.startsWith(tag));
    const siteOf = (ip: string) => mine.find((r) => r.sourceIp === ip)?.siteId;
    expect(siteOf("10.61.0.9")).toBe(siteA);
    expect(siteOf("10.62.0.9")).toBe(siteB);
    // siteA was created first, so it's the collector's first site.
    expect(siteOf("192.0.2.9")).toBe(siteA);
  });

  // Proves unticking a site hands it back to the engine.
  it("releases sites that are no longer chosen", async () => {
    const res = await request(app).put(`/api/endpoints/${agent.id}/collector-sites`).set(auth()).send({ siteIds: [siteB] });
    expect(res.status).toBe(200);
    expect((await db.query.sites.findFirst({ where: eq(sites.id, siteA) }))?.collectorEndpointId).toBeNull();
    expect((await db.query.sites.findFirst({ where: eq(sites.id, siteB) }))?.collectorEndpointId).toBe(agent.id);
  });
});

// ---- Custom scripts run by another endpoint's agent ---------------------------

describe("custom script run by another agent", () => {
  let siteId: string;
  let owner: Awaited<ReturnType<typeof makeAgent>>;
  let runner: Awaited<ReturnType<typeof makeAgent>>;
  let checkId: string;

  beforeAll(async () => {
    siteId = (await makeSite()).id;
    owner = await makeAgent(siteId);
    runner = await makeAgent(siteId);
    const res = await request(app)
      .post("/api/checks")
      .set(auth())
      .send({ siteId, endpointId: owner.id, probeEndpointId: runner.id, name: "printer-script", type: "agent_script", config: { script: "check_printer.sh", downIfMatches: "JAMMED" } });
    expect(res.status).toBe(201);
    checkId = res.body.id;
  });

  // Proves only remote probes and scripts may be pinned to another agent —
  // e.g. an OS service check can't be moved off its own endpoint.
  it("refuses pinning other agent check types", async () => {
    const res = await request(app).post("/api/checks").set(auth()).send({ siteId, endpointId: owner.id, probeEndpointId: runner.id, name: "svc", type: "agent_service", config: { serviceName: "x" } });
    expect(res.status).toBe(400);
  });

  // Proves the script goes to the runner's agent, not the owner's.
  it("hands the script to the runner, not the owner", async () => {
    const ownerCfg = await request(app).get("/api/agent/config").set(owner.auth);
    const runnerCfg = await request(app).get("/api/agent/config").set(runner.auth);
    expect(ownerCfg.body.checks.map((c: { id: string }) => c.id)).not.toContain(checkId);
    expect(runnerCfg.body.checks.map((c: { id: string }) => c.id)).toContain(checkId);
  });

  // Proves only the assigned runner can report the result: the owner's key
  // (or any other agent's) can't write it — and the runner's report goes
  // through the engine's output patterns (JAMMED → down).
  it("accepts the result only from the runner", async () => {
    const result = { checkId, status: "up", message: "ok", details: { output: "Printer JAMMED in tray 2", exitCode: 0 } };
    await request(app).post("/api/agent/report").set(owner.auth).send({ version: "5.2.0", results: [{ ...result, details: { output: "fine", exitCode: 0 } }] });
    let row = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
    expect(row?.lastStatus).toBeNull();
    await request(app).post("/api/agent/report").set(runner.auth).send({ version: "5.2.0", results: [result] });
    row = await db.query.checks.findFirst({ where: eq(checks.id, checkId) });
    expect(row?.lastStatus).toBe("down");
    expect(row?.lastMessage).toContain("JAMMED");
  });
});

// ---- Script output warn/down patterns -----------------------------------------

describe("script output warn/down patterns", () => {
  const base = { status: "up" as const, message: "ok", latencyMs: null };
  const out = (output: string, exitCode = 0) => ({ ...base, details: { output, exitCode } });

  // Proves the down pattern wins over the warn pattern, and that a plain
  // pattern is matched as text.
  it("down beats warn; text match", () => {
    const cfg = { warnIfMatches: "DEGRADED", downIfMatches: "FAILED" };
    expect(evaluateScriptOutput(cfg, out("pool DEGRADED"))?.status).toBe("warn");
    expect(evaluateScriptOutput(cfg, out("pool DEGRADED, disk FAILED"))?.status).toBe("down");
    expect(evaluateScriptOutput(cfg, out("all good"))?.status).toBe("up");
  });

  // Proves regex mode and ignore-case work, and an invalid regex is a warn
  // with a clear message rather than an engine error.
  it("regex, ignore case and invalid patterns", () => {
    expect(evaluateScriptOutput({ downIfMatches: "errors?: [1-9]", alertMatchMode: "regex" }, out("errors: 3"))?.status).toBe("down");
    expect(evaluateScriptOutput({ warnIfMatches: "warning", alertIgnoreCase: true }, out("WARNING low disk"))?.status).toBe("warn");
    expect(evaluateScriptOutput({ warnIfMatches: "warning" }, out("WARNING low disk"))?.status).toBe("up");
    const bad = evaluateScriptOutput({ downIfMatches: "(", alertMatchMode: "regex" }, out("x"));
    expect(bad?.status).toBe("warn");
    expect(bad?.message).toContain("Invalid alert pattern");
  });

  // Proves the worse of expected-output and pattern results wins, and that
  // a pattern on its own works without an expected output.
  it("combines with expected output", () => {
    const cfg = { expectMode: "contains", expectText: "OK", expectSeverity: "warn", downIfMatches: "PANIC" };
    expect(evaluateScriptOutput(cfg, out("OK"))?.status).toBe("up");
    expect(evaluateScriptOutput(cfg, out("nope"))?.status).toBe("warn");
    expect(evaluateScriptOutput(cfg, out("OK but PANIC"))?.status).toBe("down");
    // Neither setting: the agent's exit-code verdict stands.
    expect(evaluateScriptOutput({}, out("x"))).toBeNull();
  });
});

// ---- SNMP exclusions ------------------------------------------------------------

/**
 * A stand-in SNMP session for template tests: subtree() feeds the given
 * rows (OID → value) under the requested OID, as net-snmp does.
 */
function fakeSession(rows: Record<string, unknown>) {
  return {
    subtree(oid: string, _max: number, feed: (vbs: { oid: string; type: number; value: unknown }[]) => void, done: (err?: Error) => void) {
      feed(Object.entries(rows).filter(([k]) => k.startsWith(`${oid}.`)).map(([k, v]) => ({ oid: k, type: typeof v === "number" ? 2 : 4, value: typeof v === "string" ? Buffer.from(v) : v })));
      done();
    },
  } as unknown as Parameters<(typeof SNMP_PRESETS)["hr_storage"]>[0];
}

describe("SNMP row and value exclusions", () => {
  // Proves the new exclusion kind applies to SNMP checks, so reusable lists
  // on the Exclusions page reach them.
  it("is a kind the SNMP check uses", async () => {
    expect(kindsForType("snmp")).toContain("snmp_values");
    const res = await request(app).post("/api/exclusion-lists").set(auth()).send({ name: `snmp-${crypto.randomUUID()}`, kind: "snmp_values", items: ["Virtual Memory"] });
    expect(res.status).toBe(201);
    await request(app).delete(`/api/exclusion-lists/${res.body.id}`).set(auth());
  });

  // Proves rows match by index, name or value with wildcards, ignoring case.
  it("matches index, name and value", () => {
    const cfg = { exclude: "1.5\n/run*\nWASTE*" };
    expect(rowExcluded(cfg, "1.5")).toBe(true);
    expect(rowExcluded(cfg, "1.6", "/run/user")).toBe(true);
    expect(rowExcluded(cfg, "2", "Waste toner box")).toBe(true);
    expect(rowExcluded(cfg, "2", "Black toner")).toBe(false);
    expect(rowExcluded({}, "1.5")).toBe(false);
  });

  // Proves a template skips excluded disks: without the exclusion the
  // fullest disk is /run (99%); with it, / (50%).
  it("leaves excluded disks out of the storage template", async () => {
    const base = "1.3.6.1.2.1.25.2.3.1";
    const fixed = "1.3.6.1.2.1.25.2.1.4";
    const rows = { [`${base}.2.1`]: fixed, [`${base}.3.1`]: "/", [`${base}.5.1`]: 100, [`${base}.6.1`]: 50, [`${base}.2.2`]: fixed, [`${base}.3.2`]: "/run", [`${base}.5.2`]: 100, [`${base}.6.2`]: 99 };
    const ctx = { checkId: "", endpointId: null, intervalSeconds: 60, state: {} };
    expect((await SNMP_PRESETS.hr_storage(fakeSession(rows), {}, ctx)).value).toBe(99);
    expect((await SNMP_PRESETS.hr_storage(fakeSession(rows), { exclude: "/run*" }, ctx)).value).toBe(50);
  });
});

// ---- DNS zone history -------------------------------------------------------------

/** One resource record in wire format (name uncompressed, class IN). */
function rr(name: string, type: number, ttl: number, rdata: Buffer) {
  const head = Buffer.alloc(10);
  head.writeUInt16BE(type, 0);
  head.writeUInt16BE(1, 2);
  head.writeUInt32BE(ttl, 4);
  head.writeUInt16BE(rdata.length, 8);
  return Buffer.concat([encodeName(name), head, rdata]);
}
const soa = (serial: number) => {
  const nums = Buffer.alloc(20);
  [serial, 3600, 600, 86400, 300].forEach((n, i) => nums.writeUInt32BE(n, i * 4));
  return Buffer.concat([encodeName("ns1.example.test"), encodeName("hostmaster.example.test"), nums]);
};
const a = (ip: string) => Buffer.from(ip.split(".").map(Number));
const txt = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);

/**
 * A fake authoritative server: answers an AXFR query for example.test with
 * the given records between two SOA records, or with `rcode` when set.
 */
function fakeDnsServer(zone: () => Buffer[], rcode = 0): Promise<{ port: number; close: () => void; lastQuery: () => Buffer | null }> {
  let last: Buffer | null = null;
  return new Promise((resolve) => {
    const server = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 2 || buf.length < 2 + buf.readUInt16BE(0)) return;
        const query = buf.subarray(2, 2 + buf.readUInt16BE(0));
        last = Buffer.from(query);
        const id = query.readUInt16BE(0);
        const question = query.subarray(12, 12 + encodeName("example.test").length + 4);
        const answers = rcode ? [] : zone();
        const header = Buffer.alloc(12);
        header.writeUInt16BE(id, 0);
        header.writeUInt16BE(0x8400 | rcode, 2);
        header.writeUInt16BE(1, 4);
        header.writeUInt16BE(answers.length, 6);
        const msg = Buffer.concat([header, question, ...answers]);
        const len = Buffer.alloc(2);
        len.writeUInt16BE(msg.length, 0);
        sock.end(Buffer.concat([len, msg]));
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ port: (server.address() as net.AddressInfo).port, close: () => server.close(), lastQuery: () => last }));
  });
}

describe("DNS zone history", () => {
  // Proves a crafted message with a compression pointer loop is rejected
  // instead of hanging the engine.
  it("rejects compression pointer loops", () => {
    const msg = Buffer.from([0xc0, 0x00]);
    expect(() => readName(msg, 0)).toThrow(/pointer/);
    const forward = Buffer.from([0xc0, 0x05, 0, 0, 0, 3, 0x61, 0x62, 0x63, 0]);
    expect(() => readName(forward, 0)).toThrow(/pointer/);
  });

  // Proves a single replaced value is one "changed" entry, and TTL-only
  // changes are reported only when asked for.
  it("diffs inventories", () => {
    const prev = { "www\tA\t192.0.2.1": 300, "mail\tA\t192.0.2.2": 300 };
    const recs = [
      { name: "www", type: "A", ttl: 300, value: "192.0.2.9" },
      { name: "mail", type: "A", ttl: 60, value: "192.0.2.2" },
      { name: "new", type: "TXT", ttl: 300, value: '"x"' },
    ];
    const changes = diffZone(prev, recs, false);
    expect(changes).toContainEqual({ change: "changed", name: "www", type: "A", value: "192.0.2.9", previous: "192.0.2.1" });
    expect(changes).toContainEqual({ change: "added", name: "new", type: "TXT", value: '"x"' });
    expect(changes.some((c) => c.change === "ttl")).toBe(false);
    expect(diffZone(prev, recs, true).some((c) => c.change === "ttl" && c.name === "mail")).toBe(true);
  });

  // Proves a TSIG-signed request carries a TSIG record whose MAC is the
  // HMAC-SHA256 of the request and TSIG variables (RFC 8945), computed here
  // independently.
  it("signs transfer requests with TSIG", () => {
    const secret = crypto.randomBytes(32).toString("base64");
    const now = 1_800_000_000_000;
    const q = buildAxfrQuery("example.test", 0x1234, { name: "looksee", algorithm: "hmac-sha256", keyBase64: secret }, now);
    expect(q.readUInt16BE(10)).toBe(1); // one additional record: the TSIG
    const unsigned = buildAxfrQuery("example.test", 0x1234);
    const time = Buffer.alloc(6);
    time.writeUInt32BE(Math.floor(now / 1000), 2);
    const vars = Buffer.concat([encodeName("looksee"), Buffer.from([0, 0xff, 0, 0, 0, 0]), encodeName("hmac-sha256"), time, Buffer.from([0x01, 0x2c]), Buffer.from([0, 0, 0, 0])]);
    const mac = crypto.createHmac("sha256", Buffer.from(secret, "base64")).update(Buffer.concat([unsigned, vars])).digest();
    expect(q.includes(mac)).toBe(true);
  });

  // Proves the whole flow against a server: the first run records a
  // baseline, an edit is reported with what changed (and the SOA serial
  // bump isn't), the status is held, and history accumulates.
  it("records a baseline, then reports changes", async () => {
    let records = [rr("www.example.test", 1, 300, a("192.0.2.1")), rr("example.test", 16, 300, txt("v=spf1 -all"))];
    let serial = 1;
    const srv = await fakeDnsServer(() => [rr("example.test", 6, 3600, soa(serial)), ...records, rr("example.test", 6, 3600, soa(serial))]);
    try {
      const config = { zone: "example.test", server: `127.0.0.1:${srv.port}` };
      const ctx = { checkId: "", endpointId: null, intervalSeconds: 3600, state: {} as Record<string, unknown> };
      const first = await probeDnsZone(config, ctx);
      expect(first.status).toBe("up");
      expect(first.message).toContain("Baseline");
      expect(first.value).toBe(2);
      ctx.state = first.state!;

      records = [rr("www.example.test", 1, 300, a("192.0.2.66")), rr("example.test", 16, 300, txt("v=spf1 -all")), rr("evil.example.test", 1, 60, a("203.0.113.5"))];
      serial = 2;
      const second = await probeDnsZone(config, ctx);
      expect(second.status).toBe("warn");
      expect(second.message).toContain("changed www A 192.0.2.1 → 192.0.2.66");
      expect(second.message).toContain("added evil A 203.0.113.5");
      const changes = (second.details as { changes: { type: string }[] }).changes;
      expect(changes.some((c) => c.type === "SOA")).toBe(false);
      ctx.state = second.state!;

      const third = await probeDnsZone(config, ctx);
      expect(third.status).toBe("warn"); // held for holdMinutes
      expect((third.state!.history as unknown[]).length).toBe(2);
    } finally {
      srv.close();
    }
  });

  // Proves a refused transfer is down with a message saying why.
  it("reports a refused transfer", async () => {
    const srv = await fakeDnsServer(() => [], 5);
    try {
      const res = await probeDnsZone({ zone: "example.test", server: `127.0.0.1:${srv.port}` }, { checkId: "", endpointId: null, intervalSeconds: 60, state: {} });
      expect(res.status).toBe("down");
      expect(res.message).toContain("REFUSED");
    } finally {
      srv.close();
    }
  });

  // Proves a transfer that doesn't start with the zone's SOA is rejected.
  it("rejects a transfer without a leading SOA", async () => {
    const srv = await fakeDnsServer(() => [rr("www.example.test", 1, 300, a("192.0.2.1"))]);
    try {
      const res = await probeDnsZone({ zone: "example.test", server: `127.0.0.1:${srv.port}` }, { checkId: "", endpointId: null, intervalSeconds: 60, state: {} });
      expect(res.status).toBe("down");
      expect(res.message).toContain("SOA");
    } finally {
      srv.close();
    }
  });

  // Proves the TSIG secret is write-only: the API never returns it.
  it("never returns the TSIG secret", async () => {
    const site = await makeSite();
    const res = await request(app).post("/api/checks").set(auth()).send({ siteId: site.id, name: "zone", type: "dns_zone", config: { zone: "example.test", server: "10.0.0.53", tsigName: "k", tsigSecret: "c2VjcmV0" } });
    expect(res.status).toBe(201);
    expect(res.body.config.tsigSecret).toBe(MASK);
    expect((await request(app).get(`/api/checks/${res.body.id}`).set(auth())).body.config.tsigSecret).toBe(MASK);
  });
});

// ---- Local user accounts ------------------------------------------------------------

describe("local user accounts", () => {
  const result = (list: unknown[]) => ({ status: "up" as const, message: "", latencyMs: null, details: { users: list } });
  const alice = { name: "alice", uid: "1000", enabled: true, admin: false };
  const daemon = { name: "daemon", uid: "1", system: true, admin: false };

  // Proves the first report only records a baseline, a new account is a
  // warn, and system accounts are ignored unless included.
  it("baseline, then new accounts", () => {
    const first = evaluateUserAccounts({}, {}, result([alice, daemon]));
    expect(first.result.status).toBe("up");
    expect(first.result.value).toBe(1);
    const second = evaluateUserAccounts({}, first.state, result([alice, daemon, { name: "mallory", uid: "1001", enabled: true, admin: false }]));
    expect(second.result.status).toBe("warn");
    expect(second.result.message).toContain("added mallory");
  });

  // Proves gaining admin rights uses the admin severity (down by default),
  // and a password change is reported without any password data.
  it("admin rights and password changes", () => {
    const base = evaluateUserAccounts({}, {}, result([{ ...alice, passwordLastSet: "2026-01-01" }]));
    const promoted = evaluateUserAccounts({}, base.state, result([{ ...alice, admin: true, passwordLastSet: "2026-10-26" }]));
    expect(promoted.result.status).toBe("down");
    expect(promoted.result.message).toContain("admin: no → yes");
    expect(promoted.result.message).toContain("password changed");
  });

  // Proves excluded names and the "watch" choice are honoured, and removed
  // accounts are reported.
  it("exclusions, watch choice, removals", () => {
    const base = evaluateUserAccounts({ exclude: "tmp-*" }, {}, result([alice, { name: "bob", uid: "1002" }]));
    const next = evaluateUserAccounts({ exclude: "tmp-*", watch: "removed" }, base.state, result([alice, { name: "tmp-1", uid: "1003" }]));
    expect(next.result.status).toBe("warn");
    expect(next.result.message).toContain("removed bob");
    expect(next.result.message).not.toContain("tmp-1");
  });

  // Proves malformed agent data is ignored rather than stored.
  it("ignores malformed lists", () => {
    const res = evaluateUserAccounts({}, {}, { status: "unknown" as const, message: "no list", latencyMs: null, details: { users: "nope" } });
    expect(res.result.status).toBe("unknown");
    expect(res.state).toEqual({});
  });

  // Proves the check runs through the real agent API and keeps its state,
  // and that agents older than 5.2.0 aren't sent it.
  it("works end to end through the agent API", async () => {
    const siteId = (await makeSite()).id;
    const agent = await makeAgent(siteId, "5.2.0");
    const old = await makeAgent(siteId, "5.1.0");
    const check = (await request(app).post("/api/checks").set(auth()).send({ siteId, endpointId: agent.id, name: "users", type: "agent_users", config: {} })).body;
    const oldCheck = (await request(app).post("/api/checks").set(auth()).send({ siteId, endpointId: old.id, name: "users-old", type: "agent_users", config: {} })).body;
    expect((await request(app).get("/api/agent/config").set(agent.auth)).body.checks.map((c: { id: string }) => c.id)).toContain(check.id);
    expect((await request(app).get("/api/agent/config").set(old.auth)).body.checks.map((c: { id: string }) => c.id)).not.toContain(oldCheck.id);
    const send = (list: unknown[]) => request(app).post("/api/agent/report").set(agent.auth).send({ version: "5.2.0", results: [{ checkId: check.id, status: "up", details: { users: list } }] });
    await send([alice]);
    await send([alice, { name: "eve", uid: "1005", admin: true }]);
    const row = await db.query.checks.findFirst({ where: eq(checks.id, check.id) });
    expect(row?.lastStatus).toBe("down");
    expect(row?.lastMessage).toContain("added eve");
  });
});

// ---- Largest folders and files --------------------------------------------------------

describe("largest folders and files", () => {
  // Proves the engine adds how much each folder grew since the last scan.
  it("adds growth since the previous scan", async () => {
    const siteId = (await makeSite()).id;
    const agent = await makeAgent(siteId);
    const check = (await request(app).post("/api/checks").set(auth()).send({ siteId, endpointId: agent.id, name: "tree", type: "agent_disk_tree", config: {} })).body;
    const send = (gb: number) => request(app).post("/api/agent/report").set(agent.auth).send({ version: "5.2.0", results: [{ checkId: check.id, status: "up", value: gb, details: { rows: [{ disk: "/", kind: "folder", path: "/var/log", sizeGb: gb }], disks: [] } }] });
    await send(1.5);
    await send(4);
    const res = await request(app).get(`/api/checks/${check.id}/results?limit=1`).set(auth());
    const latest = (res.body.results ?? res.body)[0];
    expect(latest.details.rows[0].grewGb).toBe(2.5);
  });
});

// ---- Android installer -------------------------------------------------------------

describe("Android agent install", () => {
  // Proves the installer is served and the install command for Android is
  // offered alongside Linux/macOS and Windows.
  it("serves the Termux installer and its command", async () => {
    const script = await request(app).get("/install/agent-android.sh");
    expect(script.status).toBe(200);
    expect(script.text).toContain("Termux");
    const siteId = (await makeSite()).id;
    const [ep] = await db.insert(endpoints).values({ siteId, name: "phone" }).returning();
    const key = await request(app).post(`/api/endpoints/${ep.id}/agent-key`).set(auth());
    expect(key.body.installCommands.android).toMatch(/agent-android\.sh \| bash -s -- \S+ [0-9a-f]+$/);
  });
});
