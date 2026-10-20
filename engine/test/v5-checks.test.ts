// Tests for the 5.0 check features: the safe calculator (SNMP "Calculate"
// and calculated checks), the built-in OID dictionary, and the software
// checks (upgradable packages with phased updates, software changes,
// vulnerable/unsupported software). OSV.dev and endoflife.date are outside
// services, so their answers are faked here; everything else runs against
// the real local test database. Each test comment says what it proves.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, ilike } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { checks, endpoints, externalCache, sites } from "../src/db/schema.js";
import { evaluateExpression, expressionNames } from "../src/services/probes/expression.js";
import { annotateWalk, lookupOid, searchOids, smartValue, vendorOf } from "../src/services/probes/mibs.js";
import { cleanSoftware, evaluatePackages, evaluateSoftwareChange, osvEcosystem, osvSeverity, packageExclusions, probeVulnerable, lockfilesFrom, type SoftwareReport } from "../src/services/software.js";
import { probeCalculated } from "../src/services/calculated.js";

let siteId: string;
let endpointId: string;

beforeAll(async () => {
  siteId = (await db.insert(sites).values({ name: `v5checks-${crypto.randomUUID()}` }).returning())[0].id;
  endpointId = (await db.insert(endpoints).values({ siteId, name: "v5-host" }).returning())[0].id;
});

afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(externalCache).where(ilike(externalCache.key, "%looksee-test%"));
  vi.restoreAllMocks();
});

describe("calculator", () => {
  // Proves arithmetic, precedence, brackets, functions and variables work.
  it("works out expressions", () => {
    expect(evaluateExpression("value / 10", { value: 425 })).toBe(42.5);
    expect(evaluateExpression("(a - b) / a * 100", { a: 200, b: 50 })).toBe(75);
    expect(evaluateExpression("2 + 3 * 4 ^ 2", {})).toBe(50);
    expect(evaluateExpression("-value + 1e3", { value: 1 })).toBe(999);
    expect(evaluateExpression("round(ref * 8 / 1e6, 2)", { ref: 1234567 })).toBe(9.88);
    expect(evaluateExpression("max(a, b, 0) + min(abs(-3), 10)", { a: -1, b: 5 })).toBe(8);
    expect(expressionNames("max(a, b) + c")).toEqual(["a", "b", "c"]);
  });

  // Proves it is a calculator, not code: unknown names and functions,
  // JavaScript tricks, division by zero, runaway nesting and oversized input
  // are all refused with a readable error.
  it("refuses anything that isn't arithmetic", () => {
    expect(() => evaluateExpression("process.exit(1)", { value: 1 })).toThrow();
    expect(() => evaluateExpression("constructor", {})).toThrow(/Unknown name/);
    expect(() => evaluateExpression("constructor(1)", {})).toThrow(/Unknown function/);
    expect(() => evaluateExpression("value; 1", { value: 1 })).toThrow(/Unexpected/);
    expect(() => evaluateExpression("`x`", {})).toThrow();
    expect(() => evaluateExpression("1 / (2 - 2)", {})).toThrow(/Division by zero/);
    expect(() => evaluateExpression("(".repeat(100) + "1" + ")".repeat(100), {})).toThrow(/nested/);
    expect(() => evaluateExpression("1+".repeat(300) + "1", {})).toThrow(/longer/);
    expect(() => evaluateExpression("10 ^ 1000", {})).toThrow(/finite/);
  });
});

describe("OID dictionary", () => {
  // Proves table columns resolve to their name plus row, values get their
  // meaning, and counters are flagged to be read as a rate.
  it("names OIDs and explains values", () => {
    expect(lookupOid("1.3.6.1.2.1.2.2.1.8.3")).toMatchObject({ entry: { name: "ifOperStatus" }, instance: "3" });
    expect(lookupOid(".1.3.6.1.2.1.1.3.0")?.entry.name).toBe("sysUpTime");
    expect(lookupOid("1.3.6.1.4.1.99999.1")).toBeNull();
    const [oper, uptime, octets, mem] = annotateWalk([
      { oid: "1.3.6.1.2.1.2.2.1.8.3", type: "Integer", value: "2" },
      { oid: "1.3.6.1.2.1.1.3.0", type: "TimeTicks", value: "27410000" },
      { oid: "1.3.6.1.2.1.31.1.1.1.6.3", type: "Counter64", value: "123456" },
      { oid: "1.3.6.1.4.1.2021.4.5.0", type: "Integer", value: "2097152" },
    ]);
    expect(oper.name).toBe("ifOperStatus.3");
    expect(oper.display).toBe("down (2)");
    expect(uptime.display).toBe("3d 4h 8m");
    expect(octets.hint?.asRate).toBe(true);
    expect(mem.display).toBe("2.0 GB");
    expect(smartValue(undefined, "abc", "OctetString")).toBe("abc");
  });

  // Proves printer and other vendors are recognised by enterprise number,
  // both for unknown vendor OIDs and in sysObjectID, and that a vendor name
  // finds that vendor's branch.
  it("recognises vendors", () => {
    expect(vendorOf("1.3.6.1.4.1.2435.2.3.9.1")?.vendor).toBe("Brother");
    const [unknown, sysObj] = annotateWalk([
      { oid: "1.3.6.1.4.1.1347.42.99.1", type: "Integer", value: "5" },
      { oid: "1.3.6.1.2.1.1.2.0", type: "OID", value: "1.3.6.1.4.1.367.1.1" },
    ]);
    expect(unknown.name).toBe("Kyocera (enterprise 1347)");
    expect(sysObj.display).toContain("Ricoh device");
    expect(searchOids("brother").some((e) => e.oid === "1.3.6.1.4.1.2435")).toBe(true);
    expect(searchOids("toner").some((e) => e.name === "prtMarkerSuppliesDescription")).toBe(true);
    expect(searchOids("")).toEqual([]);
  });
});

/** A software report for the tests. */
const report = (extra: Partial<SoftwareReport> = {}): SoftwareReport => ({
  collectedAt: 1,
  upgradableAt: 1,
  os: { id: "ubuntu", versionId: "22.04", name: "Ubuntu 22.04.4 LTS" },
  packages: [
    { n: "libssl3", v: "3.0.2-0ubuntu1.10", s: "dpkg", o: "openssl" },
    { n: "bash", v: "5.1-6ubuntu1", s: "dpkg" },
    { n: "node", v: "16.20.2", s: "runtime" },
    { n: "lodash", v: "4.17.15", s: "npm", p: "/srv/app/package-lock.json" },
  ],
  upgradable: [
    { name: "openssl", candidate: "3.0.2-0ubuntu1.12", security: true, source: "apt" },
    { name: "curl", candidate: "7.81.0-1ubuntu1.16", source: "apt" },
    { name: "systemd", candidate: "249.11-0ubuntu3.12", phased: true, source: "apt" },
    { name: "linux-image-generic", candidate: "5.15.0.105", source: "apt" },
  ],
  ...extra,
});

describe("upgradable packages", () => {
  // Proves phased updates are left out by default (and counted separately),
  // can be included, excluded packages are hidden, and a security update
  // makes the check warn.
  it("lists packages, hiding phased and excluded ones", () => {
    const r = evaluatePackages(report(), { exclude: "linux-image-*" });
    expect(r.value).toBe(2);
    expect(r.status).toBe("warn");
    expect(r.message).toContain("1 security");
    expect(r.message).toContain("1 phased held back");
    expect(r.message).toContain("1 excluded");
    expect((r.details as { packages: { name: string }[] }).packages.map((p) => p.name)).toEqual(["openssl", "curl"]);
    expect(evaluatePackages(report(), { includePhased: true }).value).toBe(4);
    expect(evaluatePackages(report(), { securityOnly: true }).value).toBe(1);
    expect(evaluatePackages(report({ upgradable: [] }), {}).status).toBe("up");
    expect(evaluatePackages(null, {}).status).toBe("unknown");
  });

  // Proves an agent's report is cleaned: junk entries dropped, strings
  // capped, unknown fields removed.
  it("cleans what agents send", () => {
    const clean = cleanSoftware({ collectedAt: 5, packages: [{ n: "a", v: "1", s: "dpkg", evil: "x" }, { v: "no name" }, "junk"], upgradable: [{ name: "b".repeat(1000), security: "yes" }], extra: 1 });
    expect(clean?.packages).toEqual([{ n: "a", v: "1", s: "dpkg" }]);
    expect(clean?.upgradable[0].name.length).toBe(300);
    expect(clean?.upgradable[0].security).toBe(false);
    expect(cleanSoftware("nope")).toBeNull();
  });
});

describe("software changes", () => {
  // Proves the first report is the baseline, then added, removed and
  // changed packages are listed and held, and excluded packages are ignored.
  it("reports what changed", () => {
    const first = evaluateSoftwareChange(report(), {}, {});
    expect(first.result.message).toContain("Baseline recorded");
    const changed = report({
      packages: [
        { n: "libssl3", v: "3.0.2-0ubuntu1.12", s: "dpkg", o: "openssl" },
        { n: "nginx", v: "1.18.0", s: "dpkg" },
        { n: "node", v: "16.20.2", s: "runtime" },
        { n: "lodash", v: "4.17.15", s: "npm", p: "/srv/app/package-lock.json" },
        { n: "noisy-tool", v: "9", s: "dpkg" },
      ],
    });
    const second = evaluateSoftwareChange(changed, { exclude: "noisy-*" }, first.state);
    expect(second.result.status).toBe("warn");
    expect(second.result.message).toContain("+ nginx 1.18.0");
    expect(second.result.message).toContain("− bash");
    expect(second.result.message).toContain("libssl3 3.0.2-0ubuntu1.10 → 3.0.2-0ubuntu1.12");
    expect(second.result.message).not.toContain("noisy-tool");
    const third = evaluateSoftwareChange(changed, { exclude: "noisy-*", holdMinutes: 0 }, second.state);
    expect(third.result.status).toBe("up");
  });
});

describe("vulnerable or unsupported software", () => {
  // Proves package ecosystems map to OSV's names (Ubuntu LTS, Debian,
  // Alpine, npm, PyPI) and severities are read from OSV records.
  it("maps ecosystems and severities", () => {
    expect(osvEcosystem({ n: "x", v: "1", s: "dpkg" }, { id: "ubuntu", versionId: "24.04" })).toBe("Ubuntu:24.04:LTS");
    expect(osvEcosystem({ n: "x", v: "1", s: "dpkg" }, { id: "ubuntu", versionId: "23.10" })).toBe("Ubuntu:23.10");
    expect(osvEcosystem({ n: "x", v: "1", s: "dpkg" }, { id: "debian", versionId: "12" })).toBe("Debian:12");
    expect(osvEcosystem({ n: "x", v: "1", s: "apk" }, { id: "alpine", versionId: "3.19.1" })).toBe("Alpine:v3.19");
    expect(osvEcosystem({ n: "x", v: "1", s: "pip" }, undefined)).toBe("PyPI");
    expect(osvEcosystem({ n: "x", v: "1", s: "windows" }, undefined)).toBeNull();
    expect(osvSeverity({ database_specific: { severity: "MODERATE" } })).toBe("medium");
    expect(osvSeverity({ severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }] })).toBe("high");
    expect(packageExclusions({ exclude: "libfoo # vendor app needs it\nCVE-2024-1234 # not exploitable here" })).toMatchObject({ names: ["libfoo"], advisories: ["CVE-2024-1234"] });
  });

  // Proves the check finds vulnerable packages (asking about the Debian/
  // Ubuntu source package), flags an end-of-life runtime, honours package
  // and advisory exclusions, and only sends names and versions out.
  it("finds vulnerabilities and end of life", async () => {
    await db.update(endpoints).set({ software: report() }).where(eq(endpoints.id, endpointId));
    const sent: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      sent.push(`${url} ${init?.body ?? ""}`);
      const json = (v: unknown) => new Response(JSON.stringify(v), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/querybatch")) {
        const body = JSON.parse(String(init?.body)) as { queries: { package: { name: string } }[] };
        return json({ results: body.queries.map((q) => (q.package.name === "openssl" ? { vulns: [{ id: "USN-looksee-test-1" }, { id: "CVE-LOOKSEE-TEST-2" }] } : q.package.name === "lodash" ? { vulns: [{ id: "GHSA-looksee-test-3" }] } : {})) });
      }
      if (url.includes("/vulns/USN-looksee-test-1")) return json({ id: "USN-looksee-test-1", summary: "openssl flaw", database_specific: { severity: "high" } });
      if (url.includes("/vulns/")) return json({ id: "x", summary: "other", database_specific: { severity: "low" } });
      if (url.includes("endoflife.date/api/nodejs")) return json([{ cycle: "16", eol: "2023-09-11" }, { cycle: "20", eol: "2026-04-30" }]);
      if (url.includes("endoflife.date/api/ubuntu")) return json([{ cycle: "22.04", eol: "2027-04-01" }]);
      return new Response("not found", { status: 404 });
    });
    const ctx = { checkId: "x", endpointId, intervalSeconds: 21600, state: {} };
    const r = await probeVulnerable({}, ctx);
    expect(r.status).toBe("down");
    const details = r.details as { vulnerable: { name: string; vulns: { id: string; severity: string }[] }[]; unsupported: { product: string }[] };
    expect(details.vulnerable.map((v) => v.name).sort()).toEqual(["lodash", "openssl"]);
    expect(details.vulnerable.find((v) => v.name === "openssl")!.vulns.find((v) => v.id === "USN-looksee-test-1")!.severity).toBe("high");
    expect(details.unsupported.map((u) => u.product)).toEqual(["nodejs"]);
    expect(r.message).toContain("Node.js 16.20.2");
    // Only package names/versions leave the server.
    const batch = sent.find((s) => s.includes("querybatch"))!;
    expect(batch).toContain('"name":"openssl"');
    expect(batch).not.toContain("v5-host");

    // Excluding the package and the remaining advisory clears it.
    const quiet = await probeVulnerable({ exclude: "lodash # only used in tests\nUSN-looksee-test-1\nCVE-LOOKSEE-TEST-2", useEol: false }, ctx);
    expect(quiet.status).toBe("up");
    expect((quiet.details as { excluded: { name: string; reason: string | null }[] }).excluded).toContainEqual({ name: "lodash", reason: "only used in tests" });
    vi.restoreAllMocks();
  });

  // Proves only real lock-file names are ever asked of the agent.
  it("only passes lock-file paths on", () => {
    expect(lockfilesFrom([{ lockfiles: "/srv/app/package-lock.json\n/etc/shadow\nC:\\app\\composer.lock" }])).toEqual(["/srv/app/package-lock.json", "C:\\app\\composer.lock"]);
  });
});

describe("calculated checks", () => {
  // Proves a calculated check combines other checks' latest values, and
  // reports unknown when an input is missing or stale.
  it("combines other checks' values", async () => {
    const [a, b] = await db
      .insert(checks)
      .values([
        { siteId, name: "load %", type: "push_value", enabled: false, config: {}, lastValue: 40, lastCheckedAt: new Date() },
        { siteId, name: "capacity W", type: "push_value", enabled: false, config: {}, lastValue: 1500, lastCheckedAt: new Date() },
      ])
      .returning();
    const ctx = { checkId: crypto.randomUUID(), endpointId: null, intervalSeconds: 60, state: {} };
    const r = await probeCalculated({ expression: "a / 100 * b", varA: a.id, varB: b.id, unit: " W" }, ctx);
    expect(r.value).toBe(600);
    expect(r.message).toContain("600 W");
    expect((await probeCalculated({ expression: "a + c", varA: a.id }, ctx)).message).toContain("Choose a check for c");
    await db.update(checks).set({ lastCheckedAt: new Date(Date.now() - 3_600_000) }).where(eq(checks.id, b.id));
    expect((await probeCalculated({ expression: "a / 100 * b", varA: a.id, varB: b.id }, ctx)).status).toBe("unknown");
  });
});

describe("alert message variables after the rename", () => {
  // Proves {{endpoint}} is the device, {{site}} the network and {{host}} the
  // device too (its pre-5.0 name) — matching how migration 0019 rewrote
  // saved templates — and the default template shows both.
  it("names the endpoint and the site correctly", async () => {
    const { alertContext } = await import("../src/services/alerting.js");
    const { renderFor } = await import("../src/services/notifications/templates.js");
    const c = (await db.insert(checks).values({ siteId, endpointId, name: "cpu", type: "host_cpu", enabled: false, config: {} }).returning())[0];
    const ctx = await alertContext(c, "triggered", "down", "95%", new Date());
    const site = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
    expect(ctx.endpoint).toBe("v5-host");
    expect(ctx.host).toBe("v5-host");
    expect(ctx.site).toBe(site!.name);
    expect(renderFor(null, ctx).body).toContain(`Endpoint: v5-host · Site: ${site!.name}`);
  });
});
