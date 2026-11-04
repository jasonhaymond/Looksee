// Tests for the 5.4 endpoint features: the software history (services/software.ts,
// routes/agent.ts, GET /api/endpoints/:id/software), the RDP sessions check
// (services/rdpSessions.ts) and SMART's reason for not reporting
// (services/endpointMetrics.ts). Runs against the real local test database through
// the real HTTP routes, the same way an agent and the dashboard do. Everything
// created is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { desc, eq } from "drizzle-orm";
import request from "supertest";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checkResults, checks, endpoints, sites, softwareHistory, users } from "../src/db/schema.js";
import { evaluateRdpSessions, type ReportedSession } from "../src/services/rdpSessions.js";
import { evaluateEndpointMetric } from "../src/services/endpointMetrics.js";
import { softwareChanges, type SoftwareReport, type SwPackage } from "../src/services/software.js";

const email = `test-v54-${crypto.randomUUID()}@example.com`;
let cookie: string;
let siteId: string;
let endpointId: string;
let agentKey: string;

const pkgs = (...list: [string, string, string?][]): SwPackage[] => list.map(([n, v, s]) => ({ n, v, s: s ?? "windows" }));
const report = (packages: SwPackage[], errors?: string[]): SoftwareReport => ({ collectedAt: 1, packages, upgradable: [], errors });
// Reports from the test's own agent, as the agent posts them.
const send = (body: Record<string, unknown>) => request(app).post("/api/agent/report").set("Authorization", `Bearer ${agentKey}`).send(body);

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash("TestPass123", 10) });
  cookie = await loginWith2fa(email, "TestPass123");
  siteId = (await db.insert(sites).values({ name: `v54-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "v54-host" }).returning())[0].id;
  agentKey = (await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie)).body.agentApiKey;
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

describe("softwareChanges", () => {
  // Installed, removed and updated are told apart, with versions.
  it("records what changed", () => {
    const { changes } = softwareChanges(report(pkgs(["Chrome", "1"], ["Zoom", "5"])), report(pkgs(["Chrome", "2"], ["7-Zip", "24"])), null);
    expect(changes).toEqual(
      expect.arrayContaining([
        { action: "updated", name: "Chrome", source: "windows", fromVersion: "1", toVersion: "2" },
        { action: "installed", name: "7-Zip", source: "windows", fromVersion: null, toVersion: "24" },
        { action: "removed", name: "Zoom", source: "windows", fromVersion: "5", toVersion: null },
      ])
    );
    expect(changes).toHaveLength(3);
  });

  // The first report is a baseline: calling everything "installed" would bury the
  // real history under a machine's entire package list.
  it("records nothing for the first report", () => {
    expect(softwareChanges(null, report(pkgs(["Chrome", "1"])), null).changes).toEqual([]);
  });

  // A failed collection must not look like uninstalling everything.
  it("doesn't read an empty report as a mass uninstall", () => {
    const before = pkgs(["A", "1"], ["B", "1"]);
    const out = softwareChanges(report(before), report([]), null);
    expect(out.changes).toEqual([]);
    expect(out.held).toHaveLength(2);
  });

  // pip times out on one run: its packages aren't "removed", and when it comes back
  // they aren't "installed" either; only a real change while it was away is recorded.
  it("holds a source that drops out and compares it when it comes back", () => {
    const pip = pkgs(["a", "1", "pip"], ["b", "1", "pip"], ["c", "1", "pip"], ["d", "1", "pip"], ["e", "1", "pip"]);
    const win = pkgs(["Chrome", "1"]);
    const gone = softwareChanges(report([...win, ...pip]), report(win, ["pip: timed out"]), null);
    expect(gone.changes).toEqual([]);
    expect(gone.held).toHaveLength(5);
    const back = softwareChanges(report(win), report([...win, ...pkgs(["a", "2", "pip"], ["b", "1", "pip"], ["c", "1", "pip"], ["d", "1", "pip"], ["e", "1", "pip"])]), gone.held);
    expect(back.changes).toEqual([{ action: "updated", name: "a", source: "pip", fromVersion: "1", toVersion: "2" }]);
    expect(back.held).toBeNull();
  });

  // A small source really emptied in a clean report is a genuine uninstall.
  it("records a real removal of a small source", () => {
    const { changes } = softwareChanges(report([...pkgs(["Chrome", "1"]), ...pkgs(["node", "22", "runtime"])]), report(pkgs(["Chrome", "1"])), null);
    expect(changes).toEqual([{ action: "removed", name: "node", source: "runtime", fromVersion: "22", toVersion: null }]);
  });

  // Lock-file dependencies change with every deploy and aren't "installed software".
  it("leaves out project dependencies from lock files", () => {
    const lock = (v: string): SwPackage => ({ n: "left-pad", v, s: "npm", p: "/app/package-lock.json" });
    const { changes } = softwareChanges(report([...pkgs(["Chrome", "1"]), lock("1")]), report([...pkgs(["Chrome", "1"]), lock("2")]), null);
    expect(changes).toEqual([]);
  });

  // Windows can list one name twice; a reordering isn't a change.
  it("handles several versions of one name", () => {
    const { changes } = softwareChanges(report(pkgs(["VC++", "14"], ["VC++", "9"])), report(pkgs(["VC++", "9"], ["VC++", "14"])), null);
    expect(changes).toEqual([]);
  });
});

describe("software history through the agent report", () => {
  // The whole path: agent reports → history rows → the API the Software tab reads.
  it("stores changes and serves them, newest first", async () => {
    expect((await send({ version: "5.4.0", software: report(pkgs(["Chrome", "1"], ["Zoom", "5"])) })).status).toBe(200);
    expect((await send({ version: "5.4.0", software: report(pkgs(["Chrome", "2"])) })).status).toBe(200);
    const res = await request(app).get(`/api/endpoints/${endpointId}/software`).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.packages).toEqual([{ name: "Chrome", version: "2", source: "windows", path: null }]);
    expect(res.body.history.map((h: { action: string; name: string }) => `${h.action} ${h.name}`).sort()).toEqual(["removed Zoom", "updated Chrome"]);
  });

  // Attack: reading an endpoint's software list without signing in.
  it("requires a session", async () => {
    expect((await request(app).get(`/api/endpoints/${endpointId}/software`)).status).toBe(401);
  });

  // Deleting an endpoint takes its history with it, so nothing is orphaned.
  it("deletes history with the endpoint", async () => {
    const other = (await db.insert(endpoints).values({ siteId, name: "doomed" }).returning())[0].id;
    await db.insert(softwareHistory).values({ endpointId: other, action: "installed", name: "x", source: "windows" });
    await db.delete(endpoints).where(eq(endpoints.id, other));
    expect(await db.select().from(softwareHistory).where(eq(softwareHistory.endpointId, other))).toEqual([]);
  });
});

describe("RDP sessions check", () => {
  const session = (over: Partial<ReportedSession>): ReportedSession => ({ user: "CORP\\alice", state: "active", kind: "rdp", clientName: "LAPTOP1", host: "10.0.0.5", ...over });
  const now = 2_000_000_000;

  // State, user and source are all in the result, as requested.
  it("reports each session's user, state and where it's from", () => {
    const r = evaluateRdpSessions({ detail: true, sessions: [session({})] }, {}, now);
    expect(r.status).toBe("up");
    expect(r.value).toBe(1);
    expect(r.message).toContain("CORP\\alice (active, from LAPTOP1 10.0.0.5)");
    expect((r.details as { sessions: { user: string; state: string }[] }).sessions[0]).toMatchObject({ user: "CORP\\alice", state: "active", connection: "RDP" });
  });

  // Someone at the keyboard isn't an RDP session, unless the check asks to include them.
  it("leaves out the console unless asked", () => {
    const users = { detail: true, sessions: [session({ kind: "console", user: "local" })] };
    expect(evaluateRdpSessions(users, {}, now).value).toBe(0);
    expect(evaluateRdpSessions(users, {}, now).message).toBe("No RDP sessions");
    expect(evaluateRdpSessions(users, { includeConsole: true }, now).value).toBe(1);
  });

  // A disconnected session has no connection type left, and it's exactly what this
  // check has to show.
  it("counts a disconnected session of unknown type", () => {
    const r = evaluateRdpSessions({ detail: true, sessions: [session({ kind: "", state: "disconnected", disconnectedAt: now - 7200 })] }, {}, now);
    expect(r.value).toBe(1);
    expect(r.message).toContain("disconnected 2 h");
  });

  // Attack: a stolen account used for remote access. Anyone off the expected list
  // fails the check, and the list works with or without the domain.
  it("flags a user who isn't expected", () => {
    const users = { detail: true, sessions: [session({}), session({ user: "CORP\\mallory" })] };
    const r = evaluateRdpSessions(users, { allowedUsers: "alice" }, now);
    expect(r.status).toBe("down");
    expect(r.message).toContain("unexpected user: CORP\\mallory");
    expect(evaluateRdpSessions(users, { allowedUsers: "alice", unexpectedSeverity: "warn" }, now).status).toBe("warn");
    expect(evaluateRdpSessions(users, { allowedUsers: "alice\nmallory" }, now).status).toBe("up");
    expect(evaluateRdpSessions(users, { allowedUsers: "CORP\\*" }, now).status).toBe("up");
  });

  // Sessions forgotten for days hold licences and keep programs running.
  it("warns about sessions left disconnected too long", () => {
    const users = { detail: true, sessions: [session({ state: "disconnected", disconnectedAt: now - 3 * 3600 })] };
    expect(evaluateRdpSessions(users, { disconnectedMaxMinutes: 60 }, now).status).toBe("warn");
    expect(evaluateRdpSessions(users, { disconnectedMaxMinutes: 600 }, now).status).toBe("up");
  });

  // The usual count thresholds apply, the same as every other check.
  it("applies thresholds to the number of sessions", () => {
    expect(evaluateRdpSessions({ detail: true, sessions: [session({}), session({ user: "b" })] }, { warnAbove: 1 }, now).status).toBe("warn");
  });

  // An older agent or another OS isn't the same as "nobody connected".
  it("says unknown when the agent can't report session detail", () => {
    const r = evaluateRdpSessions({ count: 0, sessions: [] }, {}, now);
    expect(r.status).toBe("unknown");
    expect(r.message).toMatch(/5\.4/);
  });

  // Through the real report path to a stored result.
  it("records a result from an agent's report", async () => {
    const created = (await db.insert(checks).values({ siteId, endpointId, name: "rdp", type: "host_rdp_sessions", config: {}, intervalSeconds: 60 }).returning())[0];
    const res = await send({ version: "5.4.0", metrics: { cpuPercent: 1, memPercent: 1, diskPercent: 1, extended: { users: { count: 1, detail: true, sessions: [session({})] } } } });
    expect(res.status).toBe(200);
    const [latest] = await db.select().from(checkResults).where(eq(checkResults.checkId, created.id)).orderBy(desc(checkResults.checkedAt)).limit(1);
    expect(latest.status).toBe("up");
    expect(latest.message).toContain("alice");
  });
});

describe("response headers", () => {
  // Attack: reading the framework's name from a response to pick exploits for it.
  it("doesn't say what framework the server runs", async () => {
    const res = await request(app).get("/api/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});

describe("SMART's reason for not reporting", () => {
  // The reported bug: smartctl works by hand, but the check only said SMART isn't
  // reported. The agent's reason now reaches the check, saying what to fix.
  it("shows the agent's reason", () => {
    const r = evaluateEndpointMetric({ smartProblem: "/dev/sda: Permission denied" }, { metric: "smart.healthy" });
    expect(r?.status).toBe("unknown");
    expect(r?.message).toContain("Permission denied");
  });

  // Older agents send no reason, and get the old message.
  it("falls back to the general message", () => {
    expect(evaluateEndpointMetric({}, { metric: "smart.healthy" })?.message).toMatch(/isn't reported/);
  });

  // The reason must not leak onto unrelated metrics.
  it("doesn't show it on other metrics", () => {
    expect(evaluateEndpointMetric({ smartProblem: "smartctl-reason" }, { metric: "temp.max" })?.message).not.toContain("smartctl-reason");
  });
});
