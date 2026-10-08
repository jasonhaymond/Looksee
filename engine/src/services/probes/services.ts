import crypto from "node:crypto";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import nodemailer from "nodemailer";
import { ImapFlow } from "imapflow";
import pg from "pg";
import { type Config, type ProbeContext, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { tcpExchange } from "./net.js";
import { httpRequest } from "./http.js";

const execFileAsync = promisify(execFile);

// A11: send a uniquely-tagged message through SMTP, then poll the mailbox
// over IMAP until it shows up (and delete it). latencyMs is the full
// delivery time, which is the number that actually matters here.
export async function probeEmailRoundtrip(config: Config): Promise<ProbeOutcome> {
  const smtpHost = str(config, "smtpHost");
  const imapHost = str(config, "imapHost");
  const to = str(config, "to");
  if (!smtpHost || !imapHost || !to) return warn("smtpHost, imapHost and to are required");
  const token = `looksee-${crypto.randomBytes(6).toString("hex")}`;
  const timeoutMs = numOr(config, "timeoutSeconds", 120) * 1000;
  const start = Date.now();
  try {
    const smtpPort = numOr(config, "smtpPort", 587);
    const transport = nodemailer.createTransport({
      host: smtpHost,
      port: smtpPort,
      secure: smtpPort === 465,
      auth: str(config, "smtpUser") ? { user: str(config, "smtpUser"), pass: str(config, "smtpPassword") } : undefined,
      tls: { rejectUnauthorized: !bool(config, "insecureSkipVerify") },
    });
    await transport.sendMail({ from: str(config, "from", to), to, subject: `Looksee round-trip ${token}`, text: `Automated delivery test ${token}. Safe to delete.` });
  } catch (err) {
    return down(`Sending failed: ${errMsg(err)}`);
  }

  const imapPort = numOr(config, "imapPort", 993);
  const client = new ImapFlow({
    host: imapHost,
    port: imapPort,
    secure: imapPort === 993,
    auth: { user: str(config, "imapUser", to), pass: str(config, "imapPassword") },
    tls: { rejectUnauthorized: !bool(config, "insecureSkipVerify") },
    logger: false,
  });
  try {
    await client.connect();
    const lock = await client.getMailboxLock(str(config, "mailbox", "INBOX"));
    try {
      while (Date.now() - start < timeoutMs) {
        const uids = await client.search({ subject: token }, { uid: true });
        if (uids && uids.length) {
          const latencyMs = Date.now() - start;
          if (bool(config, "deleteAfter", true)) await client.messageDelete(uids, { uid: true });
          return { status: "up", latencyMs, message: `Delivered in ${(latencyMs / 1000).toFixed(1)}s`, value: latencyMs / 1000 };
        }
        await new Promise((r) => setTimeout(r, 3000));
        await client.noop();
      }
    } finally {
      lock.release();
    }
    return down(`Sent, but not delivered within ${timeoutMs / 1000}s`);
  } catch (err) {
    return down(`IMAP check failed: ${errMsg(err)}`);
  } finally {
    await client.logout().catch(() => undefined);
  }
}

type DbMetric = "connect" | "query_value" | "connections_percent" | "replication_lag_seconds" | "database_size_mb" | "long_queries" | "memory_mb";

// A12 + J1. "connect" (default) logs in and runs the check query; the other
// metrics read the server's own statistics. Every engine returns a value so
// the shared thresholds apply.
export async function probeDatabase(config: Config): Promise<ProbeOutcome> {
  const engine = str(config, "engine", "postgres");
  const metric = str(config, "metric", "connect") as DbMetric;
  const start = Date.now();
  try {
    const out = await DB_ENGINES[engine]?.(config, metric);
    if (!out) return warn(`Unknown database engine: ${engine}`);
    const latencyMs = Date.now() - start;
    if (metric === "connect") return { status: "up", latencyMs, message: out.message ?? "Connected", value: out.value ?? null };
    if (out.value == null) return { status: "warn", latencyMs, message: out.message ?? `${metric} isn't available on this server` };
    return { status: "up", latencyMs, message: out.message ?? `${metric.replace(/_/g, " ")}: ${Math.round(out.value * 100) / 100}`, value: out.value };
  } catch (err) {
    return down(errMsg(err));
  }
}

type DbOut = { value: number | null; message?: string };
const firstNumber = (row: Record<string, unknown> | undefined) => {
  const v = row ? Object.values(row)[0] : undefined;
  const n = Number(v);
  return v == null || !Number.isFinite(n) ? null : n;
};

const DB_ENGINES: Record<string, (c: Config, m: DbMetric) => Promise<DbOut>> = {
  async postgres(c, m) {
    const client = new pg.Client({
      host: str(c, "host"),
      port: numOr(c, "port", 5432),
      user: str(c, "username"),
      password: str(c, "password"),
      database: str(c, "database", "postgres"),
      ssl: bool(c, "tls") ? { rejectUnauthorized: !bool(c, "insecureSkipVerify") } : undefined,
      connectionTimeoutMillis: 8000,
      statement_timeout: 10_000,
    });
    await client.connect();
    try {
      const q = async (sql: string) => (await client.query(sql)).rows[0] as Record<string, unknown> | undefined;
      switch (m) {
        case "query_value":
          return { value: firstNumber(await q(str(c, "query", "SELECT 1"))) };
        case "connections_percent":
          return { value: firstNumber(await q("SELECT round(100.0 * (SELECT count(*) FROM pg_stat_activity) / current_setting('max_connections')::int, 2) AS v")) };
        case "replication_lag_seconds": {
          const replica = await q("SELECT CASE WHEN pg_is_in_recovery() THEN COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()), 0) END AS v");
          if (firstNumber(replica) != null) return { value: firstNumber(replica) };
          const primary = await q("SELECT COALESCE(max(EXTRACT(EPOCH FROM replay_lag)), 0) AS v FROM pg_stat_replication");
          return { value: firstNumber(primary), message: undefined };
        }
        case "database_size_mb":
          return { value: firstNumber(await q("SELECT pg_database_size(current_database()) / 1048576.0 AS v")) };
        case "long_queries":
          return { value: firstNumber(await q(`SELECT count(*) AS v FROM pg_stat_activity WHERE state <> 'idle' AND pid <> pg_backend_pid() AND now() - query_start > interval '${Math.max(1, numOr(c, "longQuerySeconds", 60))} seconds'`)) };
        default: {
          await q(str(c, "query", "SELECT 1"));
          return { value: null, message: "Connected and query succeeded" };
        }
      }
    } finally {
      await client.end().catch(() => undefined);
    }
  },

  async mysql(c, m) {
    const mysql = await import("mysql2/promise");
    const conn = await mysql.createConnection({
      host: str(c, "host"),
      port: numOr(c, "port", 3306),
      user: str(c, "username"),
      password: str(c, "password"),
      database: str(c, "database") || undefined,
      connectTimeout: 8000,
      ssl: bool(c, "tls") ? { rejectUnauthorized: !bool(c, "insecureSkipVerify") } : undefined,
    });
    try {
      const q = async (sql: string) => ((await conn.query(sql))[0] as Record<string, unknown>[])[0];
      const status = async (name: string) => Number((await q(`SHOW GLOBAL STATUS LIKE '${name}'`))?.Value);
      switch (m) {
        case "query_value":
          return { value: firstNumber(await q(str(c, "query", "SELECT 1"))) };
        case "connections_percent": {
          const max = Number((await q("SHOW VARIABLES LIKE 'max_connections'"))?.Value);
          return { value: Math.round(((await status("Threads_connected")) / max) * 10000) / 100 };
        }
        case "replication_lag_seconds": {
          let row: Record<string, unknown> | undefined;
          try {
            row = await q("SHOW REPLICA STATUS");
          } catch {
            row = await q("SHOW SLAVE STATUS");
          }
          if (!row) return { value: null, message: "Not a replica" };
          const lag = row.Seconds_Behind_Source ?? row.Seconds_Behind_Master;
          if (lag == null) return { value: null, message: "Replication is not running" };
          return { value: Number(lag) };
        }
        case "database_size_mb":
          return { value: firstNumber(await q(`SELECT COALESCE(SUM(data_length + index_length), 0) / 1048576 AS v FROM information_schema.tables${str(c, "database") ? ` WHERE table_schema = DATABASE()` : ""}`)) };
        case "long_queries":
          return { value: firstNumber(await q(`SELECT COUNT(*) AS v FROM information_schema.processlist WHERE command NOT IN ('Sleep','Daemon','Binlog Dump') AND time > ${Math.max(1, numOr(c, "longQuerySeconds", 60))}`)) };
        default:
          await q(str(c, "query", "SELECT 1"));
          return { value: null, message: "Connected and query succeeded" };
      }
    } finally {
      await conn.end().catch(() => undefined);
    }
  },

  async mssql(c, m) {
    const sql = (await import("mssql")).default;
    const pool = await new sql.ConnectionPool({
      server: str(c, "host"),
      port: numOr(c, "port", 1433),
      user: str(c, "username"),
      password: str(c, "password"),
      database: str(c, "database") || undefined,
      connectionTimeout: 8000,
      requestTimeout: 10_000,
      options: { encrypt: bool(c, "tls", true), trustServerCertificate: bool(c, "insecureSkipVerify", true) },
    }).connect();
    try {
      const q = async (text: string) => (await pool.request().query(text)).recordset?.[0] as Record<string, unknown> | undefined;
      switch (m) {
        case "query_value":
          return { value: firstNumber(await q(str(c, "query", "SELECT 1"))) };
        case "connections_percent":
          return { value: firstNumber(await q("SELECT CAST(COUNT(*) * 100.0 / @@MAX_CONNECTIONS AS float) AS v FROM sys.dm_exec_sessions")) };
        case "database_size_mb":
          return { value: firstNumber(await q("SELECT SUM(CAST(size AS bigint)) * 8 / 1024.0 AS v FROM sys.database_files")) };
        case "long_queries":
          return { value: firstNumber(await q(`SELECT COUNT(*) AS v FROM sys.dm_exec_requests WHERE session_id <> @@SPID AND total_elapsed_time > ${Math.max(1, numOr(c, "longQuerySeconds", 60)) * 1000}`)) };
        case "replication_lag_seconds":
          return { value: firstNumber(await q("SELECT MAX(DATEDIFF(second, last_commit_time, GETDATE())) AS v FROM sys.dm_hadr_database_replica_states")), message: undefined };
        default:
          await q(str(c, "query", "SELECT 1"));
          return { value: null, message: "Connected and query succeeded" };
      }
    } finally {
      await pool.close().catch(() => undefined);
    }
  },

  // RESP spoken directly — PING / INFO are all a health check needs.
  async redis(c, m) {
    const host = str(c, "host");
    const port = numOr(c, "port", 6379);
    const pass = str(c, "password");
    const user = str(c, "username");
    const cmds: string[] = [];
    if (pass) cmds.push(user ? `AUTH ${user} ${pass}` : `AUTH ${pass}`);
    cmds.push(m === "connect" ? "PING" : "INFO");
    const enc = (cmd: string) => {
      const parts = cmd.split(" ");
      return `*${parts.length}\r\n${parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join("")}`;
    };
    const r = await tcpExchange({
      host,
      port,
      tls: bool(c, "tls"),
      insecure: bool(c, "insecureSkipVerify"),
      send: cmds.map(enc).join(""),
      until: (b) => {
        const t = b.toString();
        if (/^-/m.test(t)) return true;
        if (m === "connect") return /\+PONG\r\n/.test(t);
        const bulk = t.match(/\$(\d+)\r\n/);
        return Boolean(bulk && Buffer.byteLength(t.slice(t.indexOf(bulk[0]) + bulk[0].length)) >= Number(bulk[1]));
      },
    });
    const text = r.data.toString();
    const err = text.match(/^-(.*)$/m);
    if (err) throw new Error(`Redis: ${err[1]}`);
    if (m === "connect") return { value: null, message: "PONG" };
    const info = Object.fromEntries(text.split(/\r?\n/).filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")), l.slice(l.indexOf(":") + 1)]));
    switch (m) {
      case "connections_percent": {
        const max = Number(info.maxclients) || 10000;
        return { value: Math.round((Number(info.connected_clients) / max) * 10000) / 100, message: `${info.connected_clients} clients` };
      }
      case "memory_mb":
        return { value: Number(info.used_memory) / 1048576 };
      case "replication_lag_seconds":
        if (info.role !== "slave") return { value: 0, message: `Role is ${info.role}` };
        return { value: info.master_link_status === "up" ? Number(info.master_last_io_seconds_ago) : null, message: info.master_link_status !== "up" ? "Replication link is down" : undefined };
      default:
        return { value: null, message: `Redis ${info.redis_version ?? ""}`.trim() };
    }
  },

  async mongodb(c, m) {
    const { MongoClient } = await import("mongodb");
    const uri = str(c, "uri") || `mongodb://${str(c, "username") ? `${encodeURIComponent(str(c, "username"))}:${encodeURIComponent(str(c, "password"))}@` : ""}${str(c, "host")}:${numOr(c, "port", 27017)}/${str(c, "database", "admin")}`;
    const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000, tls: bool(c, "tls") || undefined, tlsAllowInvalidCertificates: bool(c, "insecureSkipVerify") || undefined });
    await client.connect();
    try {
      const admin = client.db("admin");
      if (m === "connect") {
        await admin.command({ ping: 1 });
        return { value: null, message: "ping ok" };
      }
      const s = (await admin.command({ serverStatus: 1 })) as { connections?: { current: number; available: number }; mem?: { resident: number } };
      switch (m) {
        case "connections_percent":
          return { value: s.connections ? Math.round((s.connections.current / (s.connections.current + s.connections.available)) * 10000) / 100 : null };
        case "memory_mb":
          return { value: s.mem?.resident ?? null };
        case "database_size_mb": {
          const stats = (await client.db(str(c, "database", "admin")).command({ dbStats: 1 })) as { dataSize: number };
          return { value: stats.dataSize / 1048576 };
        }
        case "replication_lag_seconds": {
          const rs = (await admin.command({ replSetGetStatus: 1 })) as { members: { stateStr: string; optimeDate: Date }[] };
          const primary = rs.members.find((x) => x.stateStr === "PRIMARY");
          if (!primary) return { value: null, message: "No primary" };
          const lags = rs.members.filter((x) => x.stateStr === "SECONDARY").map((x) => (primary.optimeDate.getTime() - x.optimeDate.getTime()) / 1000);
          return { value: lags.length ? Math.max(...lags) : 0 };
        }
        default:
          return { value: null, message: `${m} isn't supported for MongoDB` };
      }
    } finally {
      await client.close().catch(() => undefined);
    }
  },
};

// Hop lines from Linux traceroute -n, macOS traceroute -n, and Windows
// tracert -d all reduce to "hop number, then an IP or *".
export function parseTraceroute(output: string): string[] {
  const hops: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const m = line.match(/^\s*(\d+)\s+(.*)$/);
    if (!m) continue;
    const ip = m[2].match(/(\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f]*:[0-9a-f:]+)/i);
    hops[Number(m[1]) - 1] = ip ? ip[1] : "*";
  }
  return Array.from(hops, (h) => h ?? "*");
}

// A13. Path changes are compared ignoring "*" hops (a router that sometimes
// rate-limits its ICMP replies isn't a path change).
export async function probeTraceroute(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const host = str(config, "host");
  if (!host) return warn("Missing host");
  const maxHops = numOr(config, "maxHops", 30);
  const [cmd, args] = process.platform === "win32" ? ["tracert", ["-d", "-h", String(maxHops), "-w", "1000", host]] : ["traceroute", ["-n", "-m", String(maxHops), "-w", "1", "-q", "1", host]];
  const start = Date.now();
  let output: string;
  try {
    output = (await execFileAsync(cmd, args, { timeout: maxHops * 3000 + 5000 })).stdout;
  } catch (err) {
    const e = err as { stdout?: string; code?: string };
    if (e.code === "ENOENT") return warn(`${cmd} isn't installed on the engine host (apt install traceroute)`);
    output = e.stdout ?? "";
    if (!output) return down(errMsg(err));
  }
  const hops = parseTraceroute(output);
  const latencyMs = Date.now() - start;
  if (hops.length === 0) return down("No hops parsed from traceroute output");
  const reached = hops[hops.length - 1] !== "*";
  const known = hops.filter((h) => h !== "*");
  const previous = (ctx.state.path as string[] | undefined) ?? null;
  const prevKnown = previous?.filter((h) => h !== "*") ?? null;
  const changed = prevKnown != null && prevKnown.join(">") !== known.join(">");
  const state = { path: hops, changedAt: changed ? new Date().toISOString() : ctx.state.changedAt };
  const details = { hops, previous };
  const expected = str(config, "expectedHop");
  if (expected && !hops.includes(expected)) return { status: "down", latencyMs, message: `Path no longer goes through ${expected}`, value: hops.length, details, state };
  if (!reached && bool(config, "requireReach", true)) return { status: "down", latencyMs, message: `Destination not reached in ${hops.length} hops`, value: hops.length, details, state };
  if (changed) return { status: str(config, "changeSeverity", "warn") as "warn", latencyMs, message: `Path changed: ${prevKnown!.join(" → ")}  ⇒  ${known.join(" → ")}`, value: hops.length, details, state };
  return { status: "up", latencyMs, message: `${hops.length} hops`, value: hops.length, details, state };
}

const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/snap/bin/chromium",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];

export function findChrome(): string | null {
  return CHROME_CANDIDATES.find((p) => p && fs.existsSync(p)) ?? null;
}

// A15. Uses a system Chrome/Chromium (CHROME_PATH or a standard location)
// via puppeteer-core rather than bundling a browser download into the
// engine install.
export async function probeBrowser(config: Config): Promise<ProbeOutcome> {
  const url = str(config, "url");
  if (!url) return warn("Missing url");
  const executablePath = findChrome();
  if (!executablePath) return warn("No Chrome/Chromium found on the engine host — install chromium or set CHROME_PATH");
  const puppeteer = (await import("puppeteer-core")).default;
  const browser = await puppeteer.launch({ executablePath, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", ...(bool(config, "insecureSkipVerify") ? ["--ignore-certificate-errors"] : [])] });
  const start = Date.now();
  try {
    const page = await browser.newPage();
    const jsErrors: string[] = [];
    const failedRequests: string[] = [];
    page.on("pageerror", (err) => jsErrors.push(String((err as Error).message ?? err)));
    page.on("requestfailed", (req) => failedRequests.push(req.url()));
    const res = await page.goto(url, { waitUntil: "networkidle2", timeout: numOr(config, "timeoutSeconds", 30) * 1000 });
    const latencyMs = Date.now() - start;
    const status = res?.status() ?? 0;
    const details = { httpStatus: status, jsErrors: jsErrors.slice(0, 10), failedRequests: failedRequests.slice(0, 10), title: await page.title() };
    if (status >= 400) return { status: "down", latencyMs, message: `HTTP ${status}`, details, value: latencyMs };
    const selector = str(config, "waitForSelector");
    if (selector) {
      const found = await page.waitForSelector(selector, { timeout: 5000 }).catch(() => null);
      if (!found) return { status: "down", latencyMs, message: `Element "${selector}" never appeared`, details, value: latencyMs };
    }
    const text = str(config, "expectText");
    if (text) {
      // The title counts as rendered text too — some pages only name
      // themselves there.
      const body = await page.evaluate(() => `${document.title}\n${document.body?.innerText ?? ""}`);
      if (!body.includes(text)) return { status: "down", latencyMs, message: `Rendered page doesn't contain "${text}"`, details, value: latencyMs };
    }
    if (bool(config, "failOnJsErrors", true) && jsErrors.length) return { status: "warn", latencyMs, message: `${jsErrors.length} JavaScript error(s): ${jsErrors[0]}`, details, value: latencyMs };
    return { status: "up", latencyMs, message: `Rendered "${details.title}" in ${(latencyMs / 1000).toFixed(1)}s`, details, value: latencyMs };
  } catch (err) {
    return down(errMsg(err));
  } finally {
    await browser.close().catch(() => undefined);
  }
}

// RDAP bootstrap (IANA) is cached for a day — it maps TLD -> RDAP server.
let rdapBootstrap: { at: number; services: [string[], string[]][] } | null = null;

async function rdapBaseFor(domain: string): Promise<string | null> {
  if (!rdapBootstrap || Date.now() - rdapBootstrap.at > 86_400_000) {
    const res = await httpRequest("https://data.iana.org/rdap/dns.json", {});
    rdapBootstrap = { at: Date.now(), services: (JSON.parse(res.body) as { services: [string[], string[]][] }).services };
  }
  const labels = domain.toLowerCase().split(".");
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join(".");
    const hit = rdapBootstrap.services.find(([tlds]) => tlds.includes(suffix));
    if (hit) return hit[1][0].replace(/\/$/, "");
  }
  return null;
}

// A7. RDAP (the JSON successor to WHOIS) — every gTLD and most ccTLDs
// publish it; a TLD without an RDAP server gets a clear warn, not a guess.
export async function probeDomainExpiry(config: Config): Promise<ProbeOutcome> {
  const domain = str(config, "domain").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (!domain) return warn("Missing domain");
  const start = Date.now();
  try {
    const base = str(config, "rdapServer") || (await rdapBaseFor(domain));
    if (!base) return warn(`No RDAP server is published for .${domain.split(".").pop()} — this TLD can't be checked automatically`);
    const res = await httpRequest(`${base}/domain/${domain}`, { headers: { Accept: "application/rdap+json" } });
    if (res.status === 404) return down(`${domain} isn't registered (RDAP 404)`);
    if (res.status !== 200) return warn(`RDAP lookup returned HTTP ${res.status}`);
    const data = JSON.parse(res.body) as { events?: { eventAction: string; eventDate: string }[]; status?: string[] };
    const exp = data.events?.find((e) => e.eventAction === "expiration")?.eventDate;
    if (!exp) return warn("RDAP record has no expiration date");
    const days = Math.floor((new Date(exp).getTime() - Date.now()) / 86_400_000);
    const warnDays = numOr(config, "warnDays", 30);
    const critDays = numOr(config, "criticalDays", 7);
    const latencyMs = Date.now() - start;
    const details = { expires: exp, status: data.status };
    const message = `Expires ${exp.slice(0, 10)} (${days} days)`;
    if (days < 0) return { status: "down", latencyMs, message: `Expired ${exp.slice(0, 10)}`, value: days, details };
    if (days <= critDays) return { status: "down", latencyMs, message, value: days, details };
    if (days <= warnDays) return { status: "warn", latencyMs, message, value: days, details };
    return { status: "up", latencyMs, message, value: days, details };
  } catch (err) {
    return down(errMsg(err));
  }
}

// E6. The engine's own public IP as seen from outside. Change from the last
// run is reported for holdMinutes so a normal 2-consecutive alert rule fires.
export async function probePublicIp(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const url = str(config, "url", "https://api.ipify.org");
  try {
    const res = await httpRequest(url, { timeoutMs: 10_000 });
    const ip = res.body.trim().match(/[0-9a-f.:]+/i)?.[0];
    if (res.status !== 200 || !ip) return down(`${url} returned HTTP ${res.status}`);
    const prev = ctx.state.ip as string | undefined;
    const expected = str(config, "expectedIp");
    const changedAt = prev && prev !== ip ? new Date().toISOString() : (ctx.state.changedAt as string | undefined);
    const state = { ip, previousIp: prev && prev !== ip ? prev : ctx.state.previousIp, changedAt };
    const base = { latencyMs: res.latencyMs, details: { ip, previousIp: state.previousIp }, state };
    if (expected && ip !== expected) return { status: "down", message: `Public IP is ${ip}, expected ${expected}`, ...base };
    const hold = numOr(config, "holdMinutes", 15) * 60_000;
    if (changedAt && Date.now() - new Date(changedAt).getTime() < hold) return { status: str(config, "changeSeverity", "warn") as "warn", message: `Public IP changed ${state.previousIp} → ${ip}`, ...base };
    return { status: "up", message: ip, ...base };
  } catch (err) {
    return down(errMsg(err));
  }
}
