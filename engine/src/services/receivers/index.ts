import dgram from "node:dgram";
import net from "node:net";
import * as snmp from "net-snmp";
import { db } from "../../db/index.js";
import { events, flowRecords } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";
import { type Flow, TemplateCache, parseNetflowV5, parseSflow, parseTemplated, servicePort } from "./flows.js";

const DEFAULT_ALLOWED = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,169.254.0.0/16,100.64.0.0/10,::1/128,fc00::/7,fe80::/10";

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

// Receivers accept unauthenticated UDP/TCP, so by default only private
// address space may send to them (RECEIVER_ALLOWED_SOURCES overrides; "*"
// allows everyone). IPv6 matching is prefix-string based, which is exact
// for the /7, /10 and /128 defaults.
export function sourceAllowed(address: string, spec = process.env.RECEIVER_ALLOWED_SOURCES ?? DEFAULT_ALLOWED): boolean {
  const ip = address.replace(/^::ffff:/, "");
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .some((cidr) => {
      if (cidr === "*") return true;
      const [base, bitsStr] = cidr.split("/");
      const bits = Number(bitsStr ?? (base.includes(":") ? 128 : 32));
      if (!base.includes(":")) {
        const a = ipv4ToInt(ip);
        const b = ipv4ToInt(base);
        if (a == null || b == null) return false;
        const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
        return (a & mask) === (b & mask);
      }
      if (!ip.includes(":")) return false;
      if (bits === 128) return ip === base;
      if (base.toLowerCase() === "fc00::" && bits === 7) return /^f[cd]/i.test(ip);
      if (base.toLowerCase() === "fe80::" && bits === 10) return /^fe[89ab]/i.test(ip);
      return ip.toLowerCase().startsWith(base.toLowerCase().replace(/::$/, ""));
    });
}

// RFC 5424 ("<PRI>1 TS HOST APP PROCID MSGID [SD] MSG") and the older
// BSD/RFC 3164 ("<PRI>Mmm dd hh:mm:ss HOST TAG: MSG") formats.
export function parseSyslog(raw: string): { facility: number | null; severity: number | null; host: string | null; app: string | null; message: string } {
  const text = raw.replace(/\r?\n$/, "");
  const pri = text.match(/^<(\d{1,3})>/);
  if (!pri) return { facility: null, severity: null, host: null, app: null, message: text };
  const n = Number(pri[1]);
  const rest = text.slice(pri[0].length);
  const v5424 = rest.match(/^1 (\S+) (\S+) (\S+) (\S+) (\S+) (-|\[.*?\])\s?(.*)$/s);
  if (v5424) return { facility: n >> 3, severity: n & 7, host: v5424[2] === "-" ? null : v5424[2], app: v5424[3] === "-" ? null : v5424[3], message: v5424[7].replace(/^﻿/, "") };
  const bsd = rest.match(/^([A-Z][a-z]{2}\s+\d{1,2} \d{2}:\d{2}:\d{2}) (\S+) ([^:[\s]+)(?:\[\d+\])?:\s?(.*)$/s);
  if (bsd) return { facility: n >> 3, severity: n & 7, host: bsd[2], app: bsd[3], message: bsd[4] };
  return { facility: n >> 3, severity: n & 7, host: null, app: null, message: rest };
}

// Bursty sources (a switch logging a flapping port 50 times a second) are
// capped per source per second so they can't swamp the database.
const rate = new Map<string, { second: number; count: number }>();
const MAX_EVENTS_PER_SOURCE_PER_SEC = 50;
function underRateLimit(source: string): boolean {
  const second = Math.floor(Date.now() / 1000);
  const r = rate.get(source);
  if (!r || r.second !== second) {
    rate.set(source, { second, count: 1 });
    return true;
  }
  r.count++;
  return r.count <= MAX_EVENTS_PER_SOURCE_PER_SEC;
}

export async function ingestSyslog(raw: string, sourceIp: string) {
  if (!raw.trim() || !underRateLimit(sourceIp)) return;
  const p = parseSyslog(raw);
  await db.insert(events).values({ source: "syslog", sourceIp: sourceIp.replace(/^::ffff:/, ""), severity: p.severity, facility: p.facility, message: p.message.slice(0, 4000), data: { host: p.host, app: p.app } });
}

const TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0";

export async function ingestTrap(notification: { pdu: { varbinds: snmp.Varbind[]; enterprise?: string; generic?: number; specific?: number }; rinfo: { address: string } }) {
  const source = notification.rinfo.address.replace(/^::ffff:/, "");
  if (!underRateLimit(source)) return;
  const vbs = notification.pdu.varbinds ?? [];
  const trapOid = String(vbs.find((v) => v.oid === TRAP_OID)?.value ?? (notification.pdu.enterprise ? `${notification.pdu.enterprise} generic ${notification.pdu.generic} specific ${notification.pdu.specific}` : "unknown"));
  const values = vbs
    .filter((v) => v.oid !== TRAP_OID && v.oid !== "1.3.6.1.2.1.1.3.0")
    .map((v) => `${v.oid}=${Buffer.isBuffer(v.value) ? v.value.toString("utf-8") : String(v.value)}`);
  await db.insert(events).values({
    source: "snmp_trap",
    sourceIp: source,
    severity: 4,
    message: `${trapOid}${values.length ? ` ${values.join(" ")}` : ""}`.slice(0, 4000),
    data: { trapOid, varbinds: vbs.map((v) => ({ oid: v.oid, value: Buffer.isBuffer(v.value) ? v.value.toString("utf-8") : String(v.value) })) },
  });
}

// Flows are summed in memory per (exporter, src, dst, proto, service port)
// and written once a minute; only each exporter's top FLOW_TOP_N
// conversations per minute are kept.
const FLOW_TOP_N = 1000;
const pending = new Map<string, { exporter: string; src: string; dst: string; protocol: number; port: number; bytes: number; packets: number }>();

export function addFlows(exporter: string, flows: Flow[]) {
  for (const f of flows) {
    const port = servicePort(f);
    const key = `${exporter}|${f.src}|${f.dst}|${f.protocol}|${port}`;
    const cur = pending.get(key);
    if (cur) {
      cur.bytes += f.bytes;
      cur.packets += f.packets;
    } else pending.set(key, { exporter, src: f.src, dst: f.dst, protocol: f.protocol, port, bytes: f.bytes, packets: f.packets });
  }
}

export async function flushFlows(now = new Date()) {
  if (!pending.size) return 0;
  const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000);
  const byExporter = new Map<string, typeof pending extends Map<string, infer V> ? V[] : never>();
  for (const v of pending.values()) {
    if (!byExporter.has(v.exporter)) byExporter.set(v.exporter, []);
    byExporter.get(v.exporter)!.push(v);
  }
  pending.clear();
  const rows = [...byExporter.values()].flatMap((list) =>
    list
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, FLOW_TOP_N)
      .map((v) => ({ bucket, exporter: v.exporter, srcAddr: v.src, dstAddr: v.dst, protocol: v.protocol, dstPort: v.port, bytes: v.bytes, packets: v.packets }))
  );
  for (let i = 0; i < rows.length; i += 500) await db.insert(flowRecords).values(rows.slice(i, i + 500));
  return rows.length;
}

const templates = new TemplateCache();

export function handleFlowPacket(msg: Buffer, exporter: string) {
  if (msg.length < 4) return;
  const version = msg.readUInt16BE(0);
  if (version === 5) addFlows(exporter, parseNetflowV5(msg));
  else if (version === 9 || version === 10) addFlows(exporter, parseTemplated(msg, exporter, templates));
  else if (msg.readUInt32BE(0) === 5) {
    const { agent, flows } = parseSflow(msg);
    addFlows(agent ?? exporter, flows);
  }
}

function portFromEnv(name: string, fallback: number): number | null {
  const raw = process.env[name];
  if (raw === "0" || raw === "off" || raw === "") return null;
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : null;
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function startReceivers() {
  const stops: (() => void)[] = [];
  const syslogPort = portFromEnv("SYSLOG_PORT", 1514);
  if (syslogPort) {
    const udp = dgram.createSocket({ type: "udp6", ipv6Only: false });
    udp.on("message", (msg, rinfo) => {
      if (!sourceAllowed(rinfo.address)) return;
      ingestSyslog(msg.toString("utf-8"), rinfo.address).catch(() => undefined);
    });
    udp.on("error", (err) => logger.error("receivers", `Syslog UDP listener error: ${describe(err)}`, `The syslog receiver on UDP ${syslogPort} stopped working — check that the port isn't already in use.`));
    udp.bind(syslogPort);
    // TCP syslog: newline-delimited or RFC 6587 octet-counted framing.
    const tcp = net.createServer((sock) => {
      if (!sourceAllowed(sock.remoteAddress ?? "")) {
        sock.destroy();
        return;
      }
      let buf = "";
      sock.on("data", (chunk) => {
        buf += chunk.toString("utf-8");
        for (;;) {
          const counted = buf.match(/^(\d+) /);
          if (counted) {
            const len = Number(counted[1]);
            if (buf.length < counted[0].length + len) break;
            ingestSyslog(buf.slice(counted[0].length, counted[0].length + len), sock.remoteAddress ?? "").catch(() => undefined);
            buf = buf.slice(counted[0].length + len);
            continue;
          }
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          ingestSyslog(buf.slice(0, nl), sock.remoteAddress ?? "").catch(() => undefined);
          buf = buf.slice(nl + 1);
        }
        if (buf.length > 65536) buf = "";
      });
      sock.on("error", () => undefined);
    });
    tcp.on("error", (err) => logger.error("receivers", `Syslog TCP listener error: ${describe(err)}`, `The syslog receiver on TCP ${syslogPort} stopped working.`));
    tcp.listen(syslogPort);
    stops.push(() => udp.close(), () => tcp.close());
  }

  const trapPort = portFromEnv("SNMP_TRAP_PORT", 1162);
  if (trapPort) {
    try {
      const receiver = snmp.createReceiver({ port: trapPort, disableAuthorization: true, transport: "udp4" }, (err: Error | null, notification: Parameters<typeof ingestTrap>[0]) => {
        if (err || !notification || !sourceAllowed(notification.rinfo.address)) return;
        ingestTrap(notification).catch(() => undefined);
      });
      stops.push(() => receiver.close());
    } catch (err) {
      logger.error("receivers", `SNMP trap listener failed to start: ${describe(err)}`, `SNMP traps on UDP ${trapPort} won't be received.`);
    }
  }

  for (const [env, fallback, label] of [["FLOW_PORT", 2055, "NetFlow/IPFIX"], ["SFLOW_PORT", 6343, "sFlow"]] as const) {
    const port = portFromEnv(env, fallback);
    if (!port) continue;
    const sock = dgram.createSocket({ type: "udp6", ipv6Only: false });
    sock.on("message", (msg, rinfo) => {
      if (!sourceAllowed(rinfo.address)) return;
      try {
        handleFlowPacket(msg, rinfo.address.replace(/^::ffff:/, ""));
      } catch {
        // malformed export packet — drop it
      }
    });
    sock.on("error", (err) => logger.error("receivers", `${label} listener error: ${describe(err)}`, `The ${label} collector on UDP ${port} stopped working.`));
    sock.bind(port);
    stops.push(() => sock.close());
  }
  const flusher = setInterval(() => {
    flushFlows().catch((err) => logger.error("receivers", `Flow flush failed: ${describe(err)}`, "Collected flow data couldn't be saved this minute."));
  }, 60_000);
  flusher.unref();
  stops.push(() => clearInterval(flusher));

  logger.info("receivers", `Receivers: syslog ${syslogPort ?? "off"}, SNMP traps ${trapPort ?? "off"}, NetFlow/IPFIX ${portFromEnv("FLOW_PORT", 2055) ?? "off"}, sFlow ${portFromEnv("SFLOW_PORT", 6343) ?? "off"}`, "Event and flow receivers started.");
  return () => stops.forEach((s) => s());
}
