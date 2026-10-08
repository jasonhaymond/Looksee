import * as snmp from "net-snmp";
import { worst } from "../thresholds.js";
import { type Config, type ProbeContext, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";

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
    if (!AUTH[authName]) throw new Error(`Unsupported SNMPv3 auth protocol: ${authName}`);
    if (!PRIV[privName]) throw new Error(`Unsupported SNMPv3 privacy protocol: ${privName}`);
    const user: snmp.User = {
      name: str(config, "username"),
      level: LEVELS[str(config, "securityLevel")] ?? snmp.SecurityLevel.authPriv,
      authProtocol: AUTH[authName],
      authKey: str(config, "authKey"),
      privProtocol: PRIV[privName],
      privKey: str(config, "privKey"),
    };
    return snmp.createV3Session(host, user, options);
  }
  return snmp.createSession(host, str(config, "community", "public"), { ...options, version: str(config, "version") === "1" ? snmp.Version1 : snmp.Version2c });
}

function snmpGet(session: snmp.Session, oids: string[]): Promise<snmp.Varbind[]> {
  return new Promise((resolve, reject) => {
    session.get(oids, (err, vbs) => (err ? reject(err) : resolve(vbs ?? [])));
  });
}

// Every leaf under `oid`, keyed by the suffix after it (e.g. ".2" or "1.5").
export function snmpWalk(session: snmp.Session, oid: string): Promise<Map<string, unknown>> {
  return new Promise((resolve, reject) => {
    const out = new Map<string, unknown>();
    session.subtree(
      oid,
      20,
      (vbs) => {
        for (const vb of vbs) {
          if (snmp.isVarbindError(vb)) continue;
          out.set(vb.oid.slice(oid.length + 1), vb.value);
        }
      },
      (err) => (err ? reject(err) : resolve(out))
    );
  });
}

const toNum = (v: unknown) => (Buffer.isBuffer(v) ? Number(v.toString()) : typeof v === "bigint" ? Number(v) : Number(v));
const toStr = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf-8").replace(/\0/g, "") : String(v ?? ""));

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
    return { value: source, message: `Output source: ${names[source] ?? source}`, status: source === 5 ? "warn" : source === 2 ? "down" : "up" };
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

function close(s: snmp.Session) {
  try {
    s.close();
  } catch {
    // already closed
  }
}

export async function probeSnmp(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
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
      const fn = SNMP_PRESETS[preset];
      if (!fn) return warn(`Unknown SNMP preset: ${preset}`);
      const r = await fn(session, config, ctx);
      const latencyMs = Date.now() - start;
      if (r.value == null) return { status: "warn", latencyMs, message: r.message, details: r.details, state: r.state };
      return { status: r.status ?? "up", latencyMs, message: r.message, value: r.value, details: r.details, state: r.state };
    }

    let value: number;
    if (mode === "get") {
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
    } else {
      const values = [...(await snmpWalk(session, oid)).values()].map(toNum).filter((n) => !Number.isNaN(n));
      if (!values.length) return down(`Nothing under ${oid}`);
      value =
        mode === "walk_sum" ? values.reduce((a, b) => a + b, 0)
        : mode === "walk_min" ? Math.min(...values)
        : mode === "walk_max" ? Math.max(...values)
        : mode === "walk_count" ? values.length
        : values.reduce((a, b) => a + b, 0) / values.length;
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
    const scale = numOr(config, "scale", 1);
    value = value * scale;
    return { status: "up", latencyMs: Date.now() - start, message: `${Math.round(value * 100) / 100}${str(config, "unit")}`, value, state };
  } catch (err) {
    return down(errMsg(err));
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
    let re: RegExp | null = null;
    try {
      re = filter ? new RegExp(filter, "i") : null;
    } catch {
      return warn(`Invalid interface filter regex: ${filter}`);
    }
    const counters: Record<string, { in: number; out: number; err: number; disc: number }> = {};
    const rows: IfRow[] = [];
    for (const [index, descr] of ifTable.get("2") ?? []) {
      const name = toStr(ifX.get("1")?.get(index)) || toStr(descr);
      const alias = toStr(ifX.get("18")?.get(index));
      if (re && !re.test(name) && !re.test(toStr(descr)) && !re.test(alias)) continue;
      const inOct = toNum(ifX.get("6")?.get(index) ?? ifTable.get("10")?.get(index));
      const outOct = toNum(ifX.get("10")?.get(index) ?? ifTable.get("16")?.get(index));
      const err = toNum(ifTable.get("14")?.get(index) ?? 0) + toNum(ifTable.get("20")?.get(index) ?? 0);
      const disc = toNum(ifTable.get("13")?.get(index) ?? 0) + toNum(ifTable.get("19")?.get(index) ?? 0);
      counters[index] = { in: inOct, out: outOct, err, disc };
      const highSpeed = toNum(ifX.get("15")?.get(index));
      const speedMbps = highSpeed > 0 ? highSpeed : toNum(ifTable.get("5")?.get(index)) / 1e6;
      const p = prev[index];
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
