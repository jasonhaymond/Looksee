// Tests for SNMP templates: built-in starter templates (including per-brand
// printers), validation of your own templates, and applying a template to a
// device (which creates its checks). Runs against the real local test
// database; each test comment says what it proves. Everything created here
// is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { BUILTIN_TEMPLATES, templatesForDevice } from "../src/services/snmpTemplates.js";
import { db } from "../src/db/index.js";
import { checks, endpoints, sites, snmpTemplates, users } from "../src/db/schema.js";

const email = `test-snmpt-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let otherSiteId: string;
let endpointId: string;
const templateIds: string[] = [];

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `snmpt-${crypto.randomUUID()}` }).returning())[0].id;
  otherSiteId = (await db.insert(sites).values({ name: `snmpt-other-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "office-printer", hostname: "printer.lan" }).returning())[0].id;
});

afterAll(async () => {
  if (templateIds.length) await db.delete(snmpTemplates).where(inArray(snmpTemplates.id, templateIds));
  await db.delete(sites).where(inArray(sites.id, [siteId, otherSiteId]));
  await db.delete(users).where(eq(users.email, email));
});

const api = () => ({ get: (p: string) => request(app).get(p).set("Cookie", cookie), post: (p: string, b: unknown) => request(app).post(p).set("Cookie", cookie).send(b as object), patch: (p: string, b: unknown) => request(app).patch(p).set("Cookie", cookie).send(b as object) });

describe("SNMP templates", () => {
  // Proves templates can't be read, changed or applied without signing in
  // (applying creates checks that poll devices with stored credentials).
  it("requires a session", async () => {
    expect((await request(app).get("/api/snmp-templates")).status).toBe(401);
    expect((await request(app).post("/api/snmp-templates/builtin:printer/apply").send({ siteId })).status).toBe(401);
  });

  // Proves the starter templates include generic and per-brand printers
  // (matched by enterprise number) and can't be changed or deleted.
  it("lists built-in templates, read-only", async () => {
    const list = (await api().get("/api/snmp-templates")).body as { id: string; name: string; matchSysObjectId: string | null; builtIn: boolean }[];
    expect(list.find((t) => t.id === "builtin:printer")?.builtIn).toBe(true);
    expect(list.find((t) => t.name === "Brother printer")?.matchSysObjectId).toBe("1.3.6.1.4.1.2435");
    expect(list.find((t) => t.name === "Ricoh printer")).toBeTruthy();
    expect((await api().patch("/api/snmp-templates/builtin:printer", { name: "x" })).status).toBe(400);
    expect((await request(app).delete("/api/snmp-templates/builtin:printer").set("Cookie", cookie)).status).toBe(400);
  });

  // Proves bad items are refused: unknown presets (including inherited
  // property names), non-OIDs, bad extra-OID lines, broken expressions.
  it("validates your own templates", async () => {
    const bad = (items: unknown[]) => api().post("/api/snmp-templates", { name: "bad", items });
    expect((await bad([])).status).toBe(400);
    expect((await bad([{ name: "x", preset: "constructor" }])).status).toBe(400);
    expect((await bad([{ name: "x", oid: "1.3.6.1; rm -rf /" }])).status).toBe(400);
    expect((await bad([{ name: "x", extraOids: "a = nope", expression: "a" }])).status).toBe(400);
    expect((await bad([{ name: "x", oid: "1.3.6.1.2.1.1.3.0", expression: "value +" }])).status).toBe(400);
    expect((await bad([{ name: "x", extraOids: "a = 1.3.6.1.2.1.1.3.0" }])).status).toBe(400);
    expect((await bad([{ name: "" }])).status).toBe(400);
  });

  // Proves a template can be created and edited, then applied to a device:
  // one check per item with the device's address and credentials and the
  // item's settings, named after the endpoint.
  it("creates, edits and applies a template", async () => {
    const created = await api().post("/api/snmp-templates", {
      name: "Disk %",
      matchSysObjectId: "1.3.6.1.4.1.8072",
      items: [
        { name: "Root disk", extraOids: "used = 1.3.6.1.2.1.25.2.3.1.6.1\nsize = 1.3.6.1.2.1.25.2.3.1.5.1", expression: "used / size * 100", unit: "%", warnAbove: "85", intervalSeconds: 10 },
        { name: "Uptime", oid: ".1.3.6.1.2.1.1.3.0" },
      ],
    });
    expect(created.status).toBe(201);
    templateIds.push(created.body.id);
    expect(created.body.items[0].warnAbove).toBe(85);
    expect(created.body.items[0].intervalSeconds).toBe(30);
    expect(created.body.items[1].oid).toBe("1.3.6.1.2.1.1.3.0");
    expect((await api().patch(`/api/snmp-templates/${created.body.id}`, { description: "Root disk usage" })).body.description).toBe("Root disk usage");

    const applied = await api().post(`/api/snmp-templates/${created.body.id}/apply`, { siteId, endpointId, device: { version: "2c", community: "s3cret" } });
    expect(applied.status).toBe(201);
    expect(applied.body.created.map((c: { name: string }) => c.name)).toEqual(["office-printer: Root disk", "office-printer: Uptime"]);
    const rows = await db.query.checks.findMany({ where: inArray(checks.id, applied.body.created.map((c: { id: string }) => c.id)) });
    const disk = rows.find((r) => r.name.endsWith("Root disk"))!;
    expect(disk.config).toMatchObject({ host: "printer.lan", community: "s3cret", expression: "used / size * 100", warnAbove: 85 });
    expect(disk.endpointId).toBe(endpointId);
    // The device's credentials go into its checks, never into the template.
    const stored = (await api().get(`/api/snmp-templates/${created.body.id}`)).body;
    expect(JSON.stringify(stored)).not.toContain("s3cret");
  });

  // Proves applying is refused for an endpoint in another site or without
  // an address, and that a built-in template creates interface checks too.
  it("applies safely", async () => {
    expect((await api().post("/api/snmp-templates/builtin:cisco/apply", { siteId: otherSiteId, endpointId, device: { host: "10.0.0.1" } })).status).toBe(400);
    expect((await api().post("/api/snmp-templates/builtin:cisco/apply", { siteId: otherSiteId, device: {} })).status).toBe(400);
    const ok = await api().post("/api/snmp-templates/builtin:cisco/apply", { siteId: otherSiteId, device: { host: "10.0.0.1", community: "public" }, items: [5] });
    expect(ok.status).toBe(201);
    const [port] = await db.query.checks.findMany({ where: inArray(checks.id, ok.body.created.map((c: { id: string }) => c.id)) });
    expect(port.type).toBe("snmp_interfaces");
  });

  // Discovery suggests templates by the device's sysObjectID: a Brother
  // printer's OID picks the Brother template; matching is on whole OID parts
  // (enterprise 9 = Cisco must not match enterprise 99…); no OID, no
  // suggestion.
  it("suggests templates for a device's sysObjectID", () => {
    const brother = templatesForDevice("1.3.6.1.4.1.2435.2.3.9.1", BUILTIN_TEMPLATES);
    expect(brother[0]?.name).toMatch(/Brother/);
    expect(templatesForDevice("1.3.6.1.4.1.9.1.516", BUILTIN_TEMPLATES).some((t) => /Cisco/.test(t.name))).toBe(true);
    expect(templatesForDevice("1.3.6.1.4.1.99.1", BUILTIN_TEMPLATES).some((t) => /Cisco/.test(t.name))).toBe(false);
    expect(templatesForDevice(undefined, BUILTIN_TEMPLATES)).toEqual([]);
  });
});
