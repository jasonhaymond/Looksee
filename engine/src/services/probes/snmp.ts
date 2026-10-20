// SNMP: sessions (v1/v2c/v3), reading one value or a walked subtree, ready-made
// templates (printers, UPS, CPU/memory/disk, sensors, reboots), calculations on
// the value and extra OIDs, the interface table check, and the walk browser.
//
// Runs on the engine and on site collectors. Row and interface filters run on
// RE2 (lib/userRegex.ts); calculations use the safe calculator
// (probes/expression.ts).

import * as snmp from "net-snmp";
import { worst } from "../thresholds.js";
import { type Config, type ProbeContext, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { excludeItems, nameExcluded } from "./exclude.js";
import { evaluateExpression } from "./expression.js";
import { own, setOwn } from "../../lib/own.js";
import { compileUserRegex, type UserRegex } from "../../lib/userRegex.js";
import { isOid } from "./mibs.js";

const AUTH: Record<string, snmp.AuthProtocols> = {
  md5: snmp.AuthProtocols.md5,
  sha: snmp.AuthProtocols.sha,
  sha224: snmp.AuthProtocols.sha224,
  sha256: snmp.AuthProtocols.sha256,
  sha384: snmp.AuthProtocols.sha384,
  sha512: snmp.AuthProtocols.sha512,
};
const PRIV: Record<string, snmp.PrivProtocols> = {
  des: snmp.PrivProtocols.des,
  aes: snmp.PrivProtocols.aes,
  aes256b: snmp.PrivProtocols.aes256b,
  aes256r: snmp.PrivProtocols.aes256r,
};
const LEVELS: Record<string, snmp.SecurityLevel> = {
  noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
  authNoPriv: snmp.SecurityLevel.authNoPriv,
  authPriv: snmp.SecurityLevel.authPriv,
};

export function openSnmpSession(config: Config): snmp.Session {
  const host = str(config, "host");
  const options = { port: numOr(config, "port", 161), timeout: 5000, retries: 1 };
  if (str(config, "version", "2c") === "3") {
    // Unknown protocol names are rejected rather than silently falling back
    // to SHA/AES (a pre-3.0 bug: picking SHA-256 in the form quietly used
    // SHA-1, which then failed auth with no hint why).
    const authName = str(config, "authProtocol", "sha");
    const privName = str(config, "privProtocol", "aes");
    const authProtocol = own(AUTH, authName);
    const privProtocol = own(PRIV, privName);
    if (authProtocol === undefined) throw new Error(`Unsupported SNMPv3 auth protocol: ${authName}`);
    if (privProtocol === undefined) throw new Error(`Unsupported SNMPv3 privacy protocol: ${privName}`);
    const user: snmp.User = {
      name: str(config, "username"),
      level: LEVELS[str(config, "securityLevel")] ?? snmp.SecurityLevel.authPriv,
      authProtocol,
      authKey: str(config, "authKey"),
      privProtocol,
      privKey: str(config, "privKey"),
    };
    return snmp.createV3Session(host, user, options);
  }
  return snmp.createSession(host, str(config, "community", "public"), { ...options, version: str(config, "version") === "1" ? snmp.Version1 : snmp.Version2c });
}

// net-snmp hands Counter64 values (ifHCInOctets and friends) back as the
// raw big-endian bytes, not a number — decoding them is what makes 64-bit
// interface counters and custom Counter64 OIDs read as numbers at all.
export function decodeVarbindValue(vb: { type?: number; value?: unknown }): unknown {
  if (vb.type === snmp.ObjectType.Counter64 && Buffer.isBuffer(vb.value)) {
    let n = 0n;
    for (const byte of vb.value) n = (n << 8n) | BigInt(byte);
    return Number(n);
  }
  return vb.value;
}

const COUNTER_TYPES = new Set<number>([snmp.ObjectType.Counter, snmp.ObjectType.Counter64]);
const TYPE_NAMES: Record<number, string> = {
  [snmp.ObjectType.Integer]: "Integer",
  [snmp.ObjectType.OctetString]: "OctetString",
  [snmp.ObjectType.OID]: "OID",
  [snmp.ObjectType.IpAddress]: "IpAddress",
  [snmp.ObjectType.Counter]: "Counter32",
  [snmp.ObjectType.Gauge]: "Gauge32",
  [snmp.ObjectType.TimeTicks]: "TimeTicks",
  [snmp.ObjectType.Opaque]: "Opaque",
  [snmp.ObjectType.Counter64]: "Counter64",
  [snmp.ObjectType.Boolean]: "Boolean",
  [snmp.ObjectType.Null]: "Null",
};

function snmpGet(session: snmp.Session, oids: string[]): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, vbs) => (err ? reject(err) : resolve((vbs ?? []).map((vb) => ({ ...vb, value: decodeVarbindValue(vb) }) as snmp.Varbind))));
  });
}

export type WalkRow = { oid: string; suffix: string; type: string; value: unknown; counter: boolean };

// Every leaf under `oid` with its type, in device order. maxRows stops a
// whole-device walk of a big switch from running away.
export function snmpWalkRows(session: snmp.Session, oid: string, maxRows = 10_000): Promise<WalkRow[]> {
  return new Promise((resolve, reject) => {
    const rows: WalkRow[] = [];
    session.subtree(
      oid,
      20,
      (vbs) => {
        for (const vb of vbs) {
          if (snmp.isVarbindError(vb)) continue;
          if (rows.length >= maxRows) return true;
          rows.push({ oid: vb.oid, suffix: vb.oid.slice(oid.length + 1), type: vb.type != null ? (TYPE_NAMES[vb.type] ?? String(vb.type)) : "unknown", value: decodeVarbindValue(vb), counter: vb.type != null && COUNTER_TYPES.has(vb.type) });
        }
      },
      (err) => (err ? reject(err) : resolve(rows))
    );
  });
}

// Every leaf under `oid`, keyed by the suffix after it (e.g. ".2" or "1.5").
export async function snmpWalk(session: snmp.Session, oid: string): Promise<Map<string, unknown>> {
  return new Map((await snmpWalkRows(session, oid)).map((r) => [r.suffix, r.value]));
}

export const toNum = (v: unknown) => (Buffer.isBuffer(v) ? Number(v.toString()) : typeof v === "bigint" ? Number(v) : v == null || v === "" ? NaN : Number(v));
const toStr = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf-8").replace(/\0/g, "") : String(v ?? ""));

// How a walk shows a value: printable text as text, binary (MAC
// addresses, bitmasks) as colon-separated hex.
export function displayValue(v: unknown): string {
  if (Buffer.isBuffer(v)) {
    const printable = v.length > 0 && [...v].every((b) => b === 0 || b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));
    return printable ? toStr(v) : v.toString("hex").replace(/(..)(?!$)/g, "$1:");
  }
  return String(v ?? "");
}

// Column -> index -> value, from a walk of a table's entry OID.
function columns(walk: Map<string, unknown>): Map<string, Map<string, unknown>> {
  const cols = new Map<string, Map<string, unknown>>();
  for (const [suffix, value] of walk) {
    const dot = suffix.indexOf(".");
    if (dot < 0) continue;
    const col = suffix.slice(0, dot);
    if (!cols.has(col)) cols.set(col, new Map());
    cols.get(col)!.set(suffix.slice(dot + 1), value);
  }
  return cols;
}

// hrPrinterDetectedErrorState bits, in order (RFC 2790/3805).
const PRINTER_ERROR_BITS: [string, "warn" | "down"][] = [
  ["low paper", "warn"],
  ["no paper", "down"],
  ["low toner", "warn"],
  ["no toner", "down"],
  ["door open", "down"],
  ["jammed", "down"],
  ["offline", "down"],
  ["service requested", "down"],
  ["input tray missing", "down"],
  ["output tray missing", "down"],
  ["marker supply missing", "down"],
  ["output tray nearly full", "warn"],
  ["output tray full", "down"],
  ["input tray empty", "warn"],
  ["overdue preventive maintenance", "warn"],
];

type PresetResult = { value: number | null; message: string; details?: unknown; status?: "up" | "warn" | "down" };

// H2: common device templates. Each preset reads standard MIBs (no vendor
// MIB files needed) and boils them down to one value + a readable message.
export const SNMP_PRESETS: Record<string, (s: snmp.Session, c: Config, ctx: ProbeContext) => Promise<PresetResult & { state?: Record<string, unknown> }>> = {
  async hr_cpu(s) {
    const loads = [...(await snmpWalk(s, "1.3.6.1.2.1.25.3.3.1.2")).values()].map(toNum);
    if (!loads.length) return { value: null, message: "Device doesn't expose hrProcessorLoad" };
    const avg = loads.reduce((a, b) => a + b, 0) / loads.length;
    return { value: Math.round(avg * 10) / 10, message: `CPU ${avg.toFixed(1)}% across ${loads.length} core(s)` };
  },
  async hr_memory(s) {
    const cols = columns(await snmpWalk(s, "1.3.6.1.2.1.25.2.3.1"));
    for (const [idx, type] of cols.get("2") ?? []) {
      if (String(type) !== "1.3.6.1.2.1.25.2.1.2") continue;
      const size = toNum(cols.get("5")?.get(idx));
      const used = toNum(cols.get("6")?.get(idx));
      if (size > 0) return { value: Math.round((used / size) * 1000) / 10, message: `Memory ${((used / size) * 100).toFixed(1)}% used` };
    }
    return { value: null, message: "Device doesn't expose hrStorageRam" };
  },
  async hr_storage(s, c) {
    const cols = columns(await snmpWalk(s, "1.3.6.1.2.1.25.2.3.1"));
    const filter = str(c, "instance").toLowerCase();
    const disks: { name: string; percent: number }[] = [];
    for (const [idx, type] of cols.get("2") ?? []) {
      if (String(type) !== "1.3.6.1.2.1.25.2.1.4") continue;
      const name = toStr(cols.get("3")?.get(idx));
      if (filter && !name.toLowerCase().includes(filter)) continue;
      const size = toNum(cols.get("5")?.get(idx));
      if (size > 0) disks.push({ name, percent: Math.round((toNum(cols.get("6")?.get(idx)) / size) * 1000) / 10 });
    }
    if (!disks.length) return { value: null, message: "No matching fixed disks in hrStorageTable" };
    const top = disks.reduce((a, b) => (b.percent > a.percent ? b : a));
    return { value: top.percent, message: `${top.name} ${top.percent}% used`, details: disks };
  },
  async printer_supplies(s) {
    const cols = columns(await snmpWalk(s, "1.3.6.1.2.1.43.11.1.1"));
    const supplies: { name: string; percent: number | null }[] = [];
    for (const [idx, desc] of cols.get("6") ?? []) {
      const max = toNum(cols.get("8")?.get(idx));
      const level = toNum(cols.get("9")?.get(idx));
      // -2 unknown, -3 "some remaining"; neither is a percentage.
      supplies.push({ name: toStr(desc), percent: max > 0 && level >= 0 ? Math.round((level / max) * 100) : null });
    }
    const known = supplies.filter((x) => x.percent != null) as { name: string; percent: number }[];
    if (!known.length) return { value: null, message: "Printer reports no measurable supply levels", details: supplies };
    const low = known.reduce((a, b) => (b.percent < a.percent ? b : a));
    return { value: low.percent, message: `Lowest supply: ${low.name} ${low.percent}%`, details: supplies };
  },
  // HOST-RESOURCES hrPrinterDetectedErrorState is a bitmask (bit 0 = the
  // first byte's high bit); the Printer-MIB alert table adds the printer's
  // own wording ("Paper jam in tray 2").
  async printer_status(s) {
    const errorState = await snmpWalk(s, "1.3.6.1.2.1.25.3.5.1.2").catch(() => new Map<string, unknown>());
    const printerStatus = await snmpWalk(s, "1.3.6.1.2.1.25.3.5.1.1").catch(() => new Map<string, unknown>());
    const alerts = columns(await snmpWalk(s, "1.3.6.1.2.1.43.18.1.1").catch(() => new Map<string, unknown>()));
    if (!errorState.size && !printerStatus.size && !alerts.size) return { value: null, message: "Device doesn't expose the Printer MIB / hrPrinterTable" };
    const conditions: { name: string; severity: "warn" | "down" }[] = [];
    for (const raw of errorState.values()) {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.alloc(0);
      PRINTER_ERROR_BITS.forEach(([name, severity], bit) => {
        const byte = bytes[Math.floor(bit / 8)] ?? 0;
        if (byte & (0x80 >> bit % 8)) conditions.push({ name, severity });
      });
    }
    const alertRows: { severity: string; description: string; code: number }[] = [];
    for (const [idx, sev] of alerts.get("2") ?? []) {
      const level = toNum(sev);
      alertRows.push({ severity: level === 3 ? "critical" : level === 4 || level === 5 ? "warning" : "other", description: toStr(alerts.get("8")?.get(idx)), code: toNum(alerts.get("7")?.get(idx)) });
    }
    const state = toNum([...printerStatus.values()][0]);
    const stateName = own({ 1: "other", 2: "unknown", 3: "idle", 4: "printing", 5: "warming up" } as Record<number, string>, state) ?? "unknown";
    const critical = conditions.filter((c) => c.severity === "down").map((c) => c.name);
    const warnings = conditions.filter((c) => c.severity === "warn").map((c) => c.name);
    const critAlerts = alertRows.filter((a) => a.severity === "critical" && a.description).map((a) => a.description);
    const status: PresetResult["status"] = critical.length || critAlerts.length ? "down" : warnings.length || alertRows.some((a) => a.severity === "warning") ? "warn" : "up";
    const parts = [...new Set([...critical, ...critAlerts, ...warnings, ...alertRows.filter((a) => a.severity === "warning").map((a) => a.description)])].filter(Boolean);
    return { value: conditions.length + alertRows.length, status, message: parts.length ? `${stateName}: ${parts.slice(0, 4).join("; ")}` : `Printer ${stateName}, no errors`, details: { conditions, alerts: alertRows } };
  },
  // RFC 2707 Job Monitoring MIB (jmJobTable). Not every printer implements
  // it; those that do keep finished jobs for a while, so a job is counted
  // once — the first time it's seen aborted or stopped.
  async printer_jobs(s, c, ctx) {
    const jobs = columns(await snmpWalk(s, "1.3.6.1.4.1.2699.1.1.1.3.1.1").catch(() => new Map<string, unknown>()));
    const states = jobs.get("2");
    if (!states?.size) return { value: null, message: "Printer doesn't expose the Job Monitoring MIB (RFC 2707) — use the printer status template instead" };
    const seen = new Set((ctx.state.failedJobs as string[] | undefined) ?? []);
    const firstRun = ctx.state.failedJobs === undefined;
    const includeCanceled = bool(c, "countCanceled");
    const failedNow: { job: string; state: string; owner: string }[] = [];
    let active = 0;
    for (const [idx, raw] of states) {
      const st = toNum(raw);
      if (st >= 3 && st <= 6) active++;
      const failed = st === 8 || st === 6 || (includeCanceled && st === 7);
      if (failed) failedNow.push({ job: idx, state: st === 8 ? "aborted" : st === 6 ? "stopped" : "canceled", owner: toStr(jobs.get("9")?.get(idx)) });
    }
    const fresh = firstRun ? [] : failedNow.filter((j) => !seen.has(j.job));
    const state = { failedJobs: failedNow.map((j) => j.job).slice(-500), lastFailureAt: fresh.length ? new Date().toISOString() : (ctx.state.lastFailureAt as string | undefined), lastFailure: fresh.length ? fresh.map((j) => `${j.job} ${j.state}${j.owner ? ` (${j.owner})` : ""}`).join(", ") : ctx.state.lastFailure };
    const hold = numOr(c, "holdMinutes", 15) * 60_000;
    const recent = state.lastFailureAt && Date.now() - new Date(state.lastFailureAt).getTime() < hold;
    return {
      value: fresh.length,
      status: recent ? (str(c, "severity", "warn") === "down" ? "down" : "warn") : "up",
      message: recent ? `Failed print job(s): ${state.lastFailure}` : `${active} active job(s), no new failures`,
      details: failedNow.slice(0, 50),
      state,
    };
  },
  async ups_battery(s) {
    const [vb] = await snmpGet(s, ["1.3.6.1.2.1.33.1.2.4.0"]);
    return { value: toNum(vb.value), message: `Battery ${toNum(vb.value)}%` };
  },
  async ups_runtime(s) {
    const [vb] = await snmpGet(s, ["1.3.6.1.2.1.33.1.2.3.0"]);
    return { value: toNum(vb.value), message: `${toNum(vb.value)} min runtime remaining` };
  },
  async ups_on_battery(s) {
    const [vb] = await snmpGet(s, ["1.3.6.1.2.1.33.1.4.1.0"]);
    const source = toNum(vb.value);
    const names: Record<number, string> = { 1: "other", 2: "none", 3: "normal (utility)", 4: "bypass", 5: "battery", 6: "booster", 7: "reducer" };
    return { value: source, message: `Output source: ${own(names, source) ?? source}`, status: source === 5 ? "warn" : source === 2 ? "down" : "up" };
  },
  async uptime_reboot(s, c, ctx) {
    const [vb] = await snmpGet(s, ["1.3.6.1.2.1.1.3.0"]);
    const ticks = toNum(vb.value);
    const hours = ticks / 360000;
    const prev = ctx.state.ticks as number | undefined;
    const rebootedAt = prev != null && ticks < prev ? new Date().toISOString() : (ctx.state.rebootedAt as string | undefined);
    const state = { ticks, rebootedAt };
    const hold = numOr(c, "holdMinutes", 15) * 60_000;
    if (rebootedAt && Date.now() - new Date(rebootedAt).getTime() < hold) return { value: hours, message: `Device rebooted (up ${hours.toFixed(2)}h)`, status: "warn", state };
    return { value: Math.round(hours * 10) / 10, message: `Up ${hours >= 48 ? `${(hours / 24).toFixed(1)} days` : `${hours.toFixed(1)} h`}`, state };
  },
  async sensor_temp_max(s) {
    const cols = columns(await snmpWalk(s, "1.3.6.1.2.1.99.1.1.1"));
    const temps: number[] = [];
    for (const [idx, type] of cols.get("1") ?? []) {
      if (toNum(type) !== 8) continue; // celsius
      const scale = toNum(cols.get("2")?.get(idx));
      const precision = toNum(cols.get("3")?.get(idx)) || 0;
      const raw = toNum(cols.get("4")?.get(idx));
      temps.push(raw * 10 ** ((scale - 9) * 3) / 10 ** precision);
    }
    if (!temps.length) return { value: null, message: "Device exposes no ENTITY-SENSOR temperatures" };
    const max = Math.max(...temps);
    return { value: Math.round(max * 10) / 10, message: `Hottest sensor ${max.toFixed(1)}°C of ${temps.length}` };
  },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

function aggregate(values: number[], how: string): number {
  if (how === "sum") return values.reduce((a, b) => a + b, 0);
  if (how === "min") return Math.min(...values);
  if (how === "max") return Math.max(...values);
  if (how === "count") return values.length;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Walk modes. With "as a rate", each row's counter is turned into a per-
// second rate on its own (against that row's previous reading) before the
// rows are combined — so "busiest port" or "sum of all ports" is right even
// when one counter resets. walk_all keeps every row in the result details,
// which is what the full-walk view of a check shows.
async function walkCheck(session: snmp.Session, oid: string, mode: string, config: Config, ctx: ProbeContext, start: number, scale: number, unit: string): Promise<ProbeOutcome> {
  const rows = await snmpWalkRows(session, oid, mode === "walk_all" ? numOr(config, "maxRows", 2000) : 10_000);
  const latencyMs = Date.now() - start;
  if (!rows.length) return down(`Nothing under ${oid}`);
  const filter = str(config, "indexFilter");
  // The admin's row filter runs on RE2 (lib/userRegex.ts): no catastrophic backtracking.
  let re: UserRegex | null = null;
  try {
    re = filter ? compileUserRegex(filter) : null;
  } catch {
    return warn(`Invalid row filter regex: ${filter}`);
  }
  const picked = re ? rows.filter((r) => re!.test(r.suffix)) : rows;
  const asRate = bool(config, "asRate");
  const now = Date.now();
  const prev = (ctx.state.rows ?? {}) as Record<string, number>;
  const prevAt = ctx.state.at as number | undefined;
  const elapsed = prevAt ? (now - prevAt) / 1000 : 0;
  const raw: Record<string, number> = {};
  const details: { oid: string; type: string; value: string; rate?: number | null }[] = [];
  const numbers: number[] = [];
  for (const r of picked) {
    const n = toNum(r.value);
    const numeric = !Number.isNaN(n) && !Buffer.isBuffer(r.value);
    let shown: number | null = numeric ? n * scale : null;
    if (numeric && asRate) {
      raw[r.suffix] = n;
      const p = prev[r.suffix];
      // A lower reading means the counter wrapped or the device restarted:
      // no rate for that row this time, rather than a huge negative one.
      shown = p != null && elapsed > 0 && n >= p ? ((n - p) / elapsed) * scale : null;
    }
    if (shown != null) numbers.push(shown);
    details.push({ oid: r.oid, type: r.type, value: displayValue(r.value), ...(asRate ? { rate: shown != null ? round2(shown) : null } : {}) });
  }
  const state = asRate ? { rows: raw, at: now } : undefined;
  const how = mode === "walk_all" ? str(config, "aggregate", "count") : mode.replace("walk_", "");
  if (how === "count") return { status: "up", latencyMs, message: `${picked.length} value(s) under ${oid}`, value: picked.length, details: mode === "walk_all" ? details : undefined, state };
  if (!numbers.length) {
    if (asRate && !prevAt) return { status: "up", latencyMs, message: "Collecting a baseline for the rate", skip: true, state };
    return { status: "warn", latencyMs, message: `No numeric values under ${oid}`, details: mode === "walk_all" ? details : undefined, state };
  }
  const value = aggregate(numbers, how);
  const label = how === "avg" ? "average" : how;
  return { status: "up", latencyMs, message: `${label} of ${numbers.length} row(s): ${round2(value)}${unit}`, value, details: mode === "walk_all" ? details : details.slice(0, 200), state };
}

function close(s: snmp.Session) {
  try {
    s.close();
  } catch {
    // already closed
  }
}

/**
 * An SNMP check: reads the value (one OID, a walk, or a preset) and, when the
 * check has a "Calculate" expression, works it out with the value read as
 * `value` and — when another check is referenced (refCheckId) — that
 * check's latest value as `ref`, which the engine puts in config.refValue
 * before the check runs (services/checkConfig.ts).
 *
 * @param config the check's settings
 * @param ctx the check's state from its previous run
 */
export async function probeSnmp(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const expression = str(config, "expression").trim();
  let extras: ExtraOid[];
  try {
    extras = expression ? parseExtraOids(config.extraOids) : [];
  } catch (err) {
    return warn(errMsg(err));
  }
  // The main OID (or template) is optional when the result is calculated
  // from extra OIDs alone.
  const hasMain = Boolean(str(config, "oid") || str(config, "preset"));
  const outcome: ProbeOutcome = hasMain || !extras.length ? await readSnmp(config, ctx) : { status: "up", latencyMs: null, message: null };
  if (!expression || outcome.skip || (hasMain && outcome.value == null)) return outcome;
  const vars: Record<string, number> = {};
  if (hasMain && outcome.value != null) vars.value = outcome.value;
  if (str(config, "refCheckId")) {
    const ref = Number(config.refValue);
    if (config.refValue == null || config.refValue === "" || !Number.isFinite(ref)) return { ...outcome, status: "unknown", message: "The referenced check has no value yet", value: null };
    vars.ref = ref;
  }
  // State for rate(…) extras lives under "extra", next to whatever the main
  // read keeps (its own rate baseline), so neither overwrites the other.
  let state = outcome.state ?? ctx.state;
  if (extras.length) {
    const read = await readExtraOids(config, extras, (ctx.state.extra ?? {}) as Record<string, { raw: number; at: number }>);
    if ("error" in read) return { ...outcome, status: "down", message: read.error, value: null };
    state = { ...state, extra: read.state };
    if (read.baseline) return { status: "up", latencyMs: outcome.latencyMs, message: "Collecting a baseline for the rate", skip: true, state };
    Object.assign(vars, read.values);
  }
  try {
    const value = evaluateExpression(expression, vars);
    const unit = str(config, "unit");
    const inputs = Object.entries(vars)
      .map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`)
      .join(", ");
    return { ...outcome, status: outcome.status ?? "up", value, message: `${Math.round(value * 100) / 100}${unit} (${inputs})`, state };
  } catch (err) {
    return { ...outcome, status: "warn", message: `Calculation failed: ${errMsg(err)}`, value: null, state };
  }
}

/** One extra OID read for the calculation: its name in the expression, and whether it's a counter read as a per-second rate. */
type ExtraOid = { name: string; oid: string; rate: boolean };

// Names an extra OID can't take: the main value, the referenced check, and
// the calculator's function names.
const RESERVED_NAMES = new Set(["value", "ref", "min", "max", "abs", "round", "floor", "ceil", "sqrt", "log10"]);

/**
 * Reads the "Extra OIDs" setting: one per line, "name = OID" or
 * "name = rate(OID)" for a counter — e.g. "used = 1.3.6.1.2.1.25.2.3.1.6.1".
 * The regex matches: a name (letters, digits, _ — not starting with a digit),
 * "=", optionally "rate(", an OID of digits and dots, optionally ")".
 *
 * @throws Error naming the line that isn't valid
 */
export function parseExtraOids(value: unknown): ExtraOid[] {
  const lines = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(/\r?\n/) : [];
  const out: ExtraOid[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    // "name = target": a name (letters, digits, _ — not starting with a
    // digit), "=", then the OID, optionally wrapped in rate( … ).
    const m = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+)$/.exec(line);
    let target = m ? m[2].trim() : "";
    const rate = target.startsWith("rate(") && target.endsWith(")");
    if (rate) target = target.slice(5, -1).trim();
    if (!m || !isOid(target)) throw new Error(`Extra OID line isn't "name = OID" or "name = rate(OID)": ${line.slice(0, 80)}`);
    const oid = target.replace(/^\./, "");
    if (RESERVED_NAMES.has(m[1])) throw new Error(`"${m[1]}" is reserved — pick another name for ${oid}`);
    if (out.some((e) => e.name === m[1])) throw new Error(`"${m[1]}" is used twice in Extra OIDs`);
    out.push({ name: m[1], oid, rate });
  }
  if (out.length > 20) throw new Error("At most 20 extra OIDs");
  return out;
}

/**
 * Reads the extra OIDs in one SNMP request. Counters marked rate(…) become
 * per-second rates against the previous run (the first run, or a counter
 * that went backwards, only records a baseline).
 *
 * @returns the values by name and the new rate state — or an error message
 */
async function readExtraOids(config: Config, extras: ExtraOid[], prev: Record<string, { raw: number; at: number }>): Promise<{ values: Record<string, number>; state: Record<string, { raw: number; at: number }>; baseline: boolean } | { error: string }> {
  if (!str(config, "host")) return { error: "Missing host" };
  let session: snmp.Session;
  try {
    session = openSnmpSession(config);
  } catch (err) {
    return { error: errMsg(err) };
  }
  session.on("error", () => undefined);
  try {
    const vbs = await snmpGet(session, extras.map((e) => e.oid));
    const now = Date.now();
    const values: Record<string, number> = {};
    const state: Record<string, { raw: number; at: number }> = {};
    let baseline = false;
    for (const [i, e] of extras.entries()) {
      const vb = vbs.at(i);
      if (!vb || snmp.isVarbindError(vb)) return { error: `${e.name} (${e.oid}): ${vb ? snmp.varbindError(vb) : "no response"}` };
      const n = toNum(vb.value);
      if (Number.isNaN(n)) return { error: `${e.name} (${e.oid}) isn't a number: ${toStr(vb.value).slice(0, 60)}` };
      if (!e.rate) {
        values[e.name] = n;
        continue;
      }
      state[e.name] = { raw: n, at: now };
      const p = prev[e.name];
      if (!p || n < p.raw || now <= p.at) baseline = true;
      else values[e.name] = (n - p.raw) / ((now - p.at) / 1000);
    }
    return { values, state, baseline };
  } catch (err) {
    return { error: errMsg(err) };
  } finally {
    close(session);
  }
}

/** Reads the SNMP value itself (see probeSnmp). */
async function readSnmp(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const host = str(config, "host");
  const preset = str(config, "preset");
  const oid = str(config, "oid");
  const mode = str(config, "mode", "get");
  if (!host || (!oid && !preset)) return warn("Missing host or oid");
  let session: snmp.Session;
  try {
    session = openSnmpSession(config);
  } catch (err) {
    return down(errMsg(err));
  }
  session.on("error", () => undefined);
  const start = Date.now();
  try {
    if (preset) {
      const fn = own(SNMP_PRESETS, preset);
      if (!fn) return warn(`Unknown SNMP preset: ${preset}`);
      const r = await fn(session, config, ctx);
      const latencyMs = Date.now() - start;
      if (r.value == null) return { status: "warn", latencyMs, message: r.message, details: r.details, state: r.state };
      return { status: r.status ?? "up", latencyMs, message: r.message, value: r.value, details: r.details, state: r.state };
    }

    const scale = numOr(config, "scale", 1);
    const unit = str(config, "unit");
    if (mode !== "get") return await walkCheck(session, oid, mode, config, ctx, start, scale, unit);

    let value: number;
    const [vb] = await snmpGet(session, [oid]);
    if (!vb) return down("No response");
    if (snmp.isVarbindError(vb)) return down(snmp.varbindError(vb));
    value = toNum(vb.value);
    if (Number.isNaN(value)) {
      const text = toStr(vb.value);
      const expect = str(config, "expectString");
      if (expect) return { status: text.includes(expect) ? "up" : "down", latencyMs: Date.now() - start, message: text };
      return { status: "warn", latencyMs: Date.now() - start, message: `Returned a non-numeric value: ${text}` };
    }
    let state: Record<string, unknown> | undefined;
    // Counters (octets, packets) are only meaningful as a rate.
    if (bool(config, "asRate")) {
      const now = Date.now();
      const prev = ctx.state as { raw?: number; at?: number };
      state = { raw: value, at: now };
      if (prev.raw == null || prev.at == null || value < prev.raw) return { status: "up", latencyMs: now - start, message: "Collecting a baseline for the rate", skip: true, state };
      value = (value - prev.raw) / ((now - prev.at) / 1000);
    }
    value = value * scale;
    return { status: "up", latencyMs: Date.now() - start, message: `${Math.round(value * 100) / 100}${unit}`, value, state };
  } catch (err) {
    return down(errMsg(err));
  } finally {
    close(session);
  }
}

export type BrowseRow = { oid: string; type: string; value: string };

// The walk browser in the check form: every value under an OID (default:
// the whole MIB-2 tree), shown as text, capped so a big device can't
// produce an unbounded response.
export async function browseSnmp(config: Config, maxRows = 5000): Promise<{ rows: BrowseRow[]; truncated: boolean }> {
  const session = openSnmpSession(config);
  session.on("error", () => undefined);
  try {
    const rows = await snmpWalkRows(session, str(config, "oid", "1.3.6.1.2.1") || "1.3.6.1.2.1", maxRows + 1);
    return { rows: rows.slice(0, maxRows).map((r) => ({ oid: r.oid, type: r.type, value: displayValue(r.value) })), truncated: rows.length > maxRows };
  } finally {
    close(session);
  }
}

type IfRow = { index: string; name: string; alias: string; admin: number; oper: number; speedMbps: number; inMbps: number | null; outMbps: number | null; utilPercent: number | null; errorsPerSec: number | null; discardsPerSec: number | null };

// H1: whole interface table in one check. Oper-down ports whose admin status
// is up are failures; utilization and error rates come from counter deltas
// against the previous run (kept in check state).
export async function probeSnmpInterfaces(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const host = str(config, "host");
  if (!host) return warn("Missing host");
  let session: snmp.Session;
  try {
    session = openSnmpSession(config);
  } catch (err) {
    return down(errMsg(err));
  }
  session.on("error", () => undefined);
  const start = Date.now();
  try {
    const ifTable = columns(await snmpWalk(session, "1.3.6.1.2.1.2.2.1"));
    const ifX = columns(await snmpWalk(session, "1.3.6.1.2.1.31.1.1.1").catch(() => new Map()));
    const latencyMs = Date.now() - start;
    const now = Date.now();
    const prev = (ctx.state.counters ?? {}) as Record<string, { in: number; out: number; err: number; disc: number }>;
    const prevAt = ctx.state.at as number | undefined;
    const elapsed = prevAt ? (now - prevAt) / 1000 : 0;
    const filter = str(config, "interfaceFilter");
    // The admin's interface filter runs on RE2 (lib/userRegex.ts).
    let re: UserRegex | null = null;
    try {
      re = filter ? compileUserRegex(filter, { ignoreCase: true }) : null;
    } catch {
      return warn(`Invalid interface filter regex: ${filter}`);
    }
    const excluded = excludeItems(config.exclude, true);
    const counters: Record<string, { in: number; out: number; err: number; disc: number }> = {};
    const rows: IfRow[] = [];
    for (const [index, descr] of ifTable.get("2") ?? []) {
      const name = toStr(ifX.get("1")?.get(index)) || toStr(descr);
      const alias = toStr(ifX.get("18")?.get(index));
      if (re && !re.test(name) && !re.test(toStr(descr)) && !re.test(alias)) continue;
      // Excluded interfaces (config.exclude, merged with any reusable
      // exclusion lists) are skipped entirely, by name, description or alias.
      if (nameExcluded(name, excluded) || nameExcluded(toStr(descr), excluded) || nameExcluded(alias, excluded)) continue;
      const inOct = toNum(ifX.get("6")?.get(index) ?? ifTable.get("10")?.get(index));
      const outOct = toNum(ifX.get("10")?.get(index) ?? ifTable.get("16")?.get(index));
      const err = toNum(ifTable.get("14")?.get(index) ?? 0) + toNum(ifTable.get("20")?.get(index) ?? 0);
      const disc = toNum(ifTable.get("13")?.get(index) ?? 0) + toNum(ifTable.get("19")?.get(index) ?? 0);
      setOwn(counters, index, { in: inOct, out: outOct, err, disc });
      const highSpeed = toNum(ifX.get("15")?.get(index));
      const speedMbps = highSpeed > 0 ? highSpeed : toNum(ifTable.get("5")?.get(index)) / 1e6;
      const p = own(prev, index);
      const rate = (a: number, b: number | undefined) => (p && elapsed > 0 && b != null && a >= b ? (a - b) / elapsed : null);
      const inBps = rate(inOct, p?.in);
      const outBps = rate(outOct, p?.out);
      const inMbps = inBps != null ? (inBps * 8) / 1e6 : null;
      const outMbps = outBps != null ? (outBps * 8) / 1e6 : null;
      const util = speedMbps > 0 && inMbps != null && outMbps != null ? (Math.max(inMbps, outMbps) / speedMbps) * 100 : null;
      rows.push({
        index,
        name,
        alias,
        admin: toNum(ifTable.get("7")?.get(index)),
        oper: toNum(ifTable.get("8")?.get(index)),
        speedMbps: Math.round(speedMbps),
        inMbps: inMbps != null ? Math.round(inMbps * 100) / 100 : null,
        outMbps: outMbps != null ? Math.round(outMbps * 100) / 100 : null,
        utilPercent: util != null ? Math.round(util * 10) / 10 : null,
        errorsPerSec: rate(err, p?.err),
        discardsPerSec: rate(disc, p?.disc),
      });
    }
    const state = { counters, at: now };
    if (!rows.length) return { status: "warn", latencyMs, message: filter ? `No interfaces match /${filter}/` : "Device returned no interfaces", state };

    const problems: string[] = [];
    let status: ProbeOutcome["status"] = "up";
    const raise = (s: "warn" | "down", msg: string) => {
      problems.push(msg);
      status = worst(status, s);
    };
    if (bool(config, "alertOnOperDown", true)) {
      // admin 1 = up, oper 1 = up. Admin-down ports are deliberately off.
      const dropped = rows.filter((r) => r.admin === 1 && r.oper !== 1 && r.oper !== 5 /* dormant */);
      if (dropped.length) raise(str(config, "operDownSeverity", "down") as "down", `${dropped.length} port(s) down: ${dropped.slice(0, 5).map((r) => r.name).join(", ")}`);
    }
    const maxUtil = Math.max(...rows.map((r) => r.utilPercent ?? 0));
    const uCrit = numOr(config, "utilCriticalPercent", NaN);
    const uWarn = numOr(config, "utilWarnPercent", NaN);
    const busiest = rows.find((r) => r.utilPercent === maxUtil);
    if (maxUtil >= uCrit) raise("down", `${busiest?.name} at ${maxUtil}% utilization`);
    else if (maxUtil >= uWarn) raise("warn", `${busiest?.name} at ${maxUtil}% utilization`);
    const maxErr = Math.max(...rows.map((r) => (r.errorsPerSec ?? 0) + (r.discardsPerSec ?? 0)));
    if (maxErr >= numOr(config, "errorsWarnPerSec", NaN)) raise("warn", `Errors/discards at ${maxErr.toFixed(2)}/s`);

    const upCount = rows.filter((r) => r.oper === 1).length;
    return { status, latencyMs, message: problems.length ? problems.join("; ") : `${upCount}/${rows.length} interfaces up, busiest ${maxUtil}%`, value: maxUtil, details: rows, state };
  } catch (err) {
    return down(errMsg(err));
  } finally {
    close(session);
  }
}
