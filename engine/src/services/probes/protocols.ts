import crypto from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import dgram from "node:dgram";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import * as grpc from "@grpc/grpc-js";
import { type Config, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { parsePayload, tcpExchange, udpExchange } from "./net.js";
import { httpRequest } from "./http.js";

const execFileAsync = promisify(execFile);

// A9: send a payload, optionally require text in the reply. Without a
// reply there is no way to tell "open" from "filtered" on UDP, so a
// missing reply is always down.
export async function probeUdp(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  const port = numOr(config, "port", 0);
  if (!host || !port) return warn("Missing host or port");
  try {
    const { data, latencyMs } = await udpExchange({ host, port, payload: parsePayload(str(config, "payload", "ping"), bool(config, "payloadHex")), timeoutMs: numOr(config, "timeoutSeconds", 5) * 1000 });
    const expect = str(config, "expectContains");
    const text = data.toString("latin1");
    if (expect && !text.includes(expect) && !data.toString("hex").includes(expect.toLowerCase().replace(/\s/g, ""))) {
      return { status: "down", latencyMs, message: `Reply didn't contain "${expect}"` };
    }
    return { status: "up", latencyMs, message: `${data.length}-byte reply` };
  } catch (err) {
    return down(errMsg(err));
  }
}

const DEFAULT_PORTS: Record<string, { port: number; tls?: boolean }> = {
  smtp: { port: 25 },
  smtps: { port: 465, tls: true },
  submission: { port: 587 },
  imap: { port: 143 },
  imaps: { port: 993, tls: true },
  pop3: { port: 110 },
  pop3s: { port: 995, tls: true },
  ftp: { port: 21 },
  ftps: { port: 990, tls: true },
  ssh: { port: 22 },
  sftp: { port: 22 },
  ldap: { port: 389 },
  ldaps: { port: 636, tls: true },
  rdp: { port: 3389 },
};

function berLength(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
const ber = (tag: number, body: Buffer) => Buffer.concat([Buffer.from([tag]), berLength(body.length), body]);

// LDAPv3 simple BindRequest (anonymous when dn/password are empty).
export function ldapBindRequest(dn: string, password: string): Buffer {
  const bind = ber(0x60, Buffer.concat([ber(0x02, Buffer.from([3])), ber(0x04, Buffer.from(dn)), ber(0x80, Buffer.from(password))]));
  return ber(0x30, Buffer.concat([ber(0x02, Buffer.from([1])), bind]));
}

// Finds BindResponse (0x61) and returns its resultCode, or null if the
// reply isn't complete yet.
export function ldapBindResult(buf: Buffer): number | null {
  const i = buf.indexOf(0x61);
  if (i < 0) return null;
  const j = buf.indexOf(0x0a, i);
  if (j < 0 || j + 2 >= buf.length) return null;
  return buf[j + 2];
}

// X.224 Connection Request carrying an RDP negotiation request for
// TLS + CredSSP — any real RDP server answers with a Connection Confirm.
const RDP_CR = Buffer.from("030000130ee000000000000100080003000000", "hex");

const lines = (b: Buffer) => b.toString("latin1");

// A10: talk just enough of each protocol to know the service is really
// answering (a banner, a capability list, a bind result), then hang up.
export async function probeProtocol(config: Config): Promise<ProbeOutcome> {
  const protocol = str(config, "protocol", "smtp");
  const defaults = DEFAULT_PORTS[protocol] ?? { port: 0 };
  const host = str(config, "host");
  const port = numOr(config, "port", defaults.port);
  const useTls = config.tls == null ? Boolean(defaults.tls) : bool(config, "tls");
  if (!host || !port) return warn("Missing host or port");
  const timeoutMs = numOr(config, "timeoutSeconds", 8) * 1000;
  const base = { host, port, tls: useTls, insecure: bool(config, "insecureSkipVerify"), timeoutMs };
  const expect = str(config, "expect");
  try {
    let banner = "";
    let latencyMs = 0;
    switch (protocol) {
      case "smtp":
      case "smtps":
      case "submission": {
        const out = await smtpDialogue(base);
        banner = out.text;
        latencyMs = out.latencyMs;
        if (!/^220/.test(banner)) return { status: "down", latencyMs, message: `Unexpected SMTP banner: ${banner.split("\n")[0]}` };
        if (bool(config, "requireStartTls") && !useTls && !/STARTTLS/i.test(banner)) return { status: "down", latencyMs, message: "Server doesn't advertise STARTTLS" };
        break;
      }
      case "imap":
      case "imaps": {
        const r = await tcpExchange({ ...base, until: (b) => /\r?\n/.test(lines(b)) });
        banner = lines(r.data);
        latencyMs = r.latencyMs;
        if (!/^\* (OK|PREAUTH)/i.test(banner)) return { status: "down", latencyMs, message: `Unexpected IMAP greeting: ${banner.trim()}` };
        if (bool(config, "requireStartTls") && !useTls && !/STARTTLS/i.test(banner)) return { status: "warn", latencyMs, message: "Greeting doesn't advertise STARTTLS" };
        break;
      }
      case "pop3":
      case "pop3s": {
        const r = await tcpExchange({ ...base, until: (b) => /\r?\n/.test(lines(b)) });
        banner = lines(r.data);
        latencyMs = r.latencyMs;
        if (!/^\+OK/.test(banner)) return { status: "down", latencyMs, message: `Unexpected POP3 greeting: ${banner.trim()}` };
        break;
      }
      case "ftp":
      case "ftps": {
        const r = await tcpExchange({ ...base, until: (b) => /^220 [^\r\n]*\r?\n/m.test(lines(b)) || /^[45]\d\d /m.test(lines(b)) });
        banner = lines(r.data);
        latencyMs = r.latencyMs;
        if (!/^220/m.test(banner)) return { status: "down", latencyMs, message: `Unexpected FTP banner: ${banner.trim()}` };
        break;
      }
      case "ssh":
      case "sftp": {
        const r = await tcpExchange({ ...base, until: (b) => /SSH-[\d.]+-[^\r\n]*\r?\n/.test(lines(b)) });
        banner = lines(r.data);
        latencyMs = r.latencyMs;
        const m = banner.match(/SSH-[\d.]+-[^\r\n]*/);
        if (!m) return { status: "down", latencyMs, message: "No SSH identification banner" };
        banner = m[0];
        break;
      }
      case "ldap":
      case "ldaps": {
        const r = await tcpExchange({ ...base, send: ldapBindRequest(str(config, "bindDn"), str(config, "bindPassword")), until: (b) => ldapBindResult(b) != null });
        latencyMs = r.latencyMs;
        const code = ldapBindResult(r.data);
        if (code == null) return { status: "down", latencyMs, message: "No LDAP bind response" };
        if (code !== 0) return { status: "down", latencyMs, message: `LDAP bind failed (resultCode ${code}${code === 49 ? ", invalid credentials" : ""})` };
        banner = str(config, "bindDn") ? `Bound as ${str(config, "bindDn")}` : "Anonymous bind OK";
        break;
      }
      case "rdp": {
        const r = await tcpExchange({ ...base, send: RDP_CR, until: (b) => b.length >= 11 });
        latencyMs = r.latencyMs;
        if (r.data[0] !== 0x03 || r.data[5] !== 0xd0) return { status: "down", latencyMs, message: "Not an RDP Connection Confirm" };
        banner = "RDP connection confirm received";
        break;
      }
      default:
        return warn(`Unknown protocol: ${protocol}`);
    }
    if (expect && !new RegExp(expect, "i").test(banner)) return { status: "down", latencyMs, message: `Response didn't match /${expect}/: ${banner.split("\n")[0].trim()}` };
    return { status: "up", latencyMs, message: banner.split(/\r?\n/)[0].trim().slice(0, 200) };
  } catch (err) {
    return down(errMsg(err));
  }
}

// SMTP is reply-driven (banner, then EHLO, then the capability list), which
// tcpExchange's single send can't express — so it gets its own small loop.
function smtpDialogue(base: { host: string; port: number; tls?: boolean; insecure?: boolean; timeoutMs: number }): Promise<{ text: string; latencyMs: number }> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const socket = base.tls
      ? tls.connect({ host: base.host, port: base.port, rejectUnauthorized: !base.insecure, servername: net.isIP(base.host) ? undefined : base.host })
      : net.createConnection({ host: base.host, port: base.port });
    let buf = "";
    let stage: "banner" | "ehlo" = "banner";
    let bannerText = "";
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out talking SMTP to ${base.host}:${base.port}`));
    }, base.timeoutMs);
    const complete = (s: string) => /(^|\n)\d{3} [^\n]*\n$/.test(s.replace(/\r/g, ""));
    socket.on("data", (chunk: Buffer) => {
      buf += chunk.toString("latin1");
      if (!complete(buf)) return;
      if (stage === "banner") {
        bannerText = buf;
        buf = "";
        if (!/^220/.test(bannerText)) {
          clearTimeout(timer);
          socket.destroy();
          resolve({ text: bannerText, latencyMs: Date.now() - start });
          return;
        }
        stage = "ehlo";
        socket.write("EHLO looksee.monitor\r\n");
      } else {
        clearTimeout(timer);
        socket.write("QUIT\r\n");
        socket.end();
        resolve({ text: `${bannerText}${buf}`, latencyMs: Date.now() - start });
      }
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// NTP timestamps count seconds since 1900-01-01.
const NTP_EPOCH_OFFSET = 2_208_988_800;
function readNtpTime(buf: Buffer, offset: number): number {
  return (buf.readUInt32BE(offset) - NTP_EPOCH_OFFSET) * 1000 + (buf.readUInt32BE(offset + 4) / 2 ** 32) * 1000;
}

export async function probeNtp(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  if (!host) return warn("Missing host");
  const req = Buffer.alloc(48);
  req[0] = 0x1b; // LI 0, version 3, mode 3 (client)
  const t1 = Date.now();
  try {
    const { data } = await udpExchange({ host, port: numOr(config, "port", 123), payload: req, timeoutMs: 5000 });
    const t4 = Date.now();
    if (data.length < 48) return down("Short NTP reply");
    const stratum = data[1];
    const t2 = readNtpTime(data, 32);
    const t3 = readNtpTime(data, 40);
    const offset = (t2 - t1 + (t3 - t4)) / 2;
    const delay = t4 - t1 - (t3 - t2);
    const details = { stratum, offsetMs: Math.round(offset), delayMs: Math.round(delay) };
    const latencyMs = Math.max(0, Math.round(delay));
    if (stratum === 0 || stratum >= 16) return { status: "down", latencyMs, message: `Server is unsynchronized (stratum ${stratum})`, value: Math.abs(offset), details };
    const maxStratum = numOr(config, "maxStratum", 15);
    if (stratum > maxStratum) return { status: "warn", latencyMs, message: `Stratum ${stratum} exceeds ${maxStratum}`, value: Math.abs(offset), details };
    const crit = numOr(config, "offsetCriticalMs", NaN);
    const w = numOr(config, "offsetWarnMs", NaN);
    const status = Math.abs(offset) >= crit ? "down" : Math.abs(offset) >= w ? "warn" : "up";
    return { status, latencyMs, message: `Stratum ${stratum}, offset ${Math.round(offset)}ms`, value: Math.abs(offset), details };
  } catch (err) {
    return down(errMsg(err));
  }
}

export function buildDhcpDiscover(xid: number, mac: Buffer): Buffer {
  const p = Buffer.alloc(240);
  p[0] = 1; // BOOTREQUEST
  p[1] = 1; // Ethernet
  p[2] = 6;
  p.writeUInt32BE(xid, 4);
  p.writeUInt16BE(0x8000, 10); // broadcast reply
  mac.copy(p, 28);
  p.writeUInt32BE(0x63825363, 236); // magic cookie
  const options = Buffer.from([53, 1, 1, 55, 4, 1, 3, 6, 51, 255]);
  return Buffer.concat([p, options]);
}

export function parseDhcpOffer(buf: Buffer, xid: number): { offeredIp: string; serverId: string | null; type: number } | null {
  if (buf.length < 240 || buf[0] !== 2 || buf.readUInt32BE(4) !== xid || buf.readUInt32BE(236) !== 0x63825363) return null;
  let i = 240;
  let type = 0;
  let serverId: string | null = null;
  while (i < buf.length && buf[i] !== 255) {
    const code = buf[i];
    if (code === 0) {
      i++;
      continue;
    }
    const len = buf[i + 1];
    const val = buf.subarray(i + 2, i + 2 + len);
    if (code === 53) type = val[0];
    if (code === 54 && len === 4) serverId = Array.from(val).join(".");
    i += 2 + len;
  }
  return { offeredIp: Array.from(buf.subarray(16, 20)).join("."), serverId, type };
}

// A17: DISCOVER only, never REQUEST, so no lease is actually taken. Needs to
// bind UDP 68, a privileged port — see the deployment guide for the
// cap_net_bind_service step. expectedServer turns this into a rogue-DHCP
// detector.
export function probeDhcp(config: Config): Promise<ProbeOutcome> {
  const server = str(config, "server", "255.255.255.255");
  const serverPort = numOr(config, "serverPort", 67);
  const clientPort = numOr(config, "clientPort", 68);
  const xid = crypto.randomInt(1, 0xffffffff);
  const mac = Buffer.from([0x02, ...crypto.randomBytes(5)]);
  const start = Date.now();
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const timer = setTimeout(() => finish(down(`No DHCP offer within ${numOr(config, "timeoutSeconds", 5)}s`)), numOr(config, "timeoutSeconds", 5) * 1000);
    let done = false;
    function finish(r: ProbeOutcome) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        // already closed
      }
      resolve(r);
    }
    socket.on("message", (msg) => {
      const offer = parseDhcpOffer(msg, xid);
      if (!offer || offer.type !== 2) return;
      const latencyMs = Date.now() - start;
      const expected = str(config, "expectedServer");
      const details = offer;
      if (expected && offer.serverId !== expected) finish({ status: "down", latencyMs, message: `Offer came from ${offer.serverId}, expected ${expected} (possible rogue DHCP server)`, details });
      else finish({ status: "up", latencyMs, message: `Offered ${offer.offeredIp} by ${offer.serverId ?? "unknown server"}`, details });
    });
    socket.on("error", (err) => finish(down(`${errMsg(err)}${(err as { code?: string }).code === "EACCES" ? " — binding UDP port 68 needs the cap_net_bind_service capability (see the deployment guide)" : ""}`)));
    socket.bind(clientPort, () => {
      socket.setBroadcast(true);
      socket.send(buildDhcpDiscover(xid, mac), serverPort, server, (err) => err && finish(down(errMsg(err))));
    });
  });
}

function mqttString(s: string) {
  const b = Buffer.from(s, "utf-8");
  const len = Buffer.alloc(2);
  len.writeUInt16BE(b.length);
  return Buffer.concat([len, b]);
}

function mqttRemainingLength(n: number) {
  const out: number[] = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return Buffer.from(out);
}

export function buildMqttConnect(clientId: string, username?: string, password?: string): Buffer {
  let flags = 0x02;
  if (username) flags |= 0x80;
  if (password) flags |= 0x40;
  const variable = Buffer.concat([mqttString("MQTT"), Buffer.from([4, flags, 0, 30])]);
  const payload = Buffer.concat([mqttString(clientId), username ? mqttString(username) : Buffer.alloc(0), password ? mqttString(password) : Buffer.alloc(0)]);
  const body = Buffer.concat([variable, payload]);
  return Buffer.concat([Buffer.from([0x10]), mqttRemainingLength(body.length), body]);
}

const MQTT_CODES = ["accepted", "unacceptable protocol version", "identifier rejected", "server unavailable", "bad username or password", "not authorized"];

export async function probeMqtt(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  const useTls = bool(config, "tls");
  const port = numOr(config, "port", useTls ? 8883 : 1883);
  if (!host) return warn("Missing host");
  try {
    const r = await tcpExchange({
      host,
      port,
      tls: useTls,
      insecure: bool(config, "insecureSkipVerify"),
      send: buildMqttConnect(`looksee-${crypto.randomBytes(4).toString("hex")}`, str(config, "username") || undefined, str(config, "password") || undefined),
      until: (b) => b.length >= 4,
    });
    if (r.data[0] !== 0x20) return { status: "down", latencyMs: r.latencyMs, message: "Not an MQTT CONNACK" };
    const rc = r.data[3];
    if (rc !== 0) return { status: "down", latencyMs: r.latencyMs, message: `Connection refused: ${MQTT_CODES[rc] ?? `code ${rc}`}` };
    return { status: "up", latencyMs: r.latencyMs, message: "CONNACK accepted" };
  } catch (err) {
    return down(errMsg(err));
  }
}

export function probeWebsocket(config: Config): Promise<ProbeOutcome> {
  const url = str(config, "url");
  if (!url) return Promise.resolve(warn("Missing url"));
  const start = Date.now();
  const timeoutMs = numOr(config, "timeoutSeconds", 10) * 1000;
  return new Promise((resolve) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(url, { rejectUnauthorized: !bool(config, "insecureSkipVerify"), handshakeTimeout: timeoutMs });
    } catch (err) {
      resolve(down(errMsg(err)));
      return;
    }
    const send = str(config, "send");
    const expect = str(config, "expectContains");
    let done = false;
    const finish = (r: ProbeOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      ws.terminate();
      resolve(r);
    };
    const timer = setTimeout(() => finish(down(expect ? `No message containing "${expect}" within ${timeoutMs / 1000}s` : "Timed out")), timeoutMs);
    ws.on("open", () => {
      if (send) ws.send(send);
      if (!expect) finish({ status: "up", latencyMs: Date.now() - start, message: "Handshake OK" });
    });
    ws.on("message", (data) => {
      if (expect && data.toString().includes(expect)) finish({ status: "up", latencyMs: Date.now() - start, message: `Received "${expect}"` });
    });
    ws.on("unexpected-response", (_req, res) => finish(down(`Handshake rejected: HTTP ${res.statusCode}`)));
    ws.on("error", (err) => finish(down(errMsg(err))));
  });
}

const GRPC_STATUS = ["UNKNOWN", "SERVING", "NOT_SERVING", "SERVICE_UNKNOWN"];

// grpc.health.v1.Health/Check with hand-encoded protobuf — the request is a
// single string field and the reply a single enum, not worth a .proto file.
export function probeGrpc(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  const port = numOr(config, "port", 0);
  if (!host || !port) return Promise.resolve(warn("Missing host or port"));
  const service = str(config, "service");
  const creds = bool(config, "tls")
    ? grpc.credentials.createSsl(null, null, null, bool(config, "insecureSkipVerify") ? { checkServerIdentity: () => undefined } : undefined)
    : grpc.credentials.createInsecure();
  const client = new grpc.Client(`${host}:${port}`, creds);
  const start = Date.now();
  return new Promise((resolve) => {
    const deadline = new Date(Date.now() + numOr(config, "timeoutSeconds", 8) * 1000);
    client.makeUnaryRequest(
      "/grpc.health.v1.Health/Check",
      (svc: string) => (svc ? Buffer.concat([Buffer.from([0x0a, Buffer.byteLength(svc)]), Buffer.from(svc)]) : Buffer.alloc(0)),
      (buf: Buffer) => (buf.length >= 2 && buf[0] === 0x08 ? buf[1] : 0),
      service,
      new grpc.Metadata(),
      { deadline },
      (err, status) => {
        client.close();
        const latencyMs = Date.now() - start;
        if (err) return resolve(down(`${err.details || err.message}`));
        const name = GRPC_STATUS[status ?? 0] ?? String(status);
        resolve({ status: status === 1 ? "up" : "down", latencyMs, message: `${service || "server"}: ${name}` });
      }
    );
  });
}

// Docker Registry HTTP API v2. /v2/ answering 200 or 401 means a registry
// is there; with an image, the manifest must exist too (following the
// anonymous/basic bearer-token dance registries like Docker Hub use).
export async function probeDockerRegistry(config: Config): Promise<ProbeOutcome> {
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  const insecure = bool(config, "insecureSkipVerify");
  try {
    const ping = await httpRequest(`${base}/v2/`, { insecure, followRedirects: true });
    if (ping.status !== 200 && ping.status !== 401) return { status: "down", latencyMs: ping.latencyMs, message: `/v2/ returned HTTP ${ping.status}` };
    const image = str(config, "image");
    if (!image) return { status: "up", latencyMs: ping.latencyMs, message: `Registry API reachable (HTTP ${ping.status})` };
    const tag = str(config, "tag", "latest");
    const accept = "application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.oci.image.manifest.v1+json";
    const user = str(config, "username");
    const pass = str(config, "password");
    const basic = user ? `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` : undefined;
    let headers: Record<string, string> = { Accept: accept, ...(basic ? { Authorization: basic } : {}) };
    let res = await httpRequest(`${base}/v2/${image}/manifests/${tag}`, { method: "HEAD", headers, insecure });
    const challenge = String(res.headers["www-authenticate"] ?? "");
    if (res.status === 401 && /^Bearer/i.test(challenge)) {
      const realm = challenge.match(/realm="([^"]+)"/)?.[1];
      const svc = challenge.match(/service="([^"]+)"/)?.[1];
      if (realm) {
        const tokenUrl = `${realm}?${svc ? `service=${encodeURIComponent(svc)}&` : ""}scope=${encodeURIComponent(`repository:${image}:pull`)}`;
        const tok = await httpRequest(tokenUrl, { headers: basic ? { Authorization: basic } : {}, insecure });
        const token = (JSON.parse(tok.body) as { token?: string; access_token?: string });
        headers = { Accept: accept, Authorization: `Bearer ${token.token ?? token.access_token}` };
        res = await httpRequest(`${base}/v2/${image}/manifests/${tag}`, { method: "HEAD", headers, insecure });
      }
    }
    if (res.status !== 200) return { status: "down", latencyMs: res.latencyMs, message: `${image}:${tag} manifest returned HTTP ${res.status}` };
    const digest = String(res.headers["docker-content-digest"] ?? "");
    return { status: "up", latencyMs: res.latencyMs, message: `${image}:${tag} present${digest ? ` (${digest.slice(0, 19)}…)` : ""}`, details: { digest } };
  } catch (err) {
    return down(errMsg(err));
  }
}

export function normalizeMac(mac: string): string {
  const hex = mac.toLowerCase().replace(/[^0-9a-f]/g, "");
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(":") : mac.toLowerCase();
}

// "ip neigh" on Linux, "arp -a" elsewhere — returns ip -> mac for entries
// the kernel still considers live.
export function parseArpTable(output: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    const neigh = line.match(/^(\S+)\s+dev\s+\S+\s+lladdr\s+([0-9a-f:]+)\s+(\S+)/i);
    if (neigh) {
      if (!/FAILED|INCOMPLETE/i.test(neigh[3])) map.set(neigh[1], normalizeMac(neigh[2]));
      continue;
    }
    const win = line.match(/^\s*(\d+\.\d+\.\d+\.\d+)\s+([0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2}[-:][0-9a-f]{2})/i);
    if (win) {
      map.set(win[1], normalizeMac(win[2]));
      continue;
    }
    const bsd = line.match(/\((\d+\.\d+\.\d+\.\d+)\) at ([0-9a-f:]+)/i);
    if (bsd && !/incomplete/i.test(line)) map.set(bsd[1], normalizeMac(bsd[2]));
  }
  return map;
}

async function readArpTable(): Promise<Map<string, string>> {
  try {
    if (process.platform === "linux") return parseArpTable((await execFileAsync("ip", ["neigh", "show"])).stdout);
  } catch {
    // fall through to arp -a (iproute2 missing)
  }
  return parseArpTable((await execFileAsync("arp", ["-a"])).stdout);
}

// A19: is a device present on the engine's own LAN segment, by IP and/or
// MAC — works even for devices that drop ping, since the ARP reply happens
// before any firewall sees the ICMP.
export async function probeArp(config: Config): Promise<ProbeOutcome> {
  const ip = str(config, "ip");
  const mac = str(config, "mac") ? normalizeMac(str(config, "mac")) : "";
  if (!ip && !mac) return warn("Set an IP, a MAC, or both");
  const start = Date.now();
  if (ip) {
    const args = process.platform === "win32" ? ["-n", "1", "-w", "1000", ip] : ["-c", "1", "-W", "1", ip];
    await execFileAsync("ping", args).catch(() => null);
  }
  let table: Map<string, string>;
  try {
    table = await readArpTable();
  } catch (err) {
    return warn(`Couldn't read the ARP table: ${errMsg(err)}`);
  }
  const latencyMs = Date.now() - start;
  if (ip) {
    const found = table.get(ip);
    if (!found) return { status: "down", latencyMs, message: `${ip} isn't in the ARP table (not present on this LAN segment)` };
    if (mac && found !== mac) return { status: "down", latencyMs, message: `${ip} answered from ${found}, expected ${mac} (IP conflict or replaced device?)`, details: { mac: found } };
    return { status: "up", latencyMs, message: `${ip} at ${found}`, details: { mac: found } };
  }
  const entry = [...table.entries()].find(([, m]) => m === mac);
  if (!entry) return { status: "down", latencyMs, message: `${mac} isn't in the ARP table — scan the subnet first or set its IP` };
  return { status: "up", latencyMs, message: `${mac} at ${entry[0]}`, details: { ip: entry[0] } };
}

// Wake-on-LAN magic packet: 6x 0xFF then the MAC 16 times, broadcast to UDP 9.
export async function sendWakeOnLan(mac: string, broadcast = "255.255.255.255", port = 9): Promise<void> {
  const hex = normalizeMac(mac).replace(/:/g, "");
  if (hex.length !== 12) throw new Error(`Invalid MAC address: ${mac}`);
  const macBytes = Buffer.from(hex, "hex");
  const packet = Buffer.concat([Buffer.alloc(6, 0xff), ...Array(16).fill(macBytes)]);
  const socket = dgram.createSocket("udp4");
  await new Promise<void>((resolve, reject) => {
    socket.bind(() => {
      socket.setBroadcast(true);
      socket.send(packet, port, broadcast, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}
