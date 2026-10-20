// Tests for groups (manual and filter), the navigation tree, and
// maintenance windows scoped to a group. Runs against the real local test
// database; each test comment says what behaviour or attack it proves is
// handled. Everything created here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, groups, locations, maintenanceWindows, sites, users } from "../src/db/schema.js";
import { activeMaintenance, windowAppliesTo } from "../src/services/maintenance.js";

const email = `test-groups-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
// A unique tag so filters here only ever match this file's own objects.
const tag = `tg-${crypto.randomUUID().slice(0, 8)}`;
let cookie: string;
let locationId: string;
let siteId: string;
let winId: string;
let linuxId: string;
let winCheckId: string;
let linuxCheckId: string;
let siteCheckId: string;
const groupIds: string[] = [];

// One location → one site → a Windows and a Linux endpoint, each with a
// check, plus a site-level check.
beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  locationId = (await db.insert(locations).values({ name: `loc-${tag}` }).returning())[0].id;
  siteId = (await db.insert(sites).values({ name: `site-${tag}`, locationId }).returning())[0].id;
  winId = (await db.insert(endpoints).values({ siteId, name: `win-${tag}`, os: "Windows 11 Pro", tags: [tag, "desktop"] }).returning())[0].id;
  linuxId = (await db.insert(endpoints).values({ siteId, name: `lnx-${tag}`, os: "Ubuntu 24.04", tags: [tag, "server"] }).returning())[0].id;
  winCheckId = (await db.insert(checks).values({ siteId, endpointId: winId, name: "win cpu", type: "host_cpu", lastStatus: "down" }).returning())[0].id;
  linuxCheckId = (await db.insert(checks).values({ siteId, endpointId: linuxId, name: "linux cpu", type: "host_cpu", lastStatus: "up" }).returning())[0].id;
  siteCheckId = (await db.insert(checks).values({ siteId, name: "site url", type: "http", lastStatus: "warn", config: { url: "http://x" } }).returning())[0].id;
});

afterAll(async () => {
  if (groupIds.length) await db.delete(groups).where(inArray(groups.id, groupIds));
  await db.delete(maintenanceWindows).where(eq(maintenanceWindows.name, `maint-${tag}`));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(locations).where(eq(locations.id, locationId));
  await db.delete(users).where(eq(users.email, email));
});

describe("access", () => {
  // Proves the inventory, groups and tree can't be read or changed without
  // signing in.
  it("requires a session for groups and the tree", async () => {
    expect((await request(app).get("/api/groups")).status).toBe(401);
    expect((await request(app).post("/api/groups").send({ name: "x" })).status).toBe(401);
    expect((await request(app).get("/api/tree")).status).toBe(401);
  });
});

describe("manual groups", () => {
  // Proves a manual group holds exactly what was added, and that a site
  // member covers all of that site's checks through the hierarchy.
  it("resolves members and covers checks through the hierarchy", async () => {
    const res = await request(app).post("/api/groups").set("Cookie", cookie).send({ name: `manual-${tag}`, kind: "manual", members: [{ type: "endpoint", id: winId }] });
    expect(res.status).toBe(201);
    groupIds.push(res.body.id);
    let detail = (await request(app).get(`/api/groups/${res.body.id}`).set("Cookie", cookie)).body;
    expect(detail.members.endpoints.map((e: { id: string }) => e.id)).toEqual([winId]);
    expect(detail.coveredCheckIds).toEqual([winCheckId]);
    expect(detail.status).toBe("down");

    await request(app).post(`/api/groups/${res.body.id}/members`).set("Cookie", cookie).send({ add: [{ type: "site", id: siteId }] });
    detail = (await request(app).get(`/api/groups/${res.body.id}`).set("Cookie", cookie)).body;
    expect(new Set(detail.coveredCheckIds)).toEqual(new Set([winCheckId, linuxCheckId, siteCheckId]));
  });

  // Proves malformed member references are refused rather than stored —
  // a bad type or a non-UUID ID never reaches the database.
  it("refuses unknown member types and malformed IDs", async () => {
    const badType = await request(app).post("/api/groups").set("Cookie", cookie).send({ name: "bad", members: [{ type: "user", id: winId }] });
    expect(badType.status).toBe(400);
    const badId = await request(app).post("/api/groups").set("Cookie", cookie).send({ name: "bad", members: [{ type: "endpoint", id: "1; DROP TABLE checks" }] });
    expect(badId.status).toBe(400);
  });
});

describe("filter groups", () => {
  // Proves a filter group selects by rule, live: the Windows endpoint by OS,
  // and an endpoint added later joins without editing the group.
  it("matches by rules and picks up new objects automatically", async () => {
    const rules = { match: "all", conditions: [{ field: "os", op: "contains", value: "windows" }, { field: "tag", op: "is", value: tag }] };
    const preview = await request(app).post("/api/groups/preview").set("Cookie", cookie).send({ target: "endpoint", rules });
    expect(preview.body.matches.map((m: { id: string }) => m.id)).toEqual([winId]);

    const res = await request(app).post("/api/groups").set("Cookie", cookie).send({ name: `filter-${tag}`, kind: "filter", target: "endpoint", rules });
    expect(res.status).toBe(201);
    groupIds.push(res.body.id);
    const later = (await db.insert(endpoints).values({ siteId, name: `win2-${tag}`, os: "Windows Server 2025", tags: [tag] }).returning())[0].id;
    const detail = (await request(app).get(`/api/groups/${res.body.id}`).set("Cookie", cookie)).body;
    expect(new Set(detail.members.endpoints.map((e: { id: string }) => e.id))).toEqual(new Set([winId, later]));
  });

  // Proves "is not" applies across all of an object's values: a tag
  // condition "is not desktop" excludes the endpoint that has that tag.
  it("applies negative operators across multi-valued fields", async () => {
    const rules = { match: "all", conditions: [{ field: "tag", op: "is", value: tag }, { field: "tag", op: "is_not", value: "desktop" }] };
    const preview = await request(app).post("/api/groups/preview").set("Cookie", cookie).send({ target: "endpoint", rules });
    const ids = preview.body.matches.map((m: { id: string }) => m.id);
    expect(ids).toContain(linuxId);
    expect(ids).not.toContain(winId);
  });

  // Proves rules are validated: an unknown field or operator is refused, so
  // nothing unexpected is ever stored or evaluated.
  it("refuses unknown fields and operators", async () => {
    expect((await request(app).post("/api/groups").set("Cookie", cookie).send({ name: "x", kind: "filter", target: "endpoint", rules: { match: "all", conditions: [{ field: "agentApiKey", op: "is", value: "a" }] } })).status).toBe(400);
    expect((await request(app).post("/api/groups").set("Cookie", cookie).send({ name: "x", kind: "filter", target: "endpoint", rules: { match: "all", conditions: [{ field: "os", op: "regex", value: "(a+)+$" }] } })).status).toBe(400);
    expect((await request(app).post("/api/groups").set("Cookie", cookie).send({ name: "x", kind: "filter", target: "secrets", rules: { match: "all", conditions: [] } })).status).toBe(400);
  });

  // Proves an empty filter matches nothing (a half-built group must not
  // suddenly cover — and e.g. put into maintenance — everything).
  it("matches nothing with no conditions", async () => {
    const preview = await request(app).post("/api/groups/preview").set("Cookie", cookie).send({ target: "check", rules: { match: "all", conditions: [] } });
    expect(preview.body.total).toBe(0);
  });
});

describe("navigation tree", () => {
  // Proves the tree nests location → site → endpoints → checks and rolls
  // the worst status and problem count up each level.
  it("returns the hierarchy with rolled-up status", async () => {
    const tree = (await request(app).get("/api/tree").set("Cookie", cookie)).body;
    const loc = tree.locations.find((l: { id: string }) => l.id === locationId);
    expect(loc.status).toBe("down");
    const site = loc.sites.find((s: { id: string }) => s.id === siteId);
    expect(site.checks.map((c: { id: string }) => c.id)).toEqual([siteCheckId]);
    const win = site.endpoints.find((e: { id: string }) => e.id === winId);
    expect(win.children.map((c: { id: string }) => c.id)).toEqual([winCheckId]);
    // down (win) + warn (site URL) = 2 problems at the site.
    expect(site.problems).toBe(2);
  });
});

describe("maintenance scoped to a group", () => {
  // Proves a maintenance window aimed at a group silences exactly the
  // checks the group covers, and nothing else.
  it("covers the group's checks only", async () => {
    const g = await request(app).post("/api/groups").set("Cookie", cookie).send({ name: `maint-group-${tag}`, kind: "manual", members: [{ type: "endpoint", id: linuxId }] });
    groupIds.push(g.body.id);
    const now = new Date();
    const res = await request(app).post("/api/maintenance").set("Cookie", cookie).send({ name: `maint-${tag}`, scope: "group", targetIds: [g.body.id], startsAt: new Date(now.getTime() - 60_000).toISOString(), endsAt: new Date(now.getTime() + 600_000).toISOString() });
    expect(res.status).toBe(201);
    const { windows, groupChecks } = await activeMaintenance();
    const w = windows.find((x) => x.id === res.body.id)!;
    expect(windowAppliesTo(w, { id: linuxCheckId, siteId, endpointId: linuxId }, groupChecks)).toBe(true);
    expect(windowAppliesTo(w, { id: winCheckId, siteId, endpointId: winId }, groupChecks)).toBe(false);
  });
});
