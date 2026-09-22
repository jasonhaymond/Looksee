import { execFile } from "node:child_process";
import { promisify } from "node:util";
import net from "node:net";
import tls from "node:tls";
import https from "node:https";
import dns from "node:dns/promises";

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
      });
    case "dns":
      return probeDns(String(config.hostname ?? ""));
    case "ssl_cert":
      return probeSslCert(String(config.host ?? ""), Number(config.port) || 443, Number(config.warnDays) || 14);
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

type HttpOptions = { method: string; headers: Record<string, string>; insecureSkipVerify: boolean };

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
    const ok = expectedStatus ? res.status === expectedStatus : res.status < 400;
    return { status: ok ? "up" : "down", latencyMs, message: ok ? null : `HTTP ${res.status}` };
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
        res.resume(); // drain the body — only the status matters here
        const latencyMs = Date.now() - start;
        const status = res.statusCode ?? 0;
        const ok = expectedStatus ? status === expectedStatus : status < 400;
        resolve({ status: ok ? "up" : "down", latencyMs, message: ok ? null : `HTTP ${status}` });
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
