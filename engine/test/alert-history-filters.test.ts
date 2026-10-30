// Tests for the Alert history filters (GET /api/alert-rules/events): the
// location, site and endpoint filters accept several comma-separated IDs
// (any of them matches, different filters must all match), malformed IDs
// match nothing instead of reaching the database, and the route still
// refuses anyone not signed in. Runs against the real local test database;
// everything created here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { alertEvents, alertRules, checks, endpoints, locations, sites, users } from "../src/db/schema.js";

const email = `test-alert-filters-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let locationId: string;
const siteIds: string[] = [];
let endpointId: string;
// Check IDs by name: a and b in site 0 (a on the endpoint), c in site 1, d in site 2.
const check = new Map<string, string>();

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  locationId = (await db.insert(locations).values({ name: `alert-filters-${crypto.randomUUID()}` }).returning())[0].id;
  // Sites 0 and 1 are in the location; site 2 isn't.
  for (let i = 0; i < 3; i++) siteIds.push((await db.insert(sites).values({ name: `alert-filters-${i}-${crypto.randomUUID()}`, locationId: i < 2 ? locationId : null }).returning())[0].id);
  endpointId = (await db.insert(endpoints).values({ siteId: siteIds[0], name: "alert-filters endpoint" }).returning())[0].id;
  const make = async (name: string, siteId: string, onEndpoint = false) => {
    // Disabled so a locally running engine never schedules them.
    const c = (await db.insert(checks).values({ siteId, endpointId: onEndpoint ? endpointId : null, name: `af-${name}`, type: "ping", config: { host: "192.0.2.1" }, enabled: false }).returning())[0];
    const rule = (await db.insert(alertRules).values({ checkId: c.id }).returning())[0];
    await db.insert(alertEvents).values({ alertRuleId: rule.id, message: `af-${name} down` });
    check.set(name, c.id);
  };
  await make("a", siteIds[0], true);
  await make("b", siteIds[0]);
  await make("c", siteIds[1]);
  await make("d", siteIds[2]);
});

afterAll(async () => {
  // Deleting the sites removes their endpoints, checks, rules and events (cascades).
  await db.delete(sites).where(inArray(sites.id, siteIds));
  await db.delete(locations).where(eq(locations.id, locationId));
  await db.delete(users).where(eq(users.email, email));
});

/** The check IDs of the alert events the filter returns (only this file's checks). */
async function checksFor(query: Record<string, string>) {
  const res = await request(app).get("/api/alert-rules/events").query({ ...query, limit: "2000" }).set("Cookie", cookie);
  expect(res.status).toBe(200);
  const mine = new Set(check.values());
  return (res.body as { checkId: string }[]).map((e) => e.checkId).filter((id) => mine.has(id)).sort();
}
const ids = (...names: string[]) => names.map((n) => check.get(n)!).sort();

describe("alert history filters", () => {
  // Proves the history isn't readable without signing in.
  it("refuses an unauthenticated request", async () => {
    expect((await request(app).get("/api/alert-rules/events")).status).toBe(401);
  });

  // Proves one ID still works as before, and two IDs match either.
  it("matches any of several sites", async () => {
    expect(await checksFor({ siteId: siteIds[1] })).toEqual(ids("c"));
    expect(await checksFor({ siteId: `${siteIds[1]},${siteIds[2]}` })).toEqual(ids("c", "d"));
  });

  // Proves the location filter covers all its sites, and combines with the
  // site filter (both must match).
  it("filters by location and combines filters", async () => {
    expect(await checksFor({ locationId })).toEqual(ids("a", "b", "c"));
    expect(await checksFor({ locationId, siteId: `${siteIds[0]},${siteIds[2]}` })).toEqual(ids("a", "b"));
  });

  // Proves the endpoint filter takes a list too.
  it("filters by endpoints", async () => {
    expect(await checksFor({ endpointId: `${endpointId},${crypto.randomUUID()}` })).toEqual(ids("a"));
  });

  // Proves a malformed ID (e.g. an injection attempt) matches nothing and
  // never reaches the query — no 500, and not "everything" either.
  it("treats malformed IDs as matching nothing", async () => {
    const res = await request(app).get("/api/alert-rules/events").query({ siteId: "x' OR 1=1 --" }).set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });
});
