// Agent check-in resilience (5.1): data from the machine that the database
// can't store must never make a running agent look offline, and every way a
// report can fail must leave a trace that says which endpoint it was.
//
// Background: a Windows printer-driver uninstaller (SHARP Driver Uninstall
// Tool) writes its display name padded with NUL characters. PostgreSQL
// rejects those in jsonb, the agent report's single database update failed,
// and affected endpoints never showed as checked in.
//
// Runs against the real local test database (README → Local development).
// Requests carry X-Forwarded-For addresses from 203.0.113.0/24 (reserved for
// documentation) so blocks made here never touch other test files'
// addresses. Everything created is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// A stand-in for "some value in a report that the database rejects": when a
// report's watchdogStatus carries injectNul, the cleaned status handed to the
// database gets a NUL character slipped in *after* the engine's cleaning — as
// if a future field had been missed. PostgreSQL then really rejects the
// endpoint update, exactly as it did in the field. (vi.mock replaces the
// module for this test file only; every other call uses the real function.)
// Done this way rather than with a database trigger on the shared endpoints
// table, whose table locks could stall or deadlock other test files running
// at the same time.
vi.mock("../src/services/watchdogAgents.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/services/watchdogAgents.js")>();
  return {
    ...real,
    cleanWatchdogStatus: (raw: unknown) =>
      raw && typeof raw === "object" && (raw as { injectNul?: unknown }).injectNul ? { lastError: "bad\u0000value" } : real.cleanWatchdogStatus(raw),
  };
});
import request from "supertest";
import bcrypt from "bcryptjs";
import { and, eq, inArray, sql } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { endpoints, ipBlocks, logs, securityEvents, sites, users } from "../src/db/schema.js";
import { cleanString, stripNul, truncate } from "../src/lib/stripNul.js";
import { describeError } from "../src/lib/errorDetail.js";

const email = `test-resilience-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
const NUL = "\u0000";
let cookie: string;
let siteId: string;
let endpointId: string;
let agentKey: string;
const usedIps: string[] = [];
let nextHost = Math.floor(Math.random() * 200);
// A fresh documentation-range address per call (see the file comment).
const ip = () => {
  const a = `203.0.113.${20 + (nextHost++ % 200)}`;
  usedIps.push(a);
  return a;
};
const agentIp = ip();

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `resilience-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "laptop-under-test", hostname: "laptop-test" }).returning())[0].id;
  agentKey = (await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie)).body.agentApiKey;
});

afterAll(async () => {
  await db.delete(logs).where(sql`${logs.metadata} ->> 'endpointId' = ${endpointId}`);
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
  await db.delete(ipBlocks).where(inArray(ipBlocks.ip, usedIps));
  await db.delete(securityEvents).where(inArray(securityEvents.ip, usedIps));
});

/**
 * Re-runs `read` until it returns a non-empty list or ~3 s pass. Log entries
 * are written in the background (lib/logger.ts never makes a request wait
 * for its log line), so they can land just after the response.
 */
async function eventually<T>(read: () => Promise<T[]>): Promise<T[]> {
  for (let i = 0; i < 30; i++) {
    const rows = await read();
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return read();
}

const auth = () => ({ Authorization: `Bearer ${agentKey}`, "X-Forwarded-For": agentIp });
const row = async () => (await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) }))!;

describe("NUL characters in agent data", () => {
  // Proves the exact failure seen in the field is fixed: a report whose
  // software list has a name padded with NULs (plus NULs in an inventory
  // value and an inventory key) is accepted, the endpoint is checked in, and
  // nothing stored contains a NUL.
  it("accepts a report with NULs and stores none of them", async () => {
    const before = new Date();
    const res = await request(app)
      .post("/api/agent/report")
      .set(auth())
      .send({
        version: "5.0.0",
        metrics: { cpuPercent: 1, memPercent: 2, diskPercent: 3, netRxBytes: 0, netTxBytes: 0 },
        inventory: { model: `Latitude${NUL}${NUL}`, [`serial${NUL}`]: "ABC123" },
        software: { collectedAt: Date.now(), packages: [{ n: `SHARP Driver Uninstall Tool${NUL.repeat(170)}`, v: "1.2.1.11", s: "windows" }], upgradable: [] },
      });
    expect(res.status).toBe(200);
    const ep = await row();
    expect(ep.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(ep.agentVersion).toBe("5.0.0");
    expect(ep.inventory).toEqual({ model: "Latitude", serial: "ABC123" });
    const pkgs = (ep.software as { packages: { n: string }[] }).packages;
    expect(pkgs[0].n).toBe("SHARP Driver Uninstall Tool");
    expect(JSON.stringify([ep.inventory, ep.software])).not.toContain("\\u0000");
    expect(ep.lastReportError).toBeNull();
  });

  // Proves a site collector's posted results are cleaned the same way (the
  // stripping is on every request body, not only the agent report).
  it("cleans every request body, including object keys and nested arrays", () => {
    expect(stripNul({ [`a${NUL}`]: [`x${NUL}`, { b: `y${NUL}` }], n: 5, t: true, z: null })).toEqual({ a: ["x", { b: "y" }], n: 5, t: true, z: null });
  });

  // Proves cutting a string at a length limit never leaves half an emoji
  // (a lone UTF-16 surrogate, which PostgreSQL rejects just like a NUL).
  it("never splits a character in two when truncating", () => {
    const name = `${"a".repeat(199)}😀tail`;
    const cut = truncate(name, 200);
    expect(cut).toBe("a".repeat(199));
    expect(cleanString("x\uD83D")).toBe("x");
    expect(cleanString("\uDE00y")).toBe("y");
    expect(cleanString("ok 😀")).toBe("ok 😀");
  });

  // Proves a heartbeat URL's query string (not only its body) is cleaned —
  // ?msg=%00 used to reach the database unchanged.
  it("cleans query-string input on heartbeat URLs", async () => {
    const { checks } = await import("../src/db/schema.js");
    const token = crypto.randomUUID().replaceAll("-", "");
    await db.insert(checks).values({ siteId, name: "hb", type: "heartbeat", config: {}, pushToken: token });
    const res = await request(app).get(`/api/hb/${token}?status=up&msg=done%00%00`).set("X-Forwarded-For", ip());
    expect(res.status).toBe(200);
  });
});

describe("a report that can't be fully stored", () => {
  // Proves the check-in no longer depends on the rest of the report: when
  // the large inventory/software update fails, last seen time and version
  // are still stored, the agent gets a 500 (so it resends its check
  // results), the reason is shown on the endpoint, and the log entry names
  // the endpoint without dumping the report's values.
  it("still checks the endpoint in and records why the rest failed", async () => {
    await db.update(endpoints).set({ lastSeenAt: new Date(Date.now() - 3_600_000) }).where(eq(endpoints.id, endpointId));
    const before = new Date();
    const res = await request(app)
      .post("/api/agent/report")
      .set(auth())
      .send({ version: "5.0.1", metrics: { cpuPercent: 1 }, inventory: { serial: "SECRET-SERIAL-9876" }, watchdogStatus: { injectNul: true } });
    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Internal server error" });
    const ep = await row();
    expect(ep.lastSeenAt!.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1000);
    expect(ep.agentVersion).toBe("5.0.1");
    expect(ep.lastReportError).toMatch(/unsupported Unicode escape sequence/);
    expect(ep.lastReportError).not.toContain("SECRET-SERIAL-9876");
    expect(ep.lastReportErrorAt).not.toBeNull();
    const entries = await eventually(() => db.query.logs.findMany({ where: sql`${logs.metadata} ->> 'endpointId' = ${endpointId}` }));
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.some((e) => e.message.includes('"laptop-under-test"'))).toBe(true);
    // No log line anywhere may carry the report's values.
    const leaked = await db.query.logs.findMany({ where: sql`${logs.message} LIKE '%SECRET-SERIAL-9876%'` });
    expect(leaked).toEqual([]);
  });

  // Proves the endpoint's error clears once a report goes through again.
  it("clears the error after the next good report", async () => {
    const res = await request(app).post("/api/agent/report").set(auth()).send({ version: "5.0.1", metrics: { cpuPercent: 1 }, inventory: { serial: "X" } });
    expect(res.status).toBe(200);
    const ep = await row();
    expect(ep.lastReportError).toBeNull();
    expect(ep.lastReportErrorAt).toBeNull();
  });

  // Proves database errors are logged as PostgreSQL's reason and the SQL
  // (placeholders only), never the parameter values Drizzle's message holds.
  it("describes a query error without its parameters", () => {
    const err = Object.assign(new Error("Failed query: update x set a = $1\nparams: SECRET"), { query: "update x set a = $1", cause: { message: "unsupported Unicode escape sequence", code: "22P05" } });
    const text = describeError(err);
    expect(text).toContain("unsupported Unicode escape sequence");
    expect(text).toContain("[22P05]");
    expect(text).not.toContain("SECRET");
  });
});

describe("body limits and diagnostics", () => {
  // Proves a report over the size limit gets a 413 the agent recognises
  // (not a 500), and the log entry names the endpoint even though the body
  // was never read.
  it("answers 413 for an oversized report and logs which endpoint sent it", async () => {
    const huge = "x".repeat(5 * 1024 * 1024);
    const res = await request(app).post("/api/agent/report").set(auth()).set("Content-Type", "application/json").send(`{"pad":"${huge}"}`);
    expect(res.status).toBe(413);
    const entries = await eventually(() => db.query.logs.findMany({ where: and(sql`${logs.metadata} ->> 'endpointId' = ${endpointId}`, sql`${logs.message} LIKE '%larger than%'`) }));
    expect(entries.length).toBeGreaterThan(0);
  });

  // Proves malformed JSON is a 400, not an unexplained 500.
  it("answers 400 for malformed JSON", async () => {
    const res = await request(app).post("/api/agent/report").set(auth()).set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(400);
  });

  // Proves the agent key is checked before the body is read: a request with
  // a wrong key and a body that isn't JSON gets 401 (key checked first), not
  // 400 (body parsed first) — so a stranger can't make the engine parse a
  // 4 MB body, and a body error can always be tied to an endpoint.
  it("checks the agent key before reading the body", async () => {
    const res = await request(app).post("/api/agent/report").set("X-Forwarded-For", ip()).set("Authorization", "Bearer wrong").set("Content-Type", "application/json").send("{not json");
    expect(res.status).toBe(401);
  });

  // Proves the config poll and the agent's address are recorded, for the
  // endpoint page's "connects but reports fail" diagnosis.
  it("records the last config poll and the agent's address", async () => {
    const res = await request(app).get("/api/agent/config").set(auth());
    expect(res.status).toBe(200);
    const ep = await row();
    expect(ep.lastConfigAt).not.toBeNull();
    expect(ep.lastAgentIp).toBe(agentIp);
    // The dashboard's read of the endpoint includes the diagnostics but
    // still never the key.
    const read = await request(app).get(`/api/endpoints/${endpointId}`).set("Cookie", cookie);
    expect(read.body.lastConfigAt).toBeTruthy();
    expect(read.body).not.toHaveProperty("agentApiKey");
  });

  // Proves the Logs API can narrow to one endpoint, and rejects an ID that
  // isn't one (it goes into a database query).
  it("filters logs by endpoint and validates the ID", async () => {
    const res = await request(app).get(`/api/logs?endpointId=${endpointId}&limit=50`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((e: { metadata: { endpointId?: string } | null }) => e.metadata?.endpointId === endpointId)).toBe(true);
    expect((await request(app).get("/api/logs?endpointId=1'%20OR%20'1'='1").set("Cookie", cookie)).status).toBe(400);
    expect((await request(app).get(`/api/logs?endpointId=${endpointId}`)).status).toBe(401);
  });
});

describe("agent key guessing behind a shared address", () => {
  // Proves one agent with an old key at a site doesn't get the site's shared
  // address blocked while good agents check in from it (that took every
  // agent at the site offline) — the event is still recorded.
  it("doesn't block an address working agents report from", async () => {
    for (let i = 0; i < 12; i++) {
      const r = await request(app).get("/api/agent/config").set("X-Forwarded-For", agentIp).set("Authorization", "Bearer an-old-revoked-key");
      expect(r.status).toBe(401);
    }
    expect(await db.query.ipBlocks.findFirst({ where: eq(ipBlocks.ip, agentIp) })).toBeUndefined();
    expect((await request(app).get("/api/agent/config").set(auth())).status).toBe(200);
    const ev = await db.query.securityEvents.findMany({ where: and(eq(securityEvents.ip, agentIp), eq(securityEvents.kind, "bad_agent_key")) });
    expect(ev.length).toBeGreaterThanOrEqual(10);
  });

  // Proves a stranger's address is still blocked by the same rule, and that
  // requests refused because of a block are now recorded (at most once a
  // minute per address) instead of disappearing silently.
  it("still blocks a stranger, and records refused requests", async () => {
    const stranger = ip();
    for (let i = 0; i < 11; i++) await request(app).get("/api/agent/config").set("X-Forwarded-For", stranger).set("Authorization", "Bearer guess");
    expect(await db.query.ipBlocks.findFirst({ where: eq(ipBlocks.ip, stranger) })).toBeDefined();
    for (let i = 0; i < 3; i++) expect((await request(app).get("/api/agent/config").set("X-Forwarded-For", stranger).set("Authorization", "Bearer guess")).status).toBe(403);
    const refused = await db.query.securityEvents.findMany({ where: and(eq(securityEvents.ip, stranger), eq(securityEvents.kind, "blocked_request")) });
    expect(refused.length).toBe(1);
  });
});
