import dgram from "node:dgram";
import net from "node:net";
import * as snmp from "net-snmp";
import { type Flow, TemplateCache, parseNetflowV5, parseSflow, parseTemplated, servicePort } from "./flows.js";

// Listening and parsing for syslog, SNMP traps and flow exports, with no
// database access: the engine plugs in a sink that writes to Postgres, a
// site collector plugs in one that forwards over HTTPS.

export type EventInput = {
  source: "snmp_trap" | "syslog";
  sourceIp: string;
  severity: number | null;
  facility: number | null;
  message: string;
  data: Record<string, unknown> | null;
  receivedAt: string;
};

export type FlowRow = { bucket: string; exporter: string; srcAddr: string; dstAddr: string; protocol: number; dstPort: number; bytes: number; packets: number };

const DEFAULT_ALLOWED = "10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,127.0.0.0/8,169.254.0.0/16,100.64.0.0/10,::1/128,fc00::/7,fe80::/10";

function ipv4ToInt(ip: string): number | null {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return ((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3];
}

export const stripMapped = (ip: string) => ip.replace(/^::ffff:/, "");

// Receivers accept unauthenticated UDP/TCP, so by default only private
// address space may send to them (RECEIVER_ALLOWED_SOURCES overrides; "*"
// allows everyone). IPv6 matching is prefix-string based, which is exact
// for the /7, /10 and /128 defaults.
export function sourceAllowed(address: string, spec = process.env.RECEIVER_ALLOWED_SOURCES || DEFAULT_ALLOWED): boolean {
  const ip = stripMapped(address);
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
// capped per source per second.
const rate = new Map<string, { second: number; count: number }>();
const MAX_EVENTS_PER_SOURCE_PER_SEC = 50;
export function underRateLimit(source: string): boolean {
  const second = Math.floor(Date.now() / 1000);
  const r = rate.get(source);
  if (!r || r.second !== second) {
    rate.set(source, { second, count: 1 });
    return true;
  }
  r.count++;
  return r.count <= MAX_EVENTS_PER_SOURCE_PER_SEC;
}

export function syslogEvent(raw: string, sourceIp: string): EventInput | null {
  if (!raw.trim()) return null;
  const p = parseSyslog(raw);
  return { source: "syslog", sourceIp: stripMapped(sourceIp), severity: p.severity, facility: p.facility, message: p.message.slice(0, 4000), data: { host: p.host, app: p.app }, receivedAt: new Date().toISOString() };
}

const TRAP_OID = "1.3.6.1.6.3.1.1.4.1.0";
export type TrapNotification = { pdu: { varbinds: snmp.Varbind[]; enterprise?: string; generic?: number; specific?: number }; rinfo: { address: string } };
const vbText = (v: unknown) => (Buffer.isBuffer(v) ? v.toString("utf-8") : String(v));

export function trapEvent(notification: TrapNotification): EventInput {
  const vbs = notification.pdu.varbinds ?? [];
  const trapOid = String(vbs.find((v) => v.oid === TRAP_OID)?.value ?? (notification.pdu.enterprise ? `${notification.pdu.enterprise} generic ${notification.pdu.generic} specific ${notification.pdu.specific}` : "unknown"));
  const values = vbs.filter((v) => v.oid !== TRAP_OID && v.oid !== "1.3.6.1.2.1.1.3.0").map((v) => `${v.oid}=${vbText(v.value)}`);
  return {
    source: "snmp_trap",
    sourceIp: stripMapped(notification.rinfo.address),
    severity: 4,
    facility: null,
    message: `${trapOid}${values.length ? ` ${values.join(" ")}` : ""}`.slice(0, 4000),
    data: { trapOid, varbinds: vbs.map((v) => ({ oid: v.oid, value: vbText(v.value) })) },
    receivedAt: new Date().toISOString(),
  };
}

// Flows are summed per (exporter, src, dst, proto, service port) and drained
// once a minute; only each exporter's top FLOW_TOP_N conversations per
// minute are kept.
const FLOW_TOP_N = 1000;
type Pending = { exporter: string; src: string; dst: string; protocol: number; port: number; bytes: number; packets: number };

export class FlowAggregator {
  private pending = new Map<string, Pending>();
  private templates = new TemplateCache();

  add(exporter: string, flows: Flow[]) {
    for (const f of flows) {
      const port = servicePort(f);
      const key = `${exporter}|${f.src}|${f.dst}|${f.protocol}|${port}`;
      const cur = this.pending.get(key);
      if (cur) {
        cur.bytes += f.bytes;
        cur.packets += f.packets;
      } else this.pending.set(key, { exporter, src: f.src, dst: f.dst, protocol: f.protocol, port, bytes: f.bytes, packets: f.packets });
    }
  }

  handlePacket(msg: Buffer, exporter: string) {
    if (msg.length < 4) return;
    const version = msg.readUInt16BE(0);
    if (version === 5) this.add(exporter, parseNetflowV5(msg));
    else if (version === 9 || version === 10) this.add(exporter, parseTemplated(msg, exporter, this.templates));
    else if (msg.readUInt32BE(0) === 5) {
      const { agent, flows } = parseSflow(msg);
      this.add(agent ?? exporter, flows);
    }
  }

  drain(now = new Date()): FlowRow[] {
    if (!this.pending.size) return [];
    const bucket = new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
    const byExporter = new Map<string, Pending[]>();
    for (const v of this.pending.values()) {
      if (!byExporter.has(v.exporter)) byExporter.set(v.exporter, []);
      byExporter.get(v.exporter)!.push(v);
    }
    this.pending.clear();
    return [...byExporter.values()].flatMap((list) =>
      list
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, FLOW_TOP_N)
        .map((v) => ({ bucket, exporter: v.exporter, srcAddr: v.src, dstAddr: v.dst, protocol: v.protocol, dstPort: v.port, bytes: v.bytes, packets: v.packets }))
    );
  }
}

export function portFromEnv(name: string, fallback: number): number | null {
  const raw = process.env[name];
  if (raw === "0" || raw === "off" || raw === "") return null;
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export type ReceiverPorts = { syslog: number | null; trap: number | null; flow: number | null; sflow: number | null };

export type ListenerOptions = {
  ports: ReceiverPorts;
  allow: (ip: string) => boolean;
  onEvent: (e: EventInput) => void;
  flows: FlowAggregator;
  onError: (what: string, err: unknown) => void;
};

// Starts whichever listeners have a port; returns a function that stops them.
export function startListeners(o: ListenerOptions): () => void {
  const stops: (() => void)[] = [];
  const emit = (e: EventInput | null) => {
    if (e && underRateLimit(e.sourceIp)) o.onEvent(e);
  };
  if (o.ports.syslog) {
    const port = o.ports.syslog;
    const udp = dgram.createSocket({ type: "udp6", ipv6Only: false });
    udp.on("message", (msg, rinfo) => {
      if (o.allow(rinfo.address)) emit(syslogEvent(msg.toString("utf-8"), rinfo.address));
    });
    udp.on("error", (err) => o.onError(`syslog UDP ${port}`, err));
    udp.bind(port);
    // TCP syslog: newline-delimited or RFC 6587 octet-counted framing.
    const tcp = net.createServer((sock) => {
      const ip = sock.remoteAddress ?? "";
      if (!o.allow(ip)) {
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
            emit(syslogEvent(buf.slice(counted[0].length, counted[0].length + len), ip));
            buf = buf.slice(counted[0].length + len);
            continue;
          }
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          emit(syslogEvent(buf.slice(0, nl), ip));
          buf = buf.slice(nl + 1);
        }
        if (buf.length > 65536) buf = "";
      });
      sock.on("error", () => undefined);
    });
    tcp.on("error", (err) => o.onError(`syslog TCP ${port}`, err));
    tcp.listen(port);
    stops.push(() => udp.close(), () => tcp.close());
  }
  if (o.ports.trap) {
    try {
      const receiver = snmp.createReceiver({ port: o.ports.trap, disableAuthorization: true, transport: "udp4" }, (err: Error | null, n: TrapNotification) => {
        if (!err && n && o.allow(n.rinfo.address)) emit(trapEvent(n));
      });
      stops.push(() => receiver.close());
    } catch (err) {
      o.onError(`SNMP traps UDP ${o.ports.trap}`, err);
    }
  }
  for (const [port, label] of [[o.ports.flow, "NetFlow/IPFIX"], [o.ports.sflow, "sFlow"]] as const) {
    if (!port) continue;
    const sock = dgram.createSocket({ type: "udp6", ipv6Only: false });
    sock.on("message", (msg, rinfo) => {
      if (!o.allow(rinfo.address)) return;
      try {
        o.flows.handlePacket(msg, stripMapped(rinfo.address));
      } catch {
        // malformed export packet — drop it
      }
    });
    sock.on("error", (err) => o.onError(`${label} UDP ${port}`, err));
    sock.bind(port);
    stops.push(() => sock.close());
  }
  return () => stops.forEach((s) => s());
}
