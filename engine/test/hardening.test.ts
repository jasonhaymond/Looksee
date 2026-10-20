// Security tests for the hardening helpers added in 5.0: each test says what
// attack it proves is blocked. No database or network needed.

import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { deleteOwn, own, setOwn } from "../src/lib/own.js";
import { compileUserRegex } from "../src/lib/userRegex.js";
import { existsIn, readTextIn, within, writeTextIn } from "../src/lib/safeFs.js";
import { isUuid, stripMappedIp } from "../src/lib/ids.js";
import { globMatch, nameExcluded } from "../src/services/probes/exclude.js";
import { looksLikeScan } from "../src/services/security.js";
import { parsePrometheus } from "../src/services/probes/apps.js";
import { isOid } from "../src/services/probes/mibs.js";

describe("prototype pollution", () => {
  // Proves a property name from data ("__proto__", "constructor") can't
  // reach or change JavaScript's shared object machinery.
  it("only touches an object's own properties", () => {
    const target: Record<string, unknown> = {};
    setOwn(target, "__proto__", { polluted: true });
    setOwn(target, "constructor", "x");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.keys(target)).toEqual([]);
    expect(own({ a: 1 }, "toString")).toBeUndefined();
    expect(own({ a: 1 }, "a")).toBe(1);
    const t2: Record<string, unknown> = { a: 1 };
    deleteOwn(t2, "a");
    expect(t2).toEqual({});
  });

  // Proves a scraped Prometheus label called __proto__ is stored as data,
  // not as the object's prototype.
  it("keeps scraped label names as data", () => {
    const [s] = parsePrometheus('up{__proto__="x",job="a"} 1');
    expect(Object.getPrototypeOf(s.labels)).toBe(Object.prototype);
    expect(s.labels.job).toBe("a");
  });
});

describe("regular expressions from settings", () => {
  // Proves a pattern that would make JavaScript's own regex engine run for
  // minutes ("catastrophic backtracking") finishes instantly on RE2.
  it("can't stall the engine", () => {
    const start = Date.now();
    const re = compileUserRegex("(a+)+$");
    expect(re.test("a".repeat(5000) + "!")).toBe(false);
    expect(re.test("a".repeat(5000))).toBe(true);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  // Proves invalid and oversized patterns are refused with a readable error.
  it("refuses bad patterns", () => {
    expect(() => compileUserRegex("(unclosed")).toThrow(/Invalid pattern/);
    expect(() => compileUserRegex("a".repeat(1001))).toThrow(/longer/);
    expect(compileUserRegex("ERROR", { ignoreCase: true }).test("an error")).toBe(true);
    expect(compileUserRegex("web.*", { whole: true }).test("db1")).toBe(false);
  });
});

describe("file paths", () => {
  // Proves a runtime-built path can't escape its folder with "..", an
  // absolute path, or the folder itself.
  it("refuses paths outside the base folder", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "looksee-safefs-"));
    writeTextIn(base, "ok.txt", "hello");
    expect(readTextIn(base, "ok.txt")).toBe("hello");
    expect(existsIn(base, "ok.txt")).toBe(true);
    expect(() => within(base, "../../etc/passwd")).toThrow(/outside/);
    expect(() => within(base, path.resolve("/etc/passwd"))).toThrow(/outside/);
    expect(() => within(base, ".")).toThrow(/outside/);
    expect(existsIn(base, "..", "..", "etc", "passwd")).toBe(false);
    fs.rmSync(base, { recursive: true, force: true });
  });
});

describe("input shape checks", () => {
  // Proves IDs are checked by exact shape (no regex), so SQL fragments and
  // near-misses are refused before reaching the database.
  it("recognises UUIDs exactly", () => {
    expect(isUuid("3f2b8c1e-0a4d-4c5e-9f00-123456789abc")).toBe(true);
    expect(isUuid("3F2B8C1E-0A4D-4C5E-9F00-123456789ABC")).toBe(true);
    expect(isUuid("3f2b8c1e-0a4d-4c5e-9f00-123456789ab")).toBe(false);
    expect(isUuid("3f2b8c1e-0a4d-4c5e-9f00-123456789abg")).toBe(false);
    expect(isUuid("'; DROP TABLE checks;--000000000000000")).toBe(false);
    expect(isUuid(42)).toBe(false);
    expect(stripMappedIp("::ffff:10.0.0.5")).toBe("10.0.0.5");
    expect(isOid("1.3.6.1.2.1.1.3.0")).toBe(true);
    expect(isOid(".1.3.6.1")).toBe(true);
    expect(isOid("1.3.6.1; rm -rf /")).toBe(false);
    expect(isOid("1")).toBe(false);
  });

  // Proves wildcard exclusions match correctly and a crafted pattern can't
  // make matching slow.
  it("matches wildcards in bounded time", () => {
    expect(globMatch("veth*", "VETH3a2f")).toBe(true);
    expect(globMatch("eth?", "eth10")).toBe(false);
    expect(globMatch("*-migrate", "app-migrate")).toBe(true);
    expect(globMatch("a*b*c", "axxbyyc")).toBe(true);
    expect(nameExcluded("/snap/core/1", ["/snap/*"])).toBe(true);
    const start = Date.now();
    expect(globMatch("a*a*a*a*a*a*a*a*b", "a".repeat(3000))).toBe(false);
    expect(Date.now() - start).toBeLessThan(1000);
  });

  // Proves scanner/exploit paths are still recognised (and normal ones not).
  it("recognises scanner probes", () => {
    expect(looksLikeScan("/wp-login.php")).toBe(true);
    expect(looksLikeScan("/.ENV")).toBe(true);
    expect(looksLikeScan("/static/../../etc/passwd")).toBe(true);
    expect(looksLikeScan("/api/checks")).toBe(false);
    expect(looksLikeScan("/manage")).toBe(false);
  });
});
