// Tests for memory detail: the Endpoint metrics, alert summary and details table
// (services/endpointMetrics.ts), and how an agent's report reaches them through the
// real HTTP route (routes/agent.ts). Runs against the real local test database.
// Everything created is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { desc, eq } from "drizzle-orm";
import request from "supertest";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checkResults, checks, endpoints, sites, users } from "../src/db/schema.js";
import { evaluateEndpointMetric, memoryBreakdown, memorySummary, type Snapshot } from "../src/services/endpointMetrics.js";
import { remediationFor } from "../src/services/remediation.js";
import { cleanMemory } from "../../dashboard/app/lib/memoryDetail.js";

const GIB = 1073741824;
const email = `test-memdetail-${crypto.randomUUID()}@example.com`;
let cookie: string;
let siteId: string;
let endpointId: string;
let agentKey: string;

// A machine with most of its commit outside processes, the case this feature is for.
const leaking: Snapshot = {
  mem: {
    total: 32 * GIB,
    available: 2 * GIB,
    percent: 93.75,
    swapTotal: 16 * GIB,
    swapUsed: 4 * GIB,
    swapPercent: 25,
    commitUsed: 40 * GIB,
    commitLimit: 48 * GIB,
    kernelNonpaged: 20 * GIB,
    kernelPaged: 1 * GIB,
    processPrivate: 10 * GIB,
    topPrivate: [{ name: "sqlservr.exe", bytes: 6 * GIB }],
    nonProcess: 30 * GIB,
    pagesInPerSec: 12,
    pagesOutPerSec: 340,
  },
};

const value = (metric: string, snapshot: Snapshot = leaking) => evaluateEndpointMetric(snapshot, { metric })?.value;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash("TestPass123", 10) });
  cookie = await loginWith2fa(email, "TestPass123");
  siteId = (await db.insert(sites).values({ name: `memdetail-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "memdetail-host" }).returning())[0].id;
  agentKey = (await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie)).body.agentApiKey;
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

describe("memory metrics", () => {
  // Each metric reads its own field in the right unit: a mix-up here would make
  // thresholds fire at the wrong sizes.
  it("reads each measure in its stated unit", () => {
    expect(value("mem.commit_percent")).toBeCloseTo(83.33, 1);
    expect(value("mem.commit_used_gb")).toBe(40);
    expect(value("mem.commit_total_gb")).toBe(48);
    expect(value("mem.kernel_nonpaged_mb")).toBe(20480);
    expect(value("mem.kernel_paged_mb")).toBe(1024);
    expect(value("mem.process_private_gb")).toBe(10);
    expect(value("mem.non_process_gb")).toBe(30);
    expect(value("swap.used_gb")).toBe(4);
    expect(value("swap.total_gb")).toBe(16);
    expect(value("mem.pages_in_per_sec")).toBe(12);
    expect(value("mem.pages_out_per_sec")).toBe(340);
  });

  // An older agent or macOS has no such figures: it must say so, not read as zero and
  // quietly pass a "warn above" threshold on memory nobody measured.
  it("reports unknown when the agent doesn't provide a measure", () => {
    const old: Snapshot = { mem: { total: GIB, available: GIB, percent: 0, swapTotal: 0, swapUsed: 0, swapPercent: 0 } };
    for (const metric of ["mem.commit_percent", "mem.kernel_nonpaged_mb", "mem.process_private_gb", "mem.non_process_gb", "mem.pages_out_per_sec", "swap.used_gb", "swap.total_gb"]) {
      const result = evaluateEndpointMetric(old, { metric });
      expect(result?.status, metric).toBe("unknown");
      expect(result?.message, metric).toContain("isn't reported");
    }
  });

  // A real zero is a real reading: no paging at all must pass, not read as missing.
  it("treats zero as a real reading", () => {
    const quiet: Snapshot = { mem: { pagesOutPerSec: 0, nonProcess: 0 } };
    expect(evaluateEndpointMetric(quiet, { metric: "mem.pages_out_per_sec", warnAbove: 100 })?.status).toBe("up");
    expect(evaluateEndpointMetric(quiet, { metric: "mem.non_process_gb", warnAbove: 1 })?.status).toBe("up");
  });
});

describe("where the memory is", () => {
  // The point of the feature: a failing check's message itself shows that the memory
  // isn't in a process, and names the largest one in case it is.
  it("adds the summary to a failing check's message", () => {
    const result = evaluateEndpointMetric(leaking, { metric: "mem.percent", criticalAbove: 90 });
    expect(result?.status).toBe("down");
    expect(result?.message).toContain("commit 40.0 GB of 48.0 GB (83%)");
    expect(result?.message).toContain("nonpaged 20.0 GB");
    expect(result?.message).toContain("not in processes 30.0 GB");
    expect(result?.message).toContain("swap 4.0 GB of 16.0 GB (25%)");
    expect(result?.message).toContain("largest sqlservr.exe 6.0 GB");
  });

  // A healthy check keeps its short message, but its details stay current.
  it("keeps a passing check's message short and still carries the table", () => {
    const result = evaluateEndpointMetric(leaking, { metric: "mem.percent", criticalAbove: 99 });
    expect(result?.status).toBe("up");
    expect(result?.message).not.toContain("commit");
    expect(result?.details).toEqual(memoryBreakdown(leaking));
  });

  // Other metric groups aren't given a memory table they have nothing to do with.
  it("leaves non-memory checks alone", () => {
    expect(evaluateEndpointMetric({ ...leaking, cpu: { percent: 50 } }, { metric: "cpu.percent" })?.details).toBeUndefined();
  });

  // Reports come from the agent and are stored as sent. A malformed field must not
  // throw, because that would stop every other check in the same report.
  it("survives malformed fields", () => {
    const bad = { mem: { commitUsed: "lots", commitLimit: null, kernelNonpaged: {}, topPrivate: "nope", swapTotal: 5, swapUsed: "x" } } as unknown as Snapshot;
    expect(memorySummary(bad)).toBe("");
    expect(() => memoryBreakdown(bad)).not.toThrow();
    expect(memorySummary({ mem: { topPrivate: [null, { name: 5, bytes: 1 }] } } as unknown as Snapshot)).toBe("");
  });

  // Machines without swap say so, rather than showing an empty row.
  it("shows when there is no swap", () => {
    const rows = memoryBreakdown({ mem: { total: GIB, available: GIB, swapTotal: 0 } })?.rows;
    expect(rows).toContainEqual({ Measure: "Swap / page file", Value: "None" });
  });
});

describe("the endpoint page's memory section", () => {
  // Reports are stored as sent. Text where a number belongs would crash the page while
  // formatting it, so bad values are dropped and good ones kept.
  it("drops values that would break the page", () => {
    const clean = cleanMemory({ total: 8, kernelNonpaged: "lots", nonProcess: Number.NaN, commitUsed: 5, topPrivate: "nope" } as Record<string, unknown>);
    expect(clean).toEqual({ total: 8, commitUsed: 5, topPrivate: [] });
    const rows = cleanMemory({ topPrivate: [null, { name: 5, bytes: 1 }, { name: "ok.exe", bytes: "x" }, { name: "good.exe", bytes: 9 }] } as Record<string, unknown>);
    expect(rows.topPrivate).toEqual([{ name: "good.exe", bytes: 9 }]);
  });
});

describe("things to check", () => {
  // Memory outside processes can't be fixed from a process list, so its checks must
  // point at drivers, and the simple memory check must cover both possibilities.
  it("points memory outside processes at drivers", () => {
    const hints = (type: string, config: object) => remediationFor({ type, config, status: "warn", message: "" } as Parameters<typeof remediationFor>[0]).join(" ");
    expect(hints("host_metric", { metric: "mem.non_process_gb" })).toContain("driver leak");
    expect(hints("host_metric", { metric: "mem.kernel_nonpaged_mb" })).toContain("poolmon");
    expect(hints("host_memory", {})).toContain("sort the endpoint's Processes tab by Private");
    expect(hints("host_memory", {})).toContain("driver leak");
  });
});

describe("agent reports", () => {
  const send = (body: Record<string, unknown>) => request(app).post("/api/agent/report").set("Authorization", `Bearer ${agentKey}`).send(body);

  // Proves the simple Memory usage check gets the same detail through the real report
  // route, and that private memory per process survives the engine's field filter,
  // which drops anything it doesn't list.
  it("carries the detail through the real report route", async () => {
    const check = (await db.insert(checks).values({ siteId, endpointId, name: "memory", type: "host_memory", config: { warnPercent: 80, criticalPercent: 90 }, intervalSeconds: 60 }).returning())[0];
    const res = await send({ metrics: { cpuPercent: 1, memPercent: 93.75, diskPercent: 1, extended: leaking }, processInventory: [{ pid: 1, name: "sqlservr.exe", memoryMb: 100, privateMb: 6144, command: "x", extra: "dropped" }] });
    expect(res.status).toBe(200);

    const [row] = await db.select().from(checkResults).where(eq(checkResults.checkId, check.id)).orderBy(desc(checkResults.checkedAt)).limit(1);
    expect(row.status).toBe("down");
    expect(row.message).toContain("not in processes 30.0 GB");
    expect(row.details).toEqual(memoryBreakdown(leaking));

    const inv = await request(app).get(`/api/endpoints/${endpointId}/inventory`).set("Cookie", cookie);
    expect(inv.body.processes[0].privateMb).toBe(6144);
    expect(inv.body.processes[0].extra).toBeUndefined();
  });

  // Proves a process that happens to be called "timeout" can't soften a real memory
  // alert: the timeout rule reads message text, and memory alerts name a process.
  it("doesn't mistake a process name for a probe timeout", async () => {
    const named: Snapshot = { mem: { ...leaking.mem, topPrivate: [{ name: "timeout", bytes: 6 * GIB }] } };
    const simple = (await db.insert(checks).values({ siteId, endpointId, name: "memory named", type: "host_memory", config: { criticalPercent: 90 }, intervalSeconds: 60 }).returning())[0];
    const metric = (await db.insert(checks).values({ siteId, endpointId, name: "metric named", type: "host_metric", config: { metric: "mem.percent", criticalAbove: 90 }, intervalSeconds: 60 }).returning())[0];
    await send({ metrics: { cpuPercent: 1, memPercent: 93.75, diskPercent: 1, extended: named } }).expect(200);
    for (const check of [simple, metric]) {
      const [row] = await db.select().from(checkResults).where(eq(checkResults.checkId, check.id)).orderBy(desc(checkResults.checkedAt)).limit(1);
      expect(row.message).toContain("largest timeout");
      expect(row.status).toBe("down");
    }
  });

  // Proves the new data stays behind the login like the rest of the endpoint's detail:
  // process names and memory layout tell an attacker what's running.
  it("requires a login to read the endpoint's memory detail", async () => {
    expect((await request(app).get(`/api/endpoints/${endpointId}`)).status).toBe(401);
    expect((await request(app).get(`/api/endpoints/${endpointId}/inventory`)).status).toBe(401);
  });
});
