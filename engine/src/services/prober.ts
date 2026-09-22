import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import dns from "node:dns/promises";
import * as snmp from "net-snmp";

const execFileAsync = promisify(execFile);

export type ProbeResult = { status: "up" | "down" | "warn"; latencyMs: number | null; message: string | null };

export async function runProbe(type: string, config: Record<string, unknown>): Promise<ProbeResult> {
  switch (type) {
    case "ping":
      return probePing(String(config.host ?? ""));
    case "tcp":
      return probeTcp(String(config.host ?? ""), Number(config.port));
    case "http":
      return probeHttp(String(config.url ?? ""), Number(config.expectedStatus) || undefined, {
        method: typeof config.method === "string" && config.method ? config.method : "GET",
        headers: parseHeaders(typeof config.headers === "string" ? config.headers : ""),
        insecureSkipVerify: Boolean(config.insecureSkipVerify),
        bodyContains: typeof config.bodyContains === "string" && config.bodyContains ? config.bodyContains : undefined,
      });
    case "dns":
      return probeDns(String(config.hostname ?? ""));
    case "ssl_cert":
      return probeSslCert(String(config.host ?? ""), Number(config.port) || 443, Number(config.warnDays) || 14);
    case "snmp":
      return probeSnmp(config);
    default:
      return { status: "warn", latencyMs: null, message: `Unknown agentless check type: ${type}` };
  }
}

// Shells out to the OS's own `ping` rather than opening a raw ICMP socket —
// raw sockets need root/admin privileges on every platform this needs to
// run on; the system binary already has that privilege bit set correctly
// wherever it's installed.
async function probePing(host: string): Promise<ProbeResult> {
  if (!host) return { status: "warn", latencyMs: null, message: "Missing host" };
  const start = Date.now();
  const args = process.platform === "win32" ? ["-n", "1", "-w", "3000", host] : ["-c", "1", "-W", "3", host];
  try {
    await execFileAsync("ping", args);
    return { status: "up", latencyMs: Date.now() - start, message: null };
  } catch (err) {
    return { status: "down", latencyMs: null, message: `No reply from ${host}` };
  }
}

async function probeTcp(host: string, port: number): Promise<ProbeResult> {
  if (!host || !port) return { status: "warn", latencyMs: null, message: "Missing host or port" };
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout: 5000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve({ status: "up", latencyMs: Date.now() - start, message: null });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ status: "down", latencyMs: null, message: `Timed out connecting to ${host}:${port}` });
    });
    socket.once("error", (err) => {
      resolve({ status: "down", latencyMs: null, message: err.message });
    });
  });
}

// "Name: value" per line, as typed into the check form's headers textarea —
// same idea as parsing a .env file. Blank lines and lines without a colon
// are silently skipped rather than erroring, so a stray trailing newline
// doesn't break the check.
function parseHeaders(raw: string): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const name = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (name) headers[name] = value;
  }
  return headers;
}

type HttpOptions = { method: string; headers: Record<string, string>; insecureSkipVerify: boolean; bodyContains?: string };

// Checked in addition to (not instead of) the status code — a check can
// have an expectedStatus, a bodyContains, both, or neither.
function bodyCheck(ok: boolean, status: number, body: string | null, bodyContains: string | undefined): { ok: boolean; message: string | null } {
  if (!ok) return { ok, message: `HTTP ${status}` };
  if (bodyContains && !(body ?? "").includes(bodyContains)) {
    return { ok: false, message: `Response didn't contain "${bodyContains}"` };
  }
  return { ok: true, message: null };
}

async function probeHttp(url: string, expectedStatus: number | undefined, options: HttpOptions): Promise<ProbeResult> {
  if (!url) return { status: "warn", latencyMs: null, message: "Missing url" };
  // fetch (the standard path) has no way to disable TLS verification
  // per-request, so that one case switches to node:https directly instead
  // — isolated to just this branch, every other check keeps using fetch.
  if (options.insecureSkipVerify && url.startsWith("https:")) {
    return probeHttpInsecure(url, expectedStatus, options);
  }
  const start = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: "follow", method: options.method, headers: options.headers });
    const latencyMs = Date.now() - start;
    const statusOk = expectedStatus ? res.status === expectedStatus : res.status < 400;
    const body = options.bodyContains ? await res.text() : null;
    const { ok, message } = bodyCheck(statusOk, res.status, body, options.bodyContains);
    return { status: ok ? "up" : "down", latencyMs, message };
  } catch (err) {
    return { status: "down", latencyMs: null, message: err instanceof Error ? err.message : "Request failed" };
  } finally {
    clearTimeout(timeout);
  }
}

function probeHttpInsecure(url: string, expectedStatus: number | undefined, options: HttpOptions): Promise<ProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    const req = https.request(
      new URL(url),
      { method: options.method, headers: options.headers, rejectUnauthorized: false, timeout: 10_000 },
      (res) => {
        const chunks: Buffer[] = [];
        if (options.bodyContains) res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const latencyMs = Date.now() - start;
          const status = res.statusCode ?? 0;
          const statusOk = expectedStatus ? status === expectedStatus : status < 400;
          const body = options.bodyContains ? Buffer.concat(chunks).toString("utf-8") : null;
          const { ok, message } = bodyCheck(statusOk, status, body, options.bodyContains);
          resolve({ status: ok ? "up" : "down", latencyMs, message });
        });
        res.resume();
      }
    );
    req.once("timeout", () => {
      req.destroy();
      resolve({ status: "down", latencyMs: null, message: "Request timed out" });
    });
    req.once("error", (err) => {
      resolve({ status: "down", latencyMs: null, message: err.message });
    });
    req.end();
  });
}

async function probeDns(hostname: string): Promise<ProbeResult> {
  if (!hostname) return { status: "warn", latencyMs: null, message: "Missing hostname" };
  const start = Date.now();
  try {
    const addresses = await dns.resolve(hostname);
    return { status: "up", latencyMs: Date.now() - start, message: addresses.join(", ") };
  } catch (err) {
    return { status: "down", latencyMs: null, message: `Failed to resolve ${hostname}` };
  }
}

function probeSslCert(host: string, port: number, warnDays: number): Promise<ProbeResult> {
  if (!host) return Promise.resolve({ status: "warn", latencyMs: null, message: "Missing host" });
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: host, timeout: 5000 }, () => {
      const cert = socket.getPeerCertificate();
      socket.destroy();
      if (!cert || !cert.valid_to) {
        resolve({ status: "warn", latencyMs: null, message: "No certificate returned" });
        return;
      }
      const daysLeft = Math.floor((new Date(cert.valid_to).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
      if (daysLeft < 0) resolve({ status: "down", latencyMs: null, message: "Certificate expired" });
      else if (daysLeft <= warnDays) resolve({ status: "warn", latencyMs: null, message: `Expires in ${daysLeft} days` });
      else resolve({ status: "up", latencyMs: null, message: `Expires in ${daysLeft} days` });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve({ status: "down", latencyMs: null, message: `Timed out connecting to ${host}:${port}` });
    });
    socket.once("error", (err) => {
      resolve({ status: "down", latencyMs: null, message: err.message });
    });
  });
}

// Thresholds are four independent optional directions rather than a single
// operator — some OIDs warn when LOW (UPS battery %) and others warn when
// HIGH (temperature), and a check might care about either or both.
function evaluateSnmpValue(
  value: number,
  thresholds: { warnBelow?: number; criticalBelow?: number; warnAbove?: number; criticalAbove?: number }
): { status: "up" | "down" | "warn"; message: string | null } {
  if (thresholds.criticalBelow != null && value < thresholds.criticalBelow) {
    return { status: "down", message: `${value} is below critical threshold ${thresholds.criticalBelow}` };
  }
  if (thresholds.criticalAbove != null && value > thresholds.criticalAbove) {
    return { status: "down", message: `${value} is above critical threshold ${thresholds.criticalAbove}` };
  }
  if (thresholds.warnBelow != null && value < thresholds.warnBelow) {
    return { status: "warn", message: `${value} is below warn threshold ${thresholds.warnBelow}` };
  }
  if (thresholds.warnAbove != null && value > thresholds.warnAbove) {
    return { status: "warn", message: `${value} is above warn threshold ${thresholds.warnAbove}` };
  }
  return { status: "up", message: null };
}

const SNMP_AUTH_PROTOCOLS: Record<string, snmp.AuthProtocols> = { md5: snmp.AuthProtocols.md5, sha: snmp.AuthProtocols.sha };
const SNMP_PRIV_PROTOCOLS: Record<string, snmp.PrivProtocols> = { des: snmp.PrivProtocols.des, aes: snmp.PrivProtocols.aes };
const SNMP_SECURITY_LEVELS: Record<string, snmp.SecurityLevel> = {
  noAuthNoPriv: snmp.SecurityLevel.noAuthNoPriv,
  authNoPriv: snmp.SecurityLevel.authNoPriv,
  authPriv: snmp.SecurityLevel.authPriv,
};

function openSnmpSession(config: Record<string, unknown>): snmp.Session {
  const host = String(config.host ?? "");
  const port = Number(config.port) || 161;
  const version = String(config.version ?? "2c");
  const options = { port, timeout: 5000, retries: 1 };

  if (version === "3") {
    const user: snmp.User = {
      name: String(config.username ?? ""),
      level: SNMP_SECURITY_LEVELS[String(config.securityLevel)] ?? snmp.SecurityLevel.authPriv,
      authProtocol: SNMP_AUTH_PROTOCOLS[String(config.authProtocol)] ?? snmp.AuthProtocols.sha,
      authKey: String(config.authKey ?? ""),
      privProtocol: SNMP_PRIV_PROTOCOLS[String(config.privProtocol)] ?? snmp.PrivProtocols.aes,
      privKey: String(config.privKey ?? ""),
    };
    return snmp.createV3Session(host, user, options);
  }
  const community = String(config.community || "public");
  return snmp.createSession(host, community, { ...options, version: version === "1" ? snmp.Version1 : snmp.Version2c });
}

// Verified for real against a real snmpd container (v1/v2c and a v3 user)
// during development — v3's engineID auto-discovery and every vendor's
// specific auth/priv protocol quirks beyond that aren't independently
// re-verified against every possible target, same honesty standard as
// every other "tested against what was actually available" note in this
// project.
function probeSnmp(config: Record<string, unknown>): Promise<ProbeResult> {
  const host = String(config.host ?? "");
  const oid = String(config.oid ?? "");
  if (!host || !oid) return Promise.resolve({ status: "warn", latencyMs: null, message: "Missing host or oid" });

  const start = Date.now();
  let session: snmp.Session;
  try {
    session = openSnmpSession(config);
  } catch (err) {
    return Promise.resolve({ status: "down", latencyMs: null, message: err instanceof Error ? err.message : "Failed to open SNMP session" });
  }

  return new Promise((resolve) => {
    session.get([oid], (error, varbinds) => {
      session.close();
      const latencyMs = Date.now() - start;
      if (error) {
        resolve({ status: "down", latencyMs: null, message: error.message });
        return;
      }
      const vb = varbinds?.[0];
      if (!vb) {
        resolve({ status: "down", latencyMs: null, message: "No response" });
        return;
      }
      if (snmp.isVarbindError(vb)) {
        resolve({ status: "down", latencyMs: null, message: snmp.varbindError(vb) });
        return;
      }
      const value = Number(vb.value);
      if (Number.isNaN(value)) {
        resolve({ status: "warn", latencyMs, message: `Returned a non-numeric value: ${vb.value}` });
        return;
      }
      const { status, message } = evaluateSnmpValue(value, {
        warnBelow: config.warnBelow != null ? Number(config.warnBelow) : undefined,
        criticalBelow: config.criticalBelow != null ? Number(config.criticalBelow) : undefined,
        warnAbove: config.warnAbove != null ? Number(config.warnAbove) : undefined,
        criticalAbove: config.criticalAbove != null ? Number(config.criticalAbove) : undefined,
      });
      resolve({ status, latencyMs, message: message ?? `${value}` });
    });
    session.on("error", (err) => {
      resolve({ status: "down", latencyMs: null, message: err.message });
    });
  });
}
