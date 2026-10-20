// The basic network checks: ping (loss, latency, jitter), TCP port (with
// optional send/expect), DNS (records, expected answers, DNSSEC) and TLS
// certificate (expiry, chain, hostname, legacy TLS).
//
// Run by the engine, a site collector, or an agent as a remote probe.

import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns/promises";
import { type Config, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { udpExchange } from "./net.js";
import { own } from "../../lib/own.js";

const execFileAsync = promisify(execFile);

// Every "time=12.3 ms" / "time<1ms" reply line, in order. Works for Linux,
// macOS and English Windows output alike.
export function parsePingTimes(output: string): number[] {
  const times: number[] = [];
  for (const m of output.matchAll(/time[=<]\s*([\d.]+)\s*ms/gi)) times.push(Number(m[1]));
  return times;
}

export function pingStats(times: number[], sent: number) {
  const received = times.length;
  const loss = sent > 0 ? ((sent - received) / sent) * 100 : 100;
  if (received === 0) return { loss, min: null, avg: null, max: null, jitter: null };
  const avg = times.reduce((a, b) => a + b, 0) / received;
  let jitter = 0;
  for (let i = 1; i < times.length; i++) jitter += Math.abs(times.at(i)! - times.at(i - 1)!);
  jitter = times.length > 1 ? jitter / (times.length - 1) : 0;
  return { loss, min: Math.min(...times), avg, max: Math.max(...times), jitter };
}

// Shells out to the OS's own `ping` rather than opening a raw ICMP socket —
// raw sockets need root/admin privileges on every platform this needs to
// run on; the system binary already has that privilege bit set correctly.
export async function probePing(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  if (!host) return warn("Missing host");
  const count = Math.min(Math.max(numOr(config, "count", 3), 1), 20);
  const args =
    process.platform === "win32"
      ? ["-n", String(count), "-w", "2000", host]
      : process.platform === "darwin"
        ? ["-c", String(count), "-W", "2000", host]
        : ["-c", String(count), "-i", "0.2", "-W", "2", host];
  let output: string;
  try {
    output = (await execFileAsync("ping", args, { timeout: (count * 2 + 5) * 1000 })).stdout;
  } catch (err) {
    // Non-zero exit with partial replies (some loss) still has usable output.
    output = (err as { stdout?: string }).stdout ?? "";
  }
  const stats = pingStats(parsePingTimes(output), count);
  const details = stats;
  if (stats.avg == null) return down(`No reply from ${host}`, { value: 100, details });

  const lossCrit = numOr(config, "lossCriticalPercent", NaN);
  const lossWarn = numOr(config, "lossWarnPercent", NaN);
  const jitCrit = numOr(config, "jitterCriticalMs", NaN);
  const jitWarn = numOr(config, "jitterWarnMs", NaN);
  const summary = `${Math.round(stats.loss)}% loss, avg ${stats.avg.toFixed(1)}ms, jitter ${stats.jitter!.toFixed(1)}ms`;
  const latencyMs = Math.round(stats.avg);
  let status: ProbeOutcome["status"] = "up";
  if (stats.loss >= lossCrit || stats.jitter! >= jitCrit) status = "down";
  else if (stats.loss >= lossWarn || stats.jitter! >= jitWarn) status = "warn";
  return { status, latencyMs, message: status === "up" && count === 1 ? null : summary, value: stats.loss, details };
}

/**
 * TCP port check: connects to host:port. Advanced settings: a timeout
 * (default 5 s), text to send once connected (\n and \r written as such),
 * and text the reply must contain — for services that greet with a banner
 * ("SSH-2.0", "220 ") or answer a simple command ("PING" → "+PONG").
 *
 * @param config host, port, timeoutSeconds, sendText, expectText
 */
export function probeTcp(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  const port = numOr(config, "port", 0);
  if (!host || !port) return Promise.resolve(warn("Missing host or port"));
  const timeout = Math.min(60, Math.max(1, numOr(config, "timeoutSeconds", 5))) * 1000;
  // Typed escape sequences become real line breaks: "PING\r\n".
  const sendText = str(config, "sendText").replace(/\\r/g, "\r").replace(/\\n/g, "\n");
  const expectText = str(config, "expectText");
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port, timeout });
    let received = "";
    let connectedAt = 0;
    const finish = (outcome: ProbeOutcome) => {
      socket.destroy();
      resolve(outcome);
    };
    socket.once("connect", () => {
      connectedAt = Date.now();
      if (!expectText) return finish({ status: "up", latencyMs: connectedAt - start, message: null });
      if (sendText) socket.write(sendText);
    });
    // Read the reply (at most 8 KB) until the expected text shows up.
    socket.on("data", (chunk) => {
      received = (received + chunk.toString("utf8")).slice(0, 8192);
      if (received.toLowerCase().includes(expectText.toLowerCase())) finish({ status: "up", latencyMs: Date.now() - start, message: received.split(/\r?\n/)[0].slice(0, 200) || null });
    });
    socket.once("end", () => finish(down(`Connected, but the reply didn't contain "${expectText}"${received ? `: ${received.slice(0, 120)}` : " (no reply)"}`, { latencyMs: connectedAt ? connectedAt - start : null })));
    socket.once("timeout", () => finish(down(connectedAt ? `Connected, but no reply containing "${expectText}" within ${timeout / 1000}s${received ? `: ${received.slice(0, 120)}` : ""}` : `Timed out connecting to ${host}:${port}`)));
    socket.once("error", (err) => finish(down(err.message)));
  });
}

const RR_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, SOA: 6, PTR: 12, MX: 15, TXT: 16, AAAA: 28, SRV: 33, CAA: 257 };

function answerStrings(type: string, answers: unknown): string[] {
  if (!Array.isArray(answers)) return answers && typeof answers === "object" ? [JSON.stringify(answers)] : [String(answers)];
  return answers.map((a) => {
    if (typeof a === "string") return a;
    if (Array.isArray(a)) return a.join("");
    if (type === "MX") return `${(a as { priority: number }).priority} ${(a as { exchange: string }).exchange}`;
    if (type === "SRV") return `${(a as { priority: number }).priority} ${(a as { weight: number }).weight} ${(a as { port: number }).port} ${(a as { name: string }).name}`;
    if (type === "CAA") return Object.entries(a as object).map(([k, v]) => `${k}=${v}`).join(" ");
    return JSON.stringify(a);
  });
}

// Raw wire-format query with the DO bit set, read back for the AD flag —
// node:dns has no way to ask a resolver whether it validated DNSSEC.
// The query ID is cryptographically random, so another host on the path
// can't guess it to slip in a forged answer.
export function buildDnsQuery(name: string, type: number, id = crypto.randomInt(65536)): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0120, 2); // RD + AD
  header.writeUInt16BE(1, 4); // QDCOUNT
  header.writeUInt16BE(1, 10); // ARCOUNT (OPT)
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const qname = Buffer.concat([...labels.map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l)])), Buffer.from([0])]);
  const q = Buffer.alloc(4);
  q.writeUInt16BE(type, 0);
  q.writeUInt16BE(1, 2);
  // OPT RR: root name, type 41, UDP size 4096, ext-rcode/version 0, DO bit.
  const opt = Buffer.from([0, 0, 41, 0x10, 0x00, 0, 0, 0x80, 0x00, 0, 0]);
  return Buffer.concat([header, qname, q, opt]);
}

export function parseDnsFlags(resp: Buffer) {
  const flags = resp.readUInt16BE(2);
  return { ad: Boolean(flags & 0x0020), rcode: flags & 0x000f, answers: resp.readUInt16BE(6) };
}

const RCODES = ["NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED"];

export async function probeDns(config: Config): Promise<ProbeOutcome> {
  const hostname = str(config, "hostname");
  if (!hostname) return warn("Missing hostname");
  const type = str(config, "recordType", "A").toUpperCase();
  const server = str(config, "server");
  // Advanced: how long to wait per try (default 5 s) and how many tries (2).
  const resolver = new dns.Resolver({ timeout: Math.min(30, Math.max(1, numOr(config, "timeoutSeconds", 5))) * 1000, tries: Math.min(5, Math.max(1, numOr(config, "tries", 2))) });
  if (server) resolver.setServers([server]);
  const start = Date.now();
  let answers: string[];
  try {
    const raw = type === "A" && !config.recordType ? await resolver.resolve(hostname) : await resolver.resolve(hostname, type as "A");
    answers = answerStrings(type, raw);
  } catch (err) {
    return down(`Failed to resolve ${hostname} (${type})${server ? ` via ${server}` : ""}: ${(err as { code?: string }).code ?? errMsg(err)}`);
  }
  const latencyMs = Date.now() - start;
  const expected = str(config, "expectedValue");
  if (expected && !answers.some((a) => a.toLowerCase().includes(expected.toLowerCase()))) {
    return { status: "down", latencyMs, message: `Expected "${expected}", got ${answers.join(", ") || "no answers"}`, details: { answers } };
  }
  if (bool(config, "dnssec")) {
    const target = server || dns.getServers()[0];
    const [ip, portStr] = target.includes("]") ? [target.slice(1, target.indexOf("]")), target.split("]:")[1]] : target.split(/:(?=\d+$)/);
    try {
      const { data } = await udpExchange({ host: ip, port: Number(portStr) || 53, payload: buildDnsQuery(hostname, own(RR_TYPES, type) ?? 1) });
      const { ad, rcode } = parseDnsFlags(data);
      if (rcode === 2) return { status: "down", latencyMs, message: "DNSSEC validation failed (resolver returned SERVFAIL)", details: { answers } };
      if (!ad) return { status: "down", latencyMs, message: `Answer is not DNSSEC-authenticated (no AD flag from ${ip}; ${RCODES.at(rcode) ?? rcode})`, details: { answers } };
    } catch (err) {
      return { status: "warn", latencyMs, message: `Resolved, but the DNSSEC query failed: ${errMsg(err)}`, details: { answers } };
    }
  }
  return { status: "up", latencyMs, message: answers.join(", "), details: { answers } };
}

function daysUntil(dateStr: string) {
  return Math.floor((new Date(dateStr).getTime() - Date.now()) / 86_400_000);
}

// Separate attempt capped at TLS 1.1: if the server accepts it, it still
// supports a deprecated protocol (A6). SECLEVEL=0 so our own OpenSSL
// defaults don't refuse to even try.
function acceptsLegacyTls(host: string, port: number): Promise<string | null> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, minVersion: "TLSv1", maxVersion: "TLSv1.1", ciphers: "DEFAULT@SECLEVEL=0", timeout: 5000 }, () => {
      const proto = socket.getProtocol();
      socket.destroy();
      resolve(proto);
    });
    socket.once("error", () => resolve(null));
    socket.once("timeout", () => {
      socket.destroy();
      resolve(null);
    });
  });
}

export function probeSslCert(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  const port = numOr(config, "port", 443);
  const warnDays = numOr(config, "warnDays", 14);
  const criticalDays = numOr(config, "criticalDays", 0);
  if (!host) return Promise.resolve(warn("Missing host"));
  // Advanced: the name to ask for and check the certificate against, when
  // connecting by IP or through a load balancer (default: the host itself),
  // and the connection timeout (default 5 s).
  const serverName = str(config, "serverName") || (net.isIP(host) ? "" : host);
  const timeout = Math.min(60, Math.max(1, numOr(config, "timeoutSeconds", 5))) * 1000;
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = tls.connect({ host, port, servername: serverName || undefined, rejectUnauthorized: false, timeout }, async () => {
      const latencyMs = Date.now() - start;
      const cert = socket.getPeerCertificate(true);
      const authorized = socket.authorized;
      const authError = socket.authorizationError ? String(socket.authorizationError) : null;
      const protocol = socket.getProtocol();
      socket.destroy();
      if (!cert || !cert.valid_to) {
        resolve(warn("No certificate returned"));
        return;
      }
      const daysLeft = daysUntil(cert.valid_to);
      const details = { subject: cert.subject?.CN, issuer: cert.issuer?.CN ?? cert.issuer?.O, validTo: cert.valid_to, protocol, authorized, authError };
      const base = { latencyMs, value: daysLeft, details };
      if (daysLeft < 0) return resolve({ status: "down", message: "Certificate expired", ...base });
      if (bool(config, "checkChain") && !authorized) return resolve({ status: "down", message: `Certificate chain isn't trusted: ${authError}`, ...base });
      if (bool(config, "checkHostname") && serverName) {
        const mismatch = tls.checkServerIdentity(serverName, cert);
        if (mismatch) return resolve({ status: "down", message: `Hostname mismatch: ${mismatch.message}`, ...base });
      }
      if (daysLeft <= criticalDays) return resolve({ status: "down", message: `Expires in ${daysLeft} days`, ...base });
      if (bool(config, "checkWeakProtocols")) {
        const legacy = await acceptsLegacyTls(host, port);
        if (legacy) return resolve({ status: "warn", message: `Server still accepts ${legacy}; expires in ${daysLeft} days`, ...base });
      }
      if (daysLeft <= warnDays) return resolve({ status: "warn", message: `Expires in ${daysLeft} days`, ...base });
      resolve({ status: "up", message: `Expires in ${daysLeft} days (${protocol})`, ...base });
    });
    socket.once("timeout", () => {
      socket.destroy();
      resolve(down(`Timed out connecting to ${host}:${port}`));
    });
    socket.once("error", (err) => resolve(down(err.message)));
  });
}

