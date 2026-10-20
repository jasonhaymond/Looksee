// Tests for server-role and security templates on endpoints, the smarter
// endpoint suggestions (roles, software, existing checks) and site
// suggestions. Runs against the real local test database; each test comment
// says what it proves. Everything created here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, sites, users } from "../src/db/schema.js";

const email = `test-tpl-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let webId: string;
let dcId: string;
let printerId: string;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `Branch office ${crypto.randomUUID().slice(0, 6)}`, description: "Second floor" }).returning())[0].id;
  webId = (
    await db
      .insert(endpoints)
      .values({
        siteId,
        name: "web01",
        hostname: "web01.lan",
        os: "Ubuntu 24.04",
        agentApiKey: `k-${crypto.randomUUID()}`,
        serviceInventory: [
          { name: "nginx.service", state: "running", startType: "enabled" },
          { name: "postgresql.service", state: "running", startType: "enabled" },
        ],
        lastSnapshot: { load: { l1: 0.1 }, listening: [{ port: 443, proto: "tcp", address: "0.0.0.0" }, { port: 5432, proto: "tcp", address: "0.0.0.0" }, { port: 6379, proto: "tcp", address: "127.0.0.1" }] },
        software: { collectedAt: 1, upgradableAt: 1, packages: [{ n: "nginx", v: "1.24", s: "dpkg" }], upgradable: [] },
      })
      .returning()
  )[0].id;
  dcId = (await db.insert(endpoints).values({ siteId, name: "dc01", hostname: "dc01.corp.lan", os: "Windows Server 2022", serviceInventory: [{ name: "NTDS", state: "Running", startType: "Auto" }, { name: "DNS", state: "Running", startType: "Auto" }] }).returning())[0].id;
  printerId = (await db.insert(endpoints).values({ siteId, name: "Reception MFP", hostname: "mfp.lan" }).returning())[0].id;
  await db.insert(checks).values({ siteId, endpointId: webId, name: "shop", type: "http", enabled: false, config: { url: "https://shop.example.com/" } });
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

type Tpl = { id: string; detected: boolean; kind: string; checks: { key: string; type: string; config: Record<string, unknown> }[]; alreadyHave: number };

describe("role and security templates", () => {
  // Proves templates can't be listed or applied without signing in.
  it("requires a session", async () => {
    expect((await request(app).get(`/api/endpoints/${webId}/role-templates`)).status).toBe(401);
    expect((await request(app).post(`/api/endpoints/${webId}/role-templates/web/apply`)).status).toBe(401);
    expect((await request(app).get(`/api/sites/${siteId}/suggestions`)).status).toBe(401);
  });

  // Proves roles are detected from services and listening ports (loopback-
  // only ports don't count), and the Linux baseline applies to Linux only.
  it("detects roles", async () => {
    const list = (await request(app).get(`/api/endpoints/${webId}/role-templates`).set("Cookie", cookie)).body as Tpl[];
    const by = (id: string) => list.find((t) => t.id === id)!;
    expect(by("web").detected).toBe(true);
    expect(by("database").detected).toBe(true);
    expect(by("dc").detected).toBe(false);
    expect(by("security-linux").detected).toBe(true);
    expect(by("security-windows").detected).toBe(false);
    expect(by("database").checks.some((c) => c.type === "tcp" && c.config.port === 5432)).toBe(true);
    expect(by("database").checks.some((c) => c.type === "tcp" && c.config.port === 6379)).toBe(false);
    expect(by("web").checks.some((c) => c.type === "ssl_cert")).toBe(true);
    const dc = (await request(app).get(`/api/endpoints/${dcId}/role-templates`).set("Cookie", cookie)).body as Tpl[];
    expect(dc.find((t) => t.id === "dc")!.detected).toBe(true);
    expect(dc.find((t) => t.id === "security-windows")!.checks.some((c) => c.type === "agent_eventlog" && c.config.eventIds === "1102")).toBe(true);
  });

  // Proves applying creates the template's checks once — applying again
  // finds nothing missing.
  it("applies a template without duplicates", async () => {
    const first = await request(app).post(`/api/endpoints/${webId}/role-templates/web/apply`).set("Cookie", cookie).send({});
    expect(first.body.created).toBeGreaterThan(1);
    const again = (await request(app).get(`/api/endpoints/${webId}/role-templates`).set("Cookie", cookie)).body as Tpl[];
    expect(again.find((t) => t.id === "web")!.checks).toEqual([]);
    expect(again.find((t) => t.id === "web")!.alreadyHave).toBe(first.body.created);
    expect((await request(app).post(`/api/endpoints/${webId}/role-templates/nope/apply`).set("Cookie", cookie).send({})).status).toBe(404);
  });
});

describe("smarter suggestions", () => {
  // Proves endpoint suggestions now include detected-role checks, software
  // checks once a software report exists, and a certificate check for an
  // existing HTTPS check.
  it("suggest from roles, software and existing checks", async () => {
    const list = (await request(app).get(`/api/endpoints/${webId}/suggestions`).set("Cookie", cookie)).body as { type: string; group: string; config: Record<string, unknown> }[];
    expect(list.some((s) => s.type === "host_packages")).toBe(true);
    expect(list.some((s) => s.type === "host_vulnerable")).toBe(true);
    expect(list.some((s) => s.type === "ssl_cert" && s.config.host === "shop.example.com")).toBe(true);
    // Role checks appear under the role's name (the domain controller's
    // directory checks aren't among the generic suggestions).
    const dc = (await request(app).get(`/api/endpoints/${dcId}/suggestions`).set("Cookie", cookie)).body as { type: string; group: string; config: Record<string, unknown> }[];
    expect(dc.some((s) => s.group === "Domain controller" && s.config.logName === "Directory Service")).toBe(true);
  });

  // Proves site suggestions add internet checks for an office-like site,
  // printer checks for a printer-like endpoint, and apply only what's chosen.
  it("suggest for a site", async () => {
    const list = (await request(app).get(`/api/sites/${siteId}/suggestions`).set("Cookie", cookie)).body as { key: string; type: string; group: string; endpointId: string | null; config: Record<string, unknown> }[];
    expect(list.some((s) => s.group === "Internet" && s.type === "ping")).toBe(true);
    expect(list.some((s) => s.type === "public_ip")).toBe(true);
    const toner = list.find((s) => s.group === "Printers" && s.config.preset === "printer_supplies");
    expect(toner?.endpointId).toBe(printerId);
    expect(JSON.stringify(list)).not.toContain("k-");
    const applied = await request(app).post(`/api/sites/${siteId}/suggestions/apply`).set("Cookie", cookie).send({ keys: [toner!.key] });
    expect(applied.body.created).toBe(1);
    const after = (await request(app).get(`/api/sites/${siteId}/suggestions`).set("Cookie", cookie)).body as { key: string }[];
    expect(after.some((s) => s.key === toner!.key)).toBe(false);
  });
});
