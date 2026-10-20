// Software checks, from the 5.0 agent's software report (installed packages,
// upgradable packages, OS release — stored in endpoints.software):
//
//   host_packages   "Upgradable packages": how many packages have updates,
//                   listing them; Ubuntu phased updates left out unless asked.
//   host_software   "Installed software changed": packages added, removed or
//                   changed version since the baseline.
//   host_vulnerable "Vulnerable or unsupported software": known
//                   vulnerabilities from OSV.dev (OS packages, npm, pip,
//                   Composer — including lock files on the endpoint) and
//                   end-of-life dates from endoflife.date (the OS and
//                   runtimes like Node.js, Python, PHP, PostgreSQL).
//
// Where this sits: host_packages and host_software are evaluated when an
// agent reports (routes/agent.ts → evaluateReportChecks); host_vulnerable
// runs on the scheduler, by default every 6 hours (probes/index.ts).
//
// Privacy and security: host_vulnerable sends package names and versions
// (never anything else from the endpoint) to api.osv.dev, and product names to
// endoflife.date — both public, free services. Either lookup can be turned
// off per check. Their answers are cached (table external_cache) and only
// ever treated as data: shown as text, never run.
//
// Exclusions (kind "packages", plus the check's own Exclude setting) skip
// packages by name; an item that looks like an advisory ID (CVE-…, GHSA-…,
// USN-…) skips that one vulnerability. Text after " #" is the reason, shown
// with the result — e.g. "libssl1.1 # needed by the old ERP client".

import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { endpoints, externalCache } from "../db/schema.js";
import { applyThresholds, hasThresholds, type MeasuredResult, type Status } from "./thresholds.js";
import { excludeItems, nameExcluded } from "./probes/exclude.js";
import type { ProbeContext, ProbeOutcome } from "./probes/types.js";
import { own } from "../lib/own.js";

/** One installed package (short keys, as the agent sends them). */
export type SwPackage = { n: string; v: string; s: string; p?: string; o?: string };
/** One package with an update available. */
export type SwUpgradable = { name: string; current?: string; candidate?: string; security?: boolean; phased?: boolean; source: string };
/** The agent's software report. */
export type SoftwareReport = { collectedAt: number; os?: Record<string, string>; packages: SwPackage[]; upgradable: SwUpgradable[]; upgradableAt?: number; errors?: string[] };

// Limits on what's stored from an agent, so one report can't bloat the
// database: package counts and string lengths.
const MAX_PACKAGES = 30_000;
const MAX_UPGRADABLE = 5_000;
const str = (v: unknown, max = 200) => (typeof v === "string" ? v.slice(0, max) : "");

/**
 * Validates and trims the software report an agent sent. Unknown fields are
 * dropped; strings are capped.
 *
 * @param raw body.software from the agent's report
 * @returns the cleaned report, or null when it isn't one
 */
export function cleanSoftware(raw: unknown): SoftwareReport | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const packages: SwPackage[] = (Array.isArray(r.packages) ? r.packages : []).slice(0, MAX_PACKAGES).flatMap((p) => {
    const x = (p ?? {}) as Record<string, unknown>;
    const n = str(x.n);
    if (!n) return [];
    const out: SwPackage = { n, v: str(x.v, 100), s: str(x.s, 20) };
    if (x.p) out.p = str(x.p, 500);
    if (x.o) out.o = str(x.o);
    return [out];
  });
  const upgradable: SwUpgradable[] = (Array.isArray(r.upgradable) ? r.upgradable : []).slice(0, MAX_UPGRADABLE).flatMap((u) => {
    const x = (u ?? {}) as Record<string, unknown>;
    const name = str(x.name, 300);
    if (!name) return [];
    return [{ name, current: str(x.current, 100) || undefined, candidate: str(x.candidate, 100) || undefined, security: x.security === true, phased: x.phased === true, source: str(x.source, 30) }];
  });
  const os = r.os && typeof r.os === "object" ? Object.fromEntries(Object.entries(r.os as Record<string, unknown>).slice(0, 10).map(([k, v]) => [str(k, 30), str(v, 100)])) : undefined;
  return {
    collectedAt: Number(r.collectedAt) || 0,
    os,
    packages,
    upgradable,
    upgradableAt: Number(r.upgradableAt) || undefined,
    errors: Array.isArray(r.errors) ? r.errors.slice(0, 20).map((e) => str(e, 300)) : undefined,
  };
}

/**
 * The check's package exclusions, split into package names, advisory IDs and
 * the reasons given for each ("name # reason").
 */
export function packageExclusions(config: Record<string, unknown>) {
  const names: string[] = [];
  const advisories: string[] = [];
  const reasons = new Map<string, string>();
  for (const item of excludeItems(config.exclude, true)) {
    const [value, ...rest] = item.split(" #");
    const v = value.trim();
    if (!v) continue;
    // An advisory ID: letters, a dash, then letters/digits/dashes —
    // CVE-2024-3094, GHSA-xxxx-xxxx-xxxx, USN-6718-1, DSA-5650-1.
    if (/^[A-Z]{2,10}-[A-Za-z0-9-]+$/.test(v) && /\d/.test(v)) advisories.push(v.toUpperCase());
    else names.push(v);
    if (rest.length) reasons.set(v.toLowerCase(), rest.join(" #").trim());
  }
  return { names, advisories, reasons };
}

const yes = (v: unknown) => v === true || v === "true";

/**
 * host_packages — upgradable packages. Without thresholds: any security
 * update is a warn (or down, by setting); other updates are reported but
 * fine. With thresholds, they judge the count.
 *
 * @param sw the endpoint's software report
 * @param config includePhased, securityOnly, failOn ("security"|"any"|"none"),
 *   severity, exclude, and the usual value thresholds
 */
export function evaluatePackages(sw: SoftwareReport | null, config: Record<string, unknown>): MeasuredResult {
  if (!sw?.upgradableAt) return { status: "unknown", latencyMs: null, message: "No upgradable-package list yet — needs agent 5.0 or newer (it checks every 6 hours)" };
  const { names } = packageExclusions(config);
  const includePhased = yes(config.includePhased);
  const securityOnly = yes(config.securityOnly);
  const excluded = sw.upgradable.filter((u) => nameExcluded(u.name, names));
  const phased = sw.upgradable.filter((u) => u.phased && !nameExcluded(u.name, names));
  const listed = sw.upgradable.filter((u) => !nameExcluded(u.name, names) && (includePhased || !u.phased) && (!securityOnly || u.security));
  const security = listed.filter((u) => u.security).length;
  const shown = listed.slice(0, 10).map((u) => u.name).join(", ");
  const notes = [!includePhased && phased.length ? `${phased.length} phased held back` : "", excluded.length ? `${excluded.length} excluded` : ""].filter(Boolean).join(", ");
  const message = listed.length ? `${listed.length} upgradable${security ? ` (${security} security)` : ""}: ${shown}${listed.length > 10 ? ", …" : ""}${notes ? ` · ${notes}` : ""}` : `Up to date${notes ? ` (${notes})` : ""}`;
  const details = { packages: listed, phased: includePhased ? [] : phased.map((u) => u.name), excluded: excluded.map((u) => u.name), checkedAt: sw.upgradableAt };
  const base: MeasuredResult = { status: "up", latencyMs: null, message, value: listed.length, details };
  if (hasThresholds(config)) return applyThresholds(base, config);
  const failOn = String(config.failOn ?? "security");
  const bad = failOn === "any" ? listed.length > 0 : failOn === "security" ? security > 0 : false;
  return bad ? { ...base, status: String(config.severity ?? "warn") === "down" ? "down" : "warn" } : base;
}

/** "name@path" key for a package, so the same name in two lock files stays separate. */
const pkgKey = (p: SwPackage) => `${p.s}:${p.n}${p.p ? `@${p.p}` : ""}`;

/**
 * host_software — what changed since the baseline: packages added, removed,
 * or with a different version. The first report sets the baseline; a change
 * holds the failing status for holdMinutes, then the new state becomes the
 * baseline (like the other change checks).
 *
 * @param sw the endpoint's software report
 * @param config sources (comma list; blank = all), exclude, holdMinutes, severity
 * @param state the check's state from last time
 */
export function evaluateSoftwareChange(sw: SoftwareReport | null, config: Record<string, unknown>, state: Record<string, unknown>): { result: MeasuredResult; state: Record<string, unknown> } {
  if (!sw?.collectedAt) return { result: { status: "unknown", latencyMs: null, message: "No software report yet — needs agent 5.0 or newer" }, state };
  const sources = String(config.sources ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const { names } = packageExclusions(config);
  const current: Record<string, string> = {};
  for (const p of sw.packages) {
    if (sources.length && !sources.includes(p.s)) continue;
    if (nameExcluded(p.n, names)) continue;
    current[pkgKey(p)] = p.v;
  }
  const hash = crypto.createHash("sha256").update(JSON.stringify(Object.entries(current).sort())).digest("hex");
  const prev = state.items as Record<string, string> | undefined;
  const next: Record<string, unknown> = { ...state, hash, items: current };
  const count = Object.keys(current).length;
  if (prev && state.hash !== hash) {
    const label = (k: string) => k.replace(/^[^:]+:/, "");
    const added = Object.keys(current).filter((k) => !(k in prev));
    const removed = Object.keys(prev).filter((k) => !(k in current));
    const changed = Object.keys(current).filter((k) => Object.hasOwn(prev, k) && own(prev, k) !== own(current, k));
    const parts = [
      added.length ? `+ ${added.slice(0, 8).map((k) => `${label(k)} ${own(current, k)}`).join(", ")}${added.length > 8 ? ` (+${added.length - 8} more)` : ""}` : "",
      removed.length ? `− ${removed.slice(0, 8).map(label).join(", ")}${removed.length > 8 ? ` (+${removed.length - 8} more)` : ""}` : "",
      changed.length ? `~ ${changed.slice(0, 8).map((k) => `${label(k)} ${own(prev, k)} → ${own(current, k)}`).join(", ")}${changed.length > 8 ? ` (+${changed.length - 8} more)` : ""}` : "",
    ].filter(Boolean);
    next.changedAt = Date.now();
    next.lastChange = parts.join("  ");
    next.lastChangeDetail = { added: added.map(label), removed: removed.map(label), changed: changed.map((k) => ({ name: label(k), from: own(prev, k), to: own(current, k) })) };
  }
  const hold = Number(config.holdMinutes ?? 60) * 60_000;
  if (next.changedAt && Date.now() - Number(next.changedAt) < hold) {
    const status: Status = String(config.severity ?? "warn") === "down" ? "down" : "warn";
    return { result: { status, latencyMs: null, message: `Software changed: ${String(next.lastChange).slice(0, 600)}`, value: count, details: next.lastChangeDetail }, state: next };
  }
  return { result: { status: "up", latencyMs: null, message: prev ? `No change (${count} packages)` : `Baseline recorded (${count} packages)`, value: count }, state: next };
}

// ---- host_vulnerable: OSV.dev and endoflife.date ----

const OSV_URL = "https://api.osv.dev/v1";
const EOL_URL = "https://endoflife.date/api";
const DAY = 86_400_000;

/**
 * Reads a cached answer, or fetches and caches it.
 *
 * @param key cache key, e.g. "eol:nodejs"
 * @param maxAgeMs how old a cached answer may be
 * @param fetcher gets a fresh answer
 */
async function cached<T>(key: string, maxAgeMs: number, fetcher: () => Promise<T>): Promise<T> {
  const row = await db.query.externalCache.findFirst({ where: eq(externalCache.key, key) });
  if (row && Date.now() - row.fetchedAt.getTime() < maxAgeMs) return row.value as T;
  const value = await fetcher();
  await db
    .insert(externalCache)
    .values({ key, value: value as object, fetchedAt: new Date() })
    .onConflictDoUpdate({ target: externalCache.key, set: { value: value as object, fetchedAt: new Date() } });
  return value;
}

/** GET/POST JSON with a timeout; non-2xx answers are errors. */
async function fetchJson(url: string, body?: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: body ? "POST" : "GET",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.json();
}

/**
 * The OSV.dev ecosystem for a package, or null when OSV doesn't cover it
 * (Windows programs, macOS apps, runtimes — those get end-of-life checks).
 *
 * @param p the package
 * @param os the endpoint's OS release (id, versionId)
 */
export function osvEcosystem(p: SwPackage, os: Record<string, string> | undefined): string | null {
  const id = (os?.id ?? "").toLowerCase();
  const ver = os?.versionId ?? "";
  switch (p.s) {
    case "npm":
      return "npm";
    case "pip":
      return "PyPI";
    case "composer":
      return "Packagist";
    case "dpkg":
      if (id === "ubuntu" && ver) {
        // Ubuntu LTS releases are April releases of even years (22.04, 24.04).
        const [yy, mm] = ver.split(".").map(Number);
        return yy % 2 === 0 && mm === 4 ? `Ubuntu:${ver}:LTS` : `Ubuntu:${ver}`;
      }
      if (id === "debian" && ver) return `Debian:${ver.split(".")[0]}`;
      return null;
    case "apk":
      return id === "alpine" && ver ? `Alpine:v${ver.split(".").slice(0, 2).join(".")}` : null;
    case "rpm":
      if (id === "rocky" && ver) return `Rocky Linux:${ver.split(".")[0]}`;
      if (id === "almalinux" && ver) return `AlmaLinux:${ver.split(".")[0]}`;
      return null;
    default:
      return null;
  }
}

type Vuln = { id: string; severity: string; summary: string };

/** A severity word from an OSV record: critical, high, medium, low or unknown. */
export function osvSeverity(record: Record<string, unknown>): string {
  const words = ["critical", "high", "medium", "moderate", "low", "negligible"];
  const pick = (v: unknown) => {
    const w = String(v ?? "").toLowerCase();
    const hit = words.find((x) => w.includes(x));
    return hit === "moderate" ? "medium" : hit === "negligible" ? "low" : hit;
  };
  const dbs = record.database_specific as Record<string, unknown> | undefined;
  const fromDb = pick(dbs?.severity);
  if (fromDb) return fromDb;
  for (const s of (record.severity as { type?: string; score?: string }[] | undefined) ?? []) {
    const w = pick(s.score);
    if (w) return w;
    // A CVSS vector: estimate from impact letters (H = high impact).
    if (s.score?.startsWith("CVSS:")) {
      const highs = (s.score.match(/[CIA]:H/g) ?? []).length;
      return highs >= 2 ? "high" : highs === 1 ? "medium" : "low";
    }
  }
  for (const a of (record.affected as { ecosystem_specific?: { severity?: string }; database_specific?: { severity?: string } }[] | undefined) ?? []) {
    const w = pick(a.ecosystem_specific?.severity ?? a.database_specific?.severity);
    if (w) return w;
  }
  return "unknown";
}

const SEVERITY_RANK: Record<string, number> = { unknown: 2, low: 1, medium: 2, high: 3, critical: 4 };

/**
 * Looks up known vulnerabilities for many packages at once (OSV.dev
 * querybatch, up to 1000 per request), then each vulnerability's severity
 * and summary (cached for a week).
 */
async function osvLookup(queries: { name: string; ecosystem: string; version: string }[]): Promise<Map<number, Vuln[]>> {
  const out = new Map<number, Vuln[]>();
  const ids = new Set<string>();
  const hits: { index: number; ids: string[] }[] = [];
  for (let start = 0; start < queries.length; start += 1000) {
    const chunk = queries.slice(start, start + 1000);
    const res = (await fetchJson(`${OSV_URL}/querybatch`, { queries: chunk.map((q) => ({ package: { name: q.name, ecosystem: q.ecosystem }, version: q.version })) })) as { results?: { vulns?: { id: string }[] }[] };
    (res.results ?? []).forEach((r, i) => {
      const list = (r.vulns ?? []).map((v) => v.id);
      if (list.length) {
        hits.push({ index: start + i, ids: list });
        list.forEach((id) => ids.add(id));
      }
    });
  }
  // Details for at most 300 distinct vulnerabilities per run.
  const details = new Map<string, Vuln>();
  for (const id of [...ids].slice(0, 300)) {
    try {
      const rec = await cached(`osv:${id}`, 7 * DAY, async () => {
        const r = (await fetchJson(`${OSV_URL}/vulns/${encodeURIComponent(id)}`)) as Record<string, unknown>;
        return { id, severity: osvSeverity(r), summary: String(r.summary ?? (r.details as string | undefined)?.slice(0, 200) ?? ""), aliases: r.aliases ?? [] };
      });
      details.set(id, rec as Vuln);
    } catch {
      details.set(id, { id, severity: "unknown", summary: "" });
    }
  }
  for (const h of hits) out.set(h.index, h.ids.map((id) => details.get(id) ?? { id, severity: "unknown", summary: "" }));
  return out;
}

type EolCycle = { cycle: string; eol: string | boolean; latest?: string };

/**
 * Products checked for end of life, and how to find each one's release
 * cycle on this endpoint: from the OS release, or from a package's version.
 * The cycle is the part of the version endoflife.date lists ("22.04",
 * "20" for Node.js 20.x, "3.12" for Python, "16" for PostgreSQL).
 */
function eolTargets(sw: SoftwareReport): { product: string; label: string; cycle: string }[] {
  const out: { product: string; label: string; cycle: string }[] = [];
  const os = sw.os ?? {};
  const id = (os.id ?? "").toLowerCase();
  const ver = os.versionId ?? "";
  const major = (v: string) => v.split(".")[0];
  const majorMinor = (v: string) => v.split(".").slice(0, 2).join(".");
  if (ver) {
    const osProducts: Record<string, [string, (v: string) => string]> = {
      ubuntu: ["ubuntu", (v) => v],
      debian: ["debian", major],
      alpine: ["alpine", majorMinor],
      rocky: ["rocky-linux", major],
      almalinux: ["almalinux", major],
      rhel: ["rhel", major],
      centos: ["centos", major],
      fedora: ["fedora", major],
      opensuse_leap: ["opensuse", majorMinor],
    };
    const p = own(osProducts, id);
    if (p) out.push({ product: p[0], label: os.name || `${id} ${ver}`, cycle: p[1](ver) });
  }
  const find = (pred: (p: SwPackage) => boolean) => sw.packages.find(pred);
  const node = find((p) => p.s === "runtime" && p.n === "node");
  if (node) out.push({ product: "nodejs", label: `Node.js ${node.v}`, cycle: major(node.v) });
  const py = find((p) => p.s === "runtime" && p.n === "python");
  if (py) out.push({ product: "python", label: `Python ${py.v}`, cycle: majorMinor(py.v) });
  const php = find((p) => p.s === "runtime" && p.n === "php");
  if (php) out.push({ product: "php", label: `PHP ${php.v}`, cycle: majorMinor(php.v) });
  // Database servers by package name: postgresql-16, mariadb-server-10.6 …
  for (const p of sw.packages) {
    const pg = /^postgresql-(\d+)$/.exec(p.n);
    if (pg) out.push({ product: "postgresql", label: `PostgreSQL ${pg[1]}`, cycle: pg[1] });
    if (/^mariadb-server(?:-core|)(?:-[\d.]+|)$/.test(p.n)) out.push({ product: "mariadb", label: `MariaDB ${p.v}`, cycle: majorMinor(p.v.replace(/^\d+:/, "")) });
    if (/^mysql-server(?:-core|)(?:-[\d.]+|)$/.test(p.n)) out.push({ product: "mysql", label: `MySQL ${p.v}`, cycle: majorMinor(p.v.replace(/^\d+:/, "")) });
  }
  // One entry per product+cycle.
  const seen = new Set<string>();
  return out.filter((t) => (seen.has(`${t.product}:${t.cycle}`) ? false : (seen.add(`${t.product}:${t.cycle}`), true)));
}

/**
 * host_vulnerable — the scheduled check (see the file header).
 *
 * @param config useOsv / useEol (default on), warnAt / downAt (severity
 *   words; default medium / high), eolStatus (down|warn), eolWarnDays
 *   (default 90), exclude, lockfiles (sent to the agent)
 * @param ctx the check's endpoint
 */
export async function probeVulnerable(config: Record<string, unknown>, ctx: ProbeContext): Promise<ProbeOutcome> {
  if (!ctx.endpointId) return { status: "warn", latencyMs: null, message: "This check needs an endpoint" };
  const row = await db.query.endpoints.findFirst({ where: eq(endpoints.id, ctx.endpointId), columns: { software: true } });
  const sw = (row?.software as SoftwareReport | null) ?? null;
  if (!sw?.collectedAt) return { status: "unknown", latencyMs: null, message: "No software report yet — needs agent 5.0 or newer (it lists software every 6 hours)" };
  const { names, advisories, reasons } = packageExclusions(config);
  const started = Date.now();
  const vulnerable: { name: string; version: string; source: string; path?: string; vulns: Vuln[] }[] = [];
  const unsupported: { product: string; label: string; cycle: string; eol: string; status: "eol" | "soon" }[] = [];
  const excludedPkgs = new Set<string>();
  const problems: string[] = [];

  if (config.useOsv !== false && config.useOsv !== "false") {
    // One query per distinct ecosystem + name + version. Debian/Ubuntu are
    // asked about the source package (o), which is what their data names.
    const queries: { name: string; ecosystem: string; version: string; pkg: SwPackage }[] = [];
    const seen = new Set<string>();
    for (const p of sw.packages) {
      if (nameExcluded(p.n, names) || (p.o && nameExcluded(p.o, names))) {
        excludedPkgs.add(p.n);
        continue;
      }
      const ecosystem = osvEcosystem(p, sw.os);
      if (!ecosystem || !p.v) continue;
      const name = p.s === "dpkg" && p.o ? p.o : p.n;
      const key = `${ecosystem}|${name}|${p.v}`;
      if (seen.has(key)) continue;
      seen.add(key);
      queries.push({ name, ecosystem, version: p.v, pkg: p });
    }
    try {
      const results = await osvLookup(queries);
      for (const [i, vulns] of results) {
        const kept = vulns.filter((v) => !advisories.includes(v.id.toUpperCase()));
        const q = queries.at(i);
        if (kept.length && q) vulnerable.push({ name: q.name, version: q.version, source: q.pkg.s, path: q.pkg.p, vulns: kept });
      }
    } catch (err) {
      problems.push(`OSV.dev lookup failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (config.useEol !== false && config.useEol !== "false") {
    const warnDays = Number(config.eolWarnDays ?? 90);
    for (const t of eolTargets(sw)) {
      if (nameExcluded(t.product, names)) continue;
      try {
        const cycles = await cached(`eol:${t.product}`, DAY, async () => (await fetchJson(`${EOL_URL}/${encodeURIComponent(t.product)}.json`)) as EolCycle[]);
        const c = cycles.find((x) => String(x.cycle) === t.cycle);
        if (!c || typeof c.eol === "boolean") {
          if (c?.eol === true) unsupported.push({ ...t, eol: "ended", status: "eol" });
          continue;
        }
        const daysLeft = (new Date(c.eol).getTime() - Date.now()) / DAY;
        if (daysLeft < 0) unsupported.push({ ...t, eol: c.eol, status: "eol" });
        else if (daysLeft < warnDays) unsupported.push({ ...t, eol: c.eol, status: "soon" });
      } catch (err) {
        problems.push(`endoflife.date (${t.product}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Status: the worst vulnerability severity against warnAt/downAt, and
  // end-of-life (eolStatus) / soon (warn).
  const rank = (w: unknown, d: number) => SEVERITY_RANK[String(w ?? "")] ?? d;
  const warnAt = rank(config.warnAt ?? "medium", 2);
  const downAt = rank(config.downAt ?? "high", 3);
  const worst = Math.max(0, ...vulnerable.flatMap((v) => v.vulns.map((x) => SEVERITY_RANK[x.severity] ?? 2)));
  let status: Status = worst >= downAt ? "down" : worst >= warnAt ? "warn" : "up";
  const ended = unsupported.filter((u) => u.status === "eol");
  if (ended.length) status = String(config.eolStatus ?? "down") === "warn" ? (status === "down" ? "down" : "warn") : "down";
  if (unsupported.some((u) => u.status === "soon") && status === "up") status = "warn";
  if (problems.length && !vulnerable.length && !unsupported.length && status === "up") status = "unknown";

  const parts = [
    vulnerable.length ? `${vulnerable.length} vulnerable package(s): ${vulnerable.slice(0, 6).map((v) => `${v.name} ${v.version} (${v.vulns.length})`).join(", ")}${vulnerable.length > 6 ? ", …" : ""}` : "",
    ended.length ? `unsupported: ${ended.map((u) => `${u.label} (EOL ${u.eol})`).join(", ")}` : "",
    unsupported.filter((u) => u.status === "soon").map((u) => `${u.label} reaches end of life ${u.eol}`).join(", "),
    problems.join("; "),
  ].filter(Boolean);
  const excluded = [...excludedPkgs].map((n) => ({ name: n, reason: reasons.get(n.toLowerCase()) ?? null })).concat(advisories.map((a) => ({ name: a, reason: reasons.get(a.toLowerCase()) ?? null })));
  return {
    status,
    latencyMs: Date.now() - started,
    message: parts.length ? parts.join(" · ").slice(0, 1500) : `No known vulnerabilities or unsupported software (${sw.packages.length} packages checked)`,
    value: vulnerable.length,
    details: { vulnerable, unsupported, excluded, problems, checkedPackages: sw.packages.length },
  };
}

/**
 * The lock files the agent should read for an endpoint: the `lockfiles`
 * setting of its enabled software checks, one path per line. Only paths
 * ending in a known lock-file name are passed on (the agent checks again).
 */
export const LOCKFILE_NAMES = ["package-lock.json", "npm-shrinkwrap.json", "Pipfile.lock", "requirements.txt", "composer.lock"];
export function lockfilesFrom(configs: Record<string, unknown>[]): string[] {
  const paths = new Set<string>();
  for (const c of configs) {
    for (const p of excludeItems(c.lockfiles)) {
      const base = p.split(/[\\/]/).pop() ?? "";
      if (LOCKFILE_NAMES.includes(base) && p.length <= 500) paths.add(p);
    }
  }
  return [...paths].slice(0, 50);
}
