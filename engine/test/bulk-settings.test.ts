// Tests for editing the settings of the same kind of check on many endpoints
// at once: POST /api/checks/bulk { action: "edit_settings" }
// (routes/checks.ts, with editOwnExclude in services/exclusions.ts). This is
// what the dashboard's "Edit settings…" dialog sends.
//
// Runs against the real local test database through the real HTTP routes,
// signed in the same way the dashboard is. Each test says what behavior (or
// attack) it proves. Everything created is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, sites, users } from "../src/db/schema.js";

const email = `test-bulkset-${crypto.randomUUID()}@example.com`;
let cookie: string;
let siteId: string;
const endpointIds: string[] = [];

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash("TestPass123", 10) });
  cookie = await loginWith2fa(email, "TestPass123");
  siteId = (await db.insert(sites).values({ name: `bulkset-${crypto.randomUUID()}` }).returning())[0].id;
  for (const n of ["a", "b", "c"]) endpointIds.push((await db.insert(endpoints).values({ siteId, name: `bulkset-ep-${n}` }).returning())[0].id);
});

afterAll(async () => {
  // Deleting the site removes its endpoints and checks with it.
  await db.delete(checks).where(eq(checks.siteId, siteId));
  await db.delete(endpoints).where(inArray(endpoints.id, endpointIds));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

/** Creates a "Failed / stopped services" check on one endpoint with the given settings. */
async function servicesCheck(endpointId: string, config: Record<string, unknown>) {
  const [row] = await db.insert(checks).values({ name: `svc-${crypto.randomUUID()}`, siteId, endpointId, type: "agent_services_overview", config, state: { baseline: 1 } }).returning();
  return row;
}

const bulk = (body: Record<string, unknown>) => request(app).post("/api/checks/bulk").set("Cookie", cookie).send({ action: "edit_settings", ...body });
const load = async (id: string) => (await db.query.checks.findFirst({ where: eq(checks.id, id) }))!;

describe("bulk edit_settings", () => {
  // The main use: add one exclusion everywhere and take another out, without
  // overwriting each check's other items (case is ignored, like matching).
  it("adds and removes exclusion items on every chosen check, keeping their other items", async () => {
    const a = await servicesCheck(endpointIds[0], { exclude: "gupdate\nMapsBroker" });
    const b = await servicesCheck(endpointIds[1], { exclude: "sppsvc, MapsBroker" });
    const c = await servicesCheck(endpointIds[2], {});
    const res = await bulk({ ids: [a.id, b.id, c.id], type: "agent_services_overview", excludeAdd: ["edgeupdate", "GUPDATE"], excludeRemove: ["mapsbroker"] });
    expect(res.status).toBe(200);
    expect(res.body.affected).toBe(3);
    expect((await load(a.id)).config).toEqual({ exclude: "gupdate\nedgeupdate" });
    // An older comma-separated setting is read as names and rewritten one per line.
    expect((await load(b.id)).config).toEqual({ exclude: "sppsvc\nedgeupdate\nGUPDATE" });
    expect((await load(c.id)).config).toEqual({ exclude: "edgeupdate\nGUPDATE" });
  });

  // Changing what a check measures resets its baselines, exactly like a single edit.
  it("sets and clears settings, leaves the rest alone, and resets the check's state", async () => {
    const a = await servicesCheck(endpointIds[0], { severity: "warn", includeCleanStops: true, exclude: "x" });
    const b = await servicesCheck(endpointIds[1], { severity: "down" });
    const res = await bulk({ ids: [a.id, b.id], type: "agent_services_overview", set: { severity: "down", timeoutSeconds: 20 }, unset: ["includeCleanStops"], intervalSeconds: 300, retryIntervalSeconds: 30 });
    expect(res.body.affected).toBe(2);
    const ra = await load(a.id);
    expect(ra.config).toEqual({ severity: "down", timeoutSeconds: 20, exclude: "x" });
    expect(ra.state).toEqual({});
    expect(ra.intervalSeconds).toBe(300);
    expect(ra.retryIntervalSeconds).toBe(30);
    expect((await load(b.id)).config).toEqual({ severity: "down", timeoutSeconds: 20 });
  });

  // Removing the last item drops the setting instead of saving an empty one.
  it("removes the exclude setting when no items are left", async () => {
    const a = await servicesCheck(endpointIds[0], { exclude: "only-one" });
    await bulk({ ids: [a.id], type: "agent_services_overview", excludeRemove: "ONLY-ONE" }).expect(200);
    expect((await load(a.id)).config).toEqual({});
  });

  // Settings belong to a kind of check: a check of another type in the
  // selection is skipped and reported, never half-edited.
  it("skips checks of a different type", async () => {
    const a = await servicesCheck(endpointIds[0], {});
    const [ping] = await db.insert(checks).values({ name: "bulkset-ping", siteId, type: "ping", config: { host: "127.0.0.1" } }).returning();
    const res = await bulk({ ids: [a.id, ping.id], type: "agent_services_overview", set: { severity: "warn" } });
    expect(res.body.affected).toBe(1);
    expect(res.body.errors).toHaveLength(1);
    expect((await load(ping.id)).config).toEqual({ host: "127.0.0.1" });
  });

  // Secrets stay write-only: sending the mask back never overwrites a saved
  // password with the mask text, and a new value replaces it.
  it("keeps a saved secret when the mask is sent, and replaces it with a real value", async () => {
    const [h] = await db.insert(checks).values({ name: "bulkset-http", siteId, type: "http", config: { url: "https://example.test/", password: "old-secret" } }).returning();
    const kept = await bulk({ ids: [h.id], type: "http", set: { password: "••••••••", timeoutSeconds: 5 } });
    expect(kept.body.affected).toBe(1);
    expect((await load(h.id)).config).toEqual({ url: "https://example.test/", password: "old-secret", timeoutSeconds: 5 });
    await bulk({ ids: [h.id], type: "http", set: { password: "new-secret" } }).expect(200);
    expect(((await load(h.id)).config as Record<string, unknown>).password).toBe("new-secret");
  });

  // Prototype pollution: setting names like __proto__ or constructor would
  // reach JavaScript's shared object machinery instead of the check's data.
  it("refuses setting names that aren't plain names", async () => {
    const a = await servicesCheck(endpointIds[0], {});
    for (const bad of ["__proto__", "constructor.prototype", "a b", "x".repeat(65), ""]) {
      const res = await bulk({ ids: [a.id], type: "agent_services_overview", unset: [bad] });
      expect(res.status).toBe(400);
    }
    const proto = await request(app)
      .post("/api/checks/bulk")
      .set("Cookie", cookie)
      .set("Content-Type", "application/json")
      .send(`{"ids":["${a.id}"],"action":"edit_settings","type":"agent_services_overview","set":{"__proto__":{"polluted":true}}}`);
    expect(proto.status).toBe(400);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((await load(a.id)).config).toEqual({});
  });

  // Bounds: one request can't store unbounded data, and a bad interval or an
  // empty edit is refused rather than silently doing something.
  it("refuses oversized, empty and invalid edits", async () => {
    const a = await servicesCheck(endpointIds[0], {});
    const ids = [a.id];
    const type = "agent_services_overview";
    expect((await bulk({ ids, type, set: { note: "x".repeat(70_000) } })).status).toBe(400);
    expect((await bulk({ ids, type, unset: Array.from({ length: 201 }, (_, i) => `k${i}`) })).status).toBe(400);
    expect((await bulk({ ids, type })).status).toBe(400);
    expect((await bulk({ ids, type, intervalSeconds: 2 })).status).toBe(400);
    expect((await bulk({ ids, type: "not_a_type", set: { severity: "warn" } })).status).toBe(400);
    // Malformed IDs get a clear 400, not a database error (500).
    expect((await bulk({ ids: ["not-an-id", "1 OR 1=1"], type, set: { severity: "warn" } })).status).toBe(400);
    // 1000 items at most, each at most 300 characters.
    await bulk({ ids, type, excludeAdd: Array.from({ length: 1500 }, (_, i) => `svc-${i}-${"y".repeat(400)}`) }).expect(200);
    const items = String(((await load(a.id)).config as Record<string, unknown>).exclude).split("\n");
    expect(items).toHaveLength(1000);
    expect(Math.max(...items.map((i) => i.length))).toBeLessThanOrEqual(300);
  });

  // Authentication: without a signed-in session nobody can change what checks
  // look at or ignore (hiding a real failure by excluding it).
  it("requires a signed-in session", async () => {
    const a = await servicesCheck(endpointIds[0], {});
    const res = await request(app).post("/api/checks/bulk").send({ ids: [a.id], action: "edit_settings", type: "agent_services_overview", excludeAdd: ["everything"] });
    expect(res.status).toBe(401);
    expect((await load(a.id)).config).toEqual({});
  });
});
