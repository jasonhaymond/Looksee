// Tests for exclusions: the name/text matching rules, reusable exclusion
// lists (API, validation, which checks they apply to), how they merge with a
// check's own setting, and that checks really ignore excluded items — agent
// metrics, and the config handed to agents. Runs against the real local test
// database; each test comment says what it proves. Everything created here is
// removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, exclusionLists, groups, sites, users } from "../src/db/schema.js";
import { excludeItems, kindsForType, nameExcluded, textExcluded } from "../src/services/probes/exclude.js";
import { exclusionsFor, invalidateExclusionCache, withExclusions } from "../src/services/exclusions.js";
import { evaluateEndpointMetric } from "../src/services/endpointMetrics.js";

const email = `test-excl-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
// A unique marker so lists made here only ever match this file's own items.
const tag = `x${crypto.randomUUID().slice(0, 8)}`;
let cookie: string;
let siteId: string;
let endpointId: string;
let agentAuth: Record<string, string>;
const listIds: string[] = [];
const groupIds: string[] = [];

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `excl-${tag}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: `excl-host-${tag}`, agentVersion: "4.3.0" }).returning())[0].id;
  const key = await request(app).post(`/api/endpoints/${endpointId}/agent-key`).set("Cookie", cookie);
  agentAuth = { Authorization: `Bearer ${key.body.agentApiKey}` };
});

afterAll(async () => {
  if (listIds.length) await db.delete(exclusionLists).where(inArray(exclusionLists.id, listIds));
  if (groupIds.length) await db.delete(groups).where(inArray(groups.id, groupIds));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
  invalidateExclusionCache();
});

/** Creates a list through the API and remembers it for cleanup. */
async function makeList(body: Record<string, unknown>) {
  const res = await request(app).post("/api/exclusion-lists").set("Cookie", cookie).send(body);
  if (res.status === 201) listIds.push(res.body.id);
  return res;
}

/** Creates a check directly in the database (disabled: the scheduler leaves it alone). */
async function makeCheck(values: Partial<typeof checks.$inferInsert> & { name: string; type: (typeof checks.$inferInsert)["type"] }) {
  return (await db.insert(checks).values({ siteId, endpointId, config: {}, enabled: false, ...values }).returning())[0];
}

describe("matching rules", () => {
  // Proves names match whole and case-insensitively, `*`/`?` are wildcards,
  // and every other character is literal — a pattern can't act as a regex
  // (so no injected pattern can cause catastrophic backtracking).
  it("matches names with wildcards only", () => {
    expect(nameExcluded("/snap/core/123", ["/snap/*"])).toBe(true);
    expect(nameExcluded("/SNAP/core", ["/snap/*"])).toBe(true);
    expect(nameExcluded("/snapshots", ["/snap"])).toBe(false);
    expect(nameExcluded("veth3a2f", ["veth*"])).toBe(true);
    expect(nameExcluded("eth0", ["eth?"])).toBe(true);
    expect(nameExcluded("eth10", ["eth?"])).toBe(false);
    expect(nameExcluded("a.b", ["a.b"])).toBe(true);
    expect(nameExcluded("axb", ["a.b"])).toBe(false);
    expect(nameExcluded("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!", ["(a+)+$"])).toBe(false);
    expect(nameExcluded("", ["*"])).toBe(false);
  });

  // Proves message texts match anywhere, ignoring case, and that commas only
  // separate name items (a message text may contain commas).
  it("matches texts anywhere and parses settings", () => {
    expect(textExcluded("Auth failure from Scanner-01", ["scanner"])).toBe(true);
    expect(textExcluded("disk full", ["scanner"])).toBe(false);
    expect(excludeItems("a, b\nc")).toEqual(["a, b", "c"]);
    expect(excludeItems("a, b\nc", true)).toEqual(["a", "b", "c"]);
    expect(excludeItems(["x", " ", "y "])).toEqual(["x", "y"]);
  });

  // Proves each check type gets only the kinds it can use; host_metric
  // depends on what its metric measures.
  it("knows which kinds each check type uses", () => {
    expect(kindsForType("syslog_match")).toEqual(["messages"]);
    expect(kindsForType("agent_eventlog")).toEqual(["messages", "event_ids"]);
    expect(kindsForType("snmp_interfaces")).toEqual(["interfaces"]);
    expect(kindsForType("host_metric", "mount")).toEqual(["mounts"]);
    expect(kindsForType("host_metric")).toEqual([]);
    expect(kindsForType("ping")).toEqual([]);
  });
});

describe("exclusion lists API", () => {
  // Proves nobody can read or change exclusions without signing in —
  // otherwise a stranger could hide real failures.
  it("requires a session", async () => {
    expect((await request(app).get("/api/exclusion-lists")).status).toBe(401);
    expect((await request(app).post("/api/exclusion-lists").send({ name: "x", kind: "mounts" })).status).toBe(401);
    expect((await request(app).patch(`/api/exclusion-lists/${crypto.randomUUID()}`).send({ name: "x" })).status).toBe(401);
    expect((await request(app).delete(`/api/exclusion-lists/${crypto.randomUUID()}`)).status).toBe(401);
    expect((await request(app).get(`/api/checks/${crypto.randomUUID()}/exclusions`)).status).toBe(401);
  });

  // Proves malformed input is refused: unknown kinds (including inherited
  // object property names), group IDs that aren't IDs or don't exist.
  it("validates input", async () => {
    expect((await makeList({ name: "x", kind: "nonsense" })).status).toBe(400);
    expect((await makeList({ name: "x", kind: "constructor" })).status).toBe(400);
    expect((await makeList({ name: "", kind: "mounts" })).status).toBe(400);
    expect((await makeList({ name: "x", kind: "mounts", groupIds: ["1; DROP TABLE groups"] })).status).toBe(400);
    expect((await makeList({ name: "x", kind: "mounts", groupIds: [crypto.randomUUID()] })).status).toBe(400);
  });

  // Proves a list can be created, listed, edited and deleted, with items
  // trimmed and repeats dropped.
  it("creates, edits and deletes", async () => {
    const res = await makeList({ name: `crud-${tag}`, kind: "interfaces", items: "veth*\n docker0 \nveth*" });
    expect(res.status).toBe(201);
    expect(res.body.items).toEqual(["veth*", "docker0"]);
    const listed = (await request(app).get("/api/exclusion-lists").set("Cookie", cookie)).body;
    expect(listed.some((l: { id: string }) => l.id === res.body.id)).toBe(true);
    const edited = await request(app).patch(`/api/exclusion-lists/${res.body.id}`).set("Cookie", cookie).send({ items: ["br-*"], enabled: false });
    expect(edited.body.items).toEqual(["br-*"]);
    expect(edited.body.enabled).toBe(false);
    expect((await request(app).delete(`/api/exclusion-lists/${res.body.id}`).set("Cookie", cookie)).status).toBe(204);
    expect((await request(app).patch(`/api/exclusion-lists/${res.body.id}`).set("Cookie", cookie).send({ name: "gone" })).status).toBe(404);
  });
});

describe("which checks a list applies to", () => {
  // Proves a check's own items and an all-checks list merge (own first,
  // repeats once), a disabled list doesn't apply, and the sources are shown.
  it("merges the check's own items with lists for all checks", async () => {
    const c = await makeCheck({ name: "disk", type: "host_metric", config: { metric: "disk.used_percent", exclude: `/${tag}-own\n/${tag}-shared` } });
    await makeList({ name: `all-${tag}`, kind: "mounts", items: [`/${tag}-shared`, `/${tag}-list/*`], applyToAll: true });
    await makeList({ name: `off-${tag}`, kind: "mounts", items: [`/${tag}-off`], applyToAll: true, enabled: false });
    await makeList({ name: `ifaces-${tag}`, kind: "interfaces", items: [`${tag}-if`], applyToAll: true });
    invalidateExclusionCache();
    const items = await exclusionsFor(c);
    expect(items.map((i) => i.value)).toEqual([`/${tag}-own`, `/${tag}-shared`, `/${tag}-list/*`]);
    expect(items[0].source).toEqual({ type: "check" });
    expect(items[2].source).toMatchObject({ type: "list", name: `all-${tag}` });
    const viaApi = (await request(app).get(`/api/checks/${c.id}/exclusions`).set("Cookie", cookie)).body;
    expect(viaApi.map((i: { value: string }) => i.value)).toContain(`/${tag}-list/*`);
  });

  // Proves a list limited to a group applies to the group's checks and not
  // to others.
  it("applies group lists only to the group's checks", async () => {
    const inGroup = await makeCheck({ name: "in group", type: "syslog_match", config: { pattern: "x" } });
    const outside = await makeCheck({ name: "outside", type: "syslog_match", config: { pattern: "x" } });
    const g = await request(app).post("/api/groups").set("Cookie", cookie).send({ name: `g-${tag}`, kind: "manual", members: [{ type: "check", id: inGroup.id }] });
    groupIds.push(g.body.id);
    expect((await makeList({ name: `grp-${tag}`, kind: "messages", items: [`noise-${tag}`], groupIds: [g.body.id] })).status).toBe(201);
    invalidateExclusionCache();
    expect((await exclusionsFor(inGroup)).map((i) => i.value)).toContain(`noise-${tag}`);
    expect((await exclusionsFor(outside)).map((i) => i.value)).not.toContain(`noise-${tag}`);
    // As a list for engine probes, and as text for agents.
    expect((await withExclusions(inGroup)).exclude).toEqual([`noise-${tag}`]);
    expect((await withExclusions(inGroup, true)).exclude).toBe(`noise-${tag}`);
  });
});

describe("checks ignore excluded items", () => {
  // Proves an agent metric over many mounts skips excluded ones: without the
  // exclusion the full /snap mount is the worst; with it, the real disk is.
  it("leaves excluded mounts out of a disk metric", () => {
    const snapshot = { disks: [{ mount: "/", total: 100, used: 70, free: 30, percent: 70 }, { mount: "/snap/core/1", total: 1, used: 1, free: 0, percent: 100 }] };
    const config = { metric: "disk.used_percent", criticalAbove: 90 };
    expect(evaluateEndpointMetric(snapshot, config)?.value).toBe(100);
    const excluded = evaluateEndpointMetric(snapshot, { ...config, exclude: ["/snap/*"] });
    expect(excluded?.value).toBe(70);
    expect(excluded?.status).toBe("up");
  });

  // Proves agents receive the merged exclusions in their config, as text
  // (which every agent version reads).
  it("hands agents their merged exclusions", async () => {
    const c = await makeCheck({ name: "overview", type: "agent_services_overview", enabled: true, config: { exclude: "own-svc" } });
    await makeList({ name: `svc-${tag}`, kind: "services", items: [`${tag}-svc`], applyToAll: true });
    invalidateExclusionCache();
    const cfg = await request(app).get("/api/agent/config").set(agentAuth);
    const handed = cfg.body.checks.find((x: { id: string }) => x.id === c.id);
    expect(handed.config.exclude).toBe(`own-svc\n${tag}-svc`);
  });
});
