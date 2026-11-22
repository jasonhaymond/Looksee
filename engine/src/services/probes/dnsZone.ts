// DNS zone check (check type dns_zone): takes an inventory of every record in
// a zone and keeps a history of what changed between runs — records added,
// removed or changed — so an unexpected edit (a hijacked MX, a stray A record,
// a deleted SPF record) is noticed and its past is on record.
//
// Where this sits: a network probe (no database access), so the engine and
// site collectors both run it (probes/network.ts). The previous inventory and
// the change history live in the check's state (checks.state), which the
// engine stores between runs.
//
// Three ways to read the zone:
// - "axfr" (zone transfer): asks the zone's DNS server for the whole zone in
//   one TCP conversation (RFC 5936). Complete, but the server must allow
//   transfers to Looksee's address (BIND allow-transfer, Windows DNS "Zone
//   Transfers" tab), optionally authenticated with a TSIG key (RFC 8945).
// - "discover": finds the zone's names without a transfer and reads every
//   record type at each one, by plain queries any server answers. If the
//   zone is signed with DNSSEC NSEC records, it follows that chain (each
//   NSEC record names the next name in the zone and the types it has), which
//   lists the whole zone. Otherwise it looks up the zone itself, the names
//   the admin listed, a built-in list of common names (www, mail, _dmarc…),
//   and every in-zone name another record points at (MX, CNAME, SRV…
//   targets) — complete only for the names it can find.
// - "names": asks for a list of names one by one (A, AAAA, CNAME, MX, TXT,
//   NS, SRV, CAA). Works against any server, including public ones that
//   refuse transfers, but only sees the names listed.
//
// Two ways to judge changes ("baseline" setting):
// - "each_run" (the original behaviour): each run is compared with the run
//   before; a change keeps the check failing for holdMinutes, then the new
//   zone is simply the norm.
// - "pinned": the zone is compared with a saved baseline. Every difference
//   (a record added, removed or changed) is tracked on its own — when it was
//   first seen and for how many runs — and keeps the check failing until
//   it's accepted: automatically once it has been seen acceptAfterRuns runs
//   in a row (0 = never automatically), or all at once when the check is
//   marked recovered (alerting.ts's resolveCheck sets state.resolvedAt, which
//   the next run reads). A difference that goes away by itself (the record
//   was put back) is recorded as "reverted" and stops counting.
//
// Security: everything read from the network is untrusted. The DNS message
// parser checks every length and offset against the buffer, only follows
// name-compression pointers that point backwards (so a crafted answer can't
// loop forever), and caps the total size and record count. The TSIG secret
// is a write-only check setting (lib/secrets.ts) and is never logged or put
// in a result. Responses' own TSIG signatures aren't verified — the key
// proves Looksee to the server, not the other way round — so a transfer
// over an untrusted network could in principle be tampered with in transit.
// Discovery's single queries go over UDP from a socket connected to the one
// server being asked (so only that address's answers are read), each with a
// random query ID that the answer must repeat; a truncated answer is asked
// again over TCP. Discovery is bounded too: at most maxRecords names and
// records, and 5 minutes in all.

import crypto from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns";
import net from "node:net";
import { type Config, type ProbeContext, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { excludeItems, nameExcluded } from "./exclude.js";
import { own } from "../../lib/own.js";

// ---- Wire format -----------------------------------------------------------

/** DNS record type numbers this check knows by name (others show as TYPEnnn). */
const TYPE_NAMES: Record<number, string> = {
  1: "A",
  2: "NS",
  5: "CNAME",
  6: "SOA",
  12: "PTR",
  13: "HINFO",
  15: "MX",
  16: "TXT",
  28: "AAAA",
  29: "LOC",
  33: "SRV",
  35: "NAPTR",
  39: "DNAME",
  43: "DS",
  44: "SSHFP",
  46: "RRSIG",
  47: "NSEC",
  48: "DNSKEY",
  50: "NSEC3",
  51: "NSEC3PARAM",
  52: "TLSA",
  59: "CDS",
  60: "CDNSKEY",
  64: "SVCB",
  65: "HTTPS",
  99: "SPF",
  256: "URI",
  257: "CAA",
};
const typeName = (n: number) => own(TYPE_NAMES, n) ?? `TYPE${n}`;

/** A type's number from its name ("MX" → 15, "TYPE300" → 300), or null if unknown. */
function typeNumber(name: string): number | null {
  // "TYPE" followed by digits, e.g. "TYPE300" — how an unnamed type is shown.
  const generic = /^TYPE(\d+)$/.exec(name);
  if (generic) return Number(generic[1]);
  const hit = Object.entries(TYPE_NAMES).find(([, n]) => n === name);
  return hit ? Number(hit[0]) : null;
}

/** Response codes, for error messages ("REFUSED" is the usual AXFR answer). */
const RCODES = ["NOERROR", "FORMERR", "SERVFAIL", "NXDOMAIN", "NOTIMP", "REFUSED", "YXDOMAIN", "YXRRSET", "NXRRSET", "NOTAUTH", "NOTZONE"];

/** Hard limits on what one transfer may cost, whatever the server sends. */
const MAX_TRANSFER_BYTES = 64 * 1024 * 1024;
const MAX_POINTER_HOPS = 64;

/**
 * A domain name in DNS wire format: each label prefixed by its length, ending
 * with a zero byte ("example.com" → 7 example 3 com 0).
 *
 * @param name a name like "example.com" (a trailing dot is fine)
 * @throws if a label is longer than 63 bytes or the name longer than 255
 */
export function encodeName(name: string): Buffer {
  const labels = name.replace(/\.$/, "").split(".").filter(Boolean);
  const parts = labels.map((l) => {
    const bytes = Buffer.from(l, "utf8");
    if (bytes.length > 63) throw new Error(`DNS label too long: ${l}`);
    return Buffer.concat([Buffer.from([bytes.length]), bytes]);
  });
  const out = Buffer.concat([...parts, Buffer.from([0])]);
  if (out.length > 255) throw new Error("DNS name too long");
  return out;
}

/** A TSIG key (RFC 8945): its name, algorithm, and the shared key as base64 text. */
export type TsigKey = { name: string; algorithm: "hmac-sha256" | "hmac-sha512" | "hmac-sha1"; keyBase64: string };

/** Node's hash names for the TSIG algorithms Looksee supports. */
const TSIG_HASH: Record<TsigKey["algorithm"], string> = { "hmac-sha256": "sha256", "hmac-sha512": "sha512", "hmac-sha1": "sha1" };

/**
 * The AXFR (zone transfer) request, as sent over TCP after its 2-byte length.
 * With a TSIG key, a TSIG record signing the request is appended — the
 * server checks it before it will send the zone.
 *
 * @param zone the zone to transfer, e.g. "example.com"
 * @param id the query ID (random, so another host can't guess it)
 * @param tsig optional key
 * @param now the signing time (for tests)
 */
export function buildAxfrQuery(zone: string, id: number, tsig?: TsigKey, now = Date.now()): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0, 2); // a plain query; no recursion wanted
  header.writeUInt16BE(1, 4); // one question
  const question = Buffer.alloc(4);
  question.writeUInt16BE(252, 0); // QTYPE AXFR
  question.writeUInt16BE(1, 2); // class IN
  const unsigned = Buffer.concat([header, encodeName(zone), question]);
  if (!tsig) return unsigned;

  // TSIG (RFC 8945 §4.3): an HMAC over the request plus these "TSIG
  // variables", with names in lowercase wire form. Time is seconds since 1970
  // as 48 bits; fudge = how far apart the two clocks may be (300 s).
  const keyName = encodeName(tsig.name.toLowerCase());
  const algName = encodeName(tsig.algorithm);
  const time = Buffer.alloc(6);
  const seconds = Math.floor(now / 1000);
  time.writeUInt16BE(Math.floor(seconds / 2 ** 32), 0);
  time.writeUInt32BE(seconds >>> 0, 2);
  const fudge = Buffer.from([0x01, 0x2c]); // 300
  const classTtl = Buffer.from([0x00, 0xff, 0, 0, 0, 0]); // class ANY, TTL 0
  const errorOther = Buffer.from([0, 0, 0, 0]); // error 0, no other data
  // The key's bytes: the admin's base64 secret from the check's settings.
  const keyBytes = Buffer.from(tsig.keyBase64, "base64");
  const hashName = TSIG_HASH[tsig.algorithm];
  const mac = crypto.createHmac(hashName, keyBytes).update(Buffer.concat([unsigned, keyName, classTtl, algName, time, fudge, errorOther])).digest();
  const macSize = Buffer.alloc(2);
  macSize.writeUInt16BE(mac.length, 0);
  const originalId = Buffer.alloc(2);
  originalId.writeUInt16BE(id, 0);
  const rdata = Buffer.concat([algName, time, fudge, macSize, mac, originalId, errorOther]);
  const rr = Buffer.alloc(10);
  rr.writeUInt16BE(250, 0); // TYPE TSIG
  rr.writeUInt16BE(255, 2); // class ANY
  rr.writeUInt32BE(0, 4); // TTL 0
  rr.writeUInt16BE(rdata.length, 8);
  // The signed request: same message, one additional record (the TSIG).
  const signed = Buffer.concat([unsigned, keyName, rr, rdata]);
  signed.writeUInt16BE(1, 10); // ARCOUNT
  return signed;
}

/**
 * Reads a (possibly compressed) domain name. Compression pointers (two bytes
 * starting with binary 11) point at an earlier copy of the rest of the name;
 * only backward pointers are followed, at most MAX_POINTER_HOPS of them, so a
 * crafted message can't send the parser into a loop.
 *
 * @param buf the whole DNS message
 * @param start where the name begins
 * @returns the name (lowercase, no trailing dot; "" for the root) and the
 *   offset just after it in the original position
 */
export function readName(buf: Buffer, start: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = start;
  let next = -1;
  let hops = 0;
  for (;;) {
    if (pos >= buf.length) throw new Error("DNS name runs past the end of the message");
    const len = buf.readUInt8(pos);
    if (len === 0) {
      if (next < 0) next = pos + 1;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error("Truncated DNS compression pointer");
      const target = ((len & 0x3f) << 8) | buf[pos + 1];
      if (target >= pos || ++hops > MAX_POINTER_HOPS) throw new Error("Invalid DNS compression pointer");
      if (next < 0) next = pos + 2;
      pos = target;
      continue;
    }
    if ((len & 0xc0) !== 0) throw new Error("Unsupported DNS label type");
    if (pos + 1 + len > buf.length) throw new Error("DNS label runs past the end of the message");
    labels.push(buf.toString("latin1", pos + 1, pos + 1 + len).toLowerCase());
    pos += 1 + len;
  }
  return { name: labels.join("."), next };
}

/** Formats an IPv6 address from 16 bytes, shortening the longest zero run to "::". */
function ipv6(bytes: Buffer): string {
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(bytes.readUInt16BE(i).toString(16));
  const isZero = (i: number) => groups.at(i) === "0";
  // Find the longest run of "0" groups (at least two) to replace with "::".
  let bestStart = -1;
  let bestLen = 0;
  for (let i = 0; i < 8; ) {
    if (!isZero(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && isZero(j)) j++;
    if (j - i > bestLen && j - i >= 2) {
      bestStart = i;
      bestLen = j - i;
    }
    i = j;
  }
  if (bestStart < 0) return groups.join(":");
  return `${groups.slice(0, bestStart).join(":")}::${groups.slice(bestStart + bestLen).join(":")}`;
}

/** A TXT/CAA string as zone-file text: quoted, with " and \ escaped and unprintable bytes as \DDD. */
function quoted(bytes: Buffer): string {
  let out = "";
  for (const b of bytes) out += b === 0x22 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : `\\${String(b).padStart(3, "0")}`;
  return `"${out}"`;
}

/** A name for display inside record data: absolute, with a trailing dot. */
const fqdn = (n: string) => (n ? `${n}.` : ".");

/**
 * The type list in an NSEC record (RFC 4034 §4.1.2): blocks of "window
 * number, length, bitmap", where bit N of window W means type W×256+N is
 * present at that name. A malformed block ends the list rather than failing.
 *
 * @param bytes the bitmap part of the record data
 * @returns the type names, e.g. ["A", "MX", "RRSIG", "NSEC"]
 */
export function typeBitmap(bytes: Buffer): string[] {
  const out: string[] = [];
  for (let i = 0; i + 2 <= bytes.length; ) {
    const window = bytes.readUInt8(i);
    const len = bytes.readUInt8(i + 1);
    if (len < 1 || len > 32 || i + 2 + len > bytes.length) break;
    for (let j = 0; j < len; j++) {
      const byte = bytes.readUInt8(i + 2 + j);
      // The most significant bit is the lowest type number in that byte.
      for (let bit = 0; bit < 8; bit++) if (byte & (0x80 >> bit)) out.push(typeName(window * 256 + j * 8 + bit));
    }
    i += 2 + len;
  }
  return out;
}

/**
 * SVCB / HTTPS record data (RFC 9460) as zone-file text: priority, target,
 * then each parameter ("alpn=h2,h3 port=8443 ipv4hint=192.0.2.1").
 * Parameters this check doesn't know are shown as keyNNN=hex.
 *
 * @returns the text, or null when the data is malformed (shown as hex instead)
 */
function formatSvcb(buf: Buffer, start: number, end: number): string | null {
  if (end - start < 3) return null;
  const priority = buf.readUInt16BE(start);
  const target = readName(buf, start + 2);
  const parts = [String(priority), fqdn(target.name)];
  let i = target.next;
  while (i < end) {
    if (i + 4 > end) return null;
    const key = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (i + 4 + len > end) return null;
    const v = buf.subarray(i + 4, i + 4 + len);
    // Lists inside a parameter: length-prefixed strings (alpn), fixed-size
    // addresses (hints), or 2-byte key numbers (mandatory).
    const strings = () => {
      const list: string[] = [];
      for (let k = 0; k < v.length; k += 1 + v.readUInt8(k)) list.push(v.toString("latin1", k + 1, k + 1 + v.readUInt8(k)));
      return list.join(",");
    };
    const chunks = (size: number, show: (b: Buffer) => string) => {
      const list: string[] = [];
      for (let k = 0; k + size <= v.length; k += size) list.push(show(v.subarray(k, k + size)));
      return list.join(",");
    };
    if (key === 0) parts.push(`mandatory=${chunks(2, (b) => `key${b.readUInt16BE(0)}`)}`);
    else if (key === 1) parts.push(`alpn=${strings()}`);
    else if (key === 2) parts.push("no-default-alpn");
    else if (key === 3 && len === 2) parts.push(`port=${v.readUInt16BE(0)}`);
    else if (key === 4) parts.push(`ipv4hint=${chunks(4, (b) => [...b].join("."))}`);
    else if (key === 5) parts.push(`ech=${v.toString("base64")}`);
    else if (key === 6) parts.push(`ipv6hint=${chunks(16, ipv6)}`);
    else parts.push(`key${key}=${v.toString("hex")}`);
    i += 4 + len;
  }
  return parts.join(" ");
}

/**
 * A record's data as zone-file text ("10 mail.example.com." for MX). Types
 * this check doesn't know are shown in the generic RFC 3597 form
 * ("\# 4 0a000001"), so they're still compared and recorded.
 *
 * @param buf the whole message (names inside the data may point elsewhere in it)
 * @param type the record type number
 * @param start where the data begins
 * @param length its length
 */
function formatRdata(buf: Buffer, type: number, start: number, length: number): string {
  const end = start + length;
  const data = buf.subarray(start, end);
  const name = (at: number) => readName(buf, at);
  const hex = (from: number) => data.subarray(from).toString("hex").toUpperCase();
  switch (type) {
    case 35: {
      // NAPTR: order, preference, then flags, services and regexp (three
      // length-prefixed strings), then the replacement name.
      if (length < 7) break;
      let i = 4;
      const texts: string[] = [];
      for (let k = 0; k < 3; k++) {
        if (i >= length || i + 1 + data.readUInt8(i) > length) return `\\# ${length} ${data.toString("hex")}`;
        const len = data.readUInt8(i);
        texts.push(quoted(data.subarray(i + 1, i + 1 + len)));
        i += 1 + len;
      }
      return `${data.readUInt16BE(0)} ${data.readUInt16BE(2)} ${texts.join(" ")} ${fqdn(name(start + i).name)}`;
    }
    case 43:
    case 59:
      // DS / CDS: key tag, algorithm, digest type, digest (hex).
      if (length < 5) break;
      return `${data.readUInt16BE(0)} ${data[2]} ${data[3]} ${hex(4)}`;
    case 44:
      // SSHFP: algorithm, fingerprint type, fingerprint (hex).
      if (length < 3) break;
      return `${data[0]} ${data[1]} ${hex(2)}`;
    case 48:
    case 60:
      // DNSKEY / CDNSKEY: flags, protocol, algorithm, public key (base64).
      if (length < 5) break;
      return `${data.readUInt16BE(0)} ${data[2]} ${data[3]} ${data.subarray(4).toString("base64")}`;
    case 52:
      // TLSA: usage, selector, matching type, certificate data (hex).
      if (length < 4) break;
      return `${data[0]} ${data[1]} ${data[2]} ${hex(3)}`;
    case 47: {
      // NSEC: the next name in the zone, then the list of types this name has.
      const n = name(start);
      if (n.next > end) break;
      return `${fqdn(n.name)} ${typeBitmap(buf.subarray(n.next, end)).join(" ")}`.trim();
    }
    case 256:
      // URI: priority, weight, target (the rest of the data, as text).
      if (length < 4) break;
      return `${data.readUInt16BE(0)} ${data.readUInt16BE(2)} ${quoted(data.subarray(4))}`;
    case 64:
    case 65:
      return formatSvcb(buf, start, end) ?? `\\# ${length} ${data.toString("hex")}`;
    case 13:
    case 99:
      // HINFO (CPU and OS) and SPF are strings, written like TXT.
      return formatRdata(buf, 16, start, length);
    case 1:
      if (length !== 4) break;
      return [...data].join(".");
    case 28:
      if (length !== 16) break;
      return ipv6(data);
    case 2:
    case 5:
    case 12:
    case 39:
      return fqdn(name(start).name);
    case 15:
      if (length < 3) break;
      return `${data.readUInt16BE(0)} ${fqdn(name(start + 2).name)}`;
    case 6: {
      const m = name(start);
      const r = name(m.next);
      if (r.next + 20 > end) break;
      const n = (i: number) => buf.readUInt32BE(r.next + i * 4);
      return `${fqdn(m.name)} ${fqdn(r.name)} ${n(0)} ${n(1)} ${n(2)} ${n(3)} ${n(4)}`;
    }
    case 16: {
      // One or more <length><text> strings.
      const parts: string[] = [];
      for (let i = 0; i < length; ) {
        const l = data.readUInt8(i);
        if (i + 1 + l > length) return `\\# ${length} ${data.toString("hex")}`;
        parts.push(quoted(data.subarray(i + 1, i + 1 + l)));
        i += 1 + l;
      }
      return parts.join(" ");
    }
    case 33:
      if (length < 7) break;
      return `${data.readUInt16BE(0)} ${data.readUInt16BE(2)} ${data.readUInt16BE(4)} ${fqdn(name(start + 6).name)}`;
    case 257: {
      if (length < 2 || 2 + data[1] > length) break;
      const tag = data.toString("latin1", 2, 2 + data[1]);
      return `${data[0]} ${tag} ${quoted(data.subarray(2 + data[1]))}`;
    }
  }
  return `\\# ${length} ${data.toString("hex")}`;
}

/** One record as found in the zone. Names are relative to the zone ("@" = the zone itself). */
export type ZoneRecord = { name: string; type: string; ttl: number | null; value: string };

/** Turns an absolute name into one relative to the zone ("www.example.com" → "www"). */
export function relativeName(name: string, zone: string): string {
  const z = zone.toLowerCase().replace(/\.$/, "");
  const n = name.toLowerCase().replace(/\.$/, "");
  if (n === z) return "@";
  return n.endsWith(`.${z}`) ? n.slice(0, -(z.length + 1)) : `${n}.`;
}

/**
 * Parses one DNS message of a zone transfer.
 *
 * Also used for discovery's single queries, which need the header flags
 * (AA = the answer is first-hand from the zone's own server; TC = too big
 * for UDP, ask again over TCP) and the authority section (where a parent
 * zone puts the NS records of a delegated child zone).
 *
 * @param msg the message (without its TCP length prefix)
 * @param id the query ID it must answer
 * @returns the response code, the header flags, its answer records and its
 *   authority records, with record names still absolute
 */
export function parseTransferMessage(msg: Buffer, id: number): { rcode: number; flags: number; records: WireRecord[]; authority: WireRecord[] } {
  if (msg.length < 12) throw new Error("DNS message too short");
  if (msg.readUInt16BE(0) !== id) throw new Error("DNS answer for a different query");
  const flags = msg.readUInt16BE(2);
  const rcode = flags & 0x000f;
  const qd = msg.readUInt16BE(4);
  const an = msg.readUInt16BE(6);
  const ns = msg.readUInt16BE(8);
  let pos = 12;
  // Skip the question section: a name, then type and class.
  for (let i = 0; i < qd; i++) pos = readName(msg, pos).next + 4;
  // Reads `count` resource records from `pos` onwards.
  const section = (count: number) => {
    const list: WireRecord[] = [];
    for (let i = 0; i < count; i++) {
      const { name, next } = readName(msg, pos);
      if (next + 10 > msg.length) throw new Error("DNS record header runs past the end of the message");
      const type = msg.readUInt16BE(next);
      const ttl = msg.readUInt32BE(next + 4);
      const rdlen = msg.readUInt16BE(next + 8);
      const start = next + 10;
      if (start + rdlen > msg.length) throw new Error("DNS record data runs past the end of the message");
      list.push({ name, type, ttl, value: formatRdata(msg, type, start, rdlen) });
      pos = start + rdlen;
    }
    return list;
  };
  const records = section(an);
  const authority = section(ns);
  return { rcode, flags, records, authority };
}

/** One record as it appears in a DNS message: absolute name, type number, TTL, data as text. */
type WireRecord = { name: string; type: number; ttl: number; value: string };

/** Splits "host", "host:port", "[v6]:port" or a bare IPv6 address into host and port. */
function hostPort(server: string): { host: string; port: number } {
  // "[fd00::53]:53" — the address is between the brackets, the port after "]:".
  if (server.startsWith("[")) {
    const close = server.indexOf("]");
    if (close > 0) return { host: server.slice(1, close), port: Number(server.slice(close + 2)) || 53 };
  }
  if (net.isIPv6(server)) return { host: server, port: 53 };
  const [host, port] = server.split(":");
  return { host, port: Number(port ?? 53) || 53 };
}

/**
 * Copies a zone by AXFR over TCP. The server sends the zone's SOA record,
 * every other record, and the SOA again to mark the end.
 *
 * @param zone the zone, e.g. "example.com"
 * @param server the zone's DNS server ("10.0.0.53" or "ns1.example.com:53")
 * @param timeoutMs how long the whole transfer may take
 * @param maxRecords stop (with an error) beyond this many records
 * @param tsig optional key to sign the request with
 */
export function transferZone(zone: string, server: string, timeoutMs: number, maxRecords: number, tsig?: TsigKey): Promise<ZoneRecord[]> {
  const { host, port } = hostPort(server);
  const id = crypto.randomInt(65536);
  const query = buildAxfrQuery(zone, id, tsig);
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    let buffered = Buffer.alloc(0);
    let total = 0;
    let soaCount = 0;
    const out: ZoneRecord[] = [];
    let done = false;
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(out);
    };
    const timer = setTimeout(() => finish(new Error(`Zone transfer from ${server} took longer than ${timeoutMs / 1000}s`)), timeoutMs);
    socket.once("connect", () => {
      // Over TCP every DNS message is preceded by its length (2 bytes).
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([len, query]));
    });
    socket.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_TRANSFER_BYTES) return finish(new Error("Zone transfer is larger than 64 MB — refusing to read more"));
      buffered = Buffer.concat([buffered, chunk]);
      // Take every complete message out of the buffer.
      while (buffered.length >= 2) {
        const len = buffered.readUInt16BE(0);
        if (buffered.length < 2 + len) break;
        const msg = buffered.subarray(2, 2 + len);
        buffered = buffered.subarray(2 + len);
        let parsed: ReturnType<typeof parseTransferMessage>;
        try {
          parsed = parseTransferMessage(msg, id);
        } catch (err) {
          return finish(err instanceof Error ? err : new Error(String(err)));
        }
        if (parsed.rcode !== 0) {
          const code = RCODES.at(parsed.rcode) ?? String(parsed.rcode);
          return finish(new Error(code === "NOTAUTH" ? `${server} rejected the TSIG key (NOTAUTH)` : `${server} answered ${code}${code === "REFUSED" ? " — it doesn't allow zone transfers to this address" : ""}`));
        }
        for (const r of parsed.records) {
          // The answer must start with the zone's SOA; the second SOA ends it.
          if (r.type === 6) soaCount++;
          if (out.length === 0 && r.type !== 6) return finish(new Error(`${server} didn't start the transfer with the zone's SOA record`));
          if (soaCount === 2) return finish(null);
          out.push({ name: relativeName(r.name, zone), type: typeName(r.type), ttl: r.ttl, value: r.value });
          if (out.length > maxRecords) return finish(new Error(`Zone has more than ${maxRecords} records — raise "Most records" in the check's settings`));
        }
      }
    });
    socket.once("end", () => finish(new Error(soaCount ? "Zone transfer ended early (no closing SOA record)" : `${server} closed the connection without sending the zone`)));
    socket.once("error", (err) => finish(err));
  });
}

/** The record types read for each name in "names" mode. */
const NAME_TYPES = ["A", "AAAA", "CNAME", "MX", "TXT", "NS", "SRV", "CAA"] as const;

/**
 * Reads the given names one by one, every type in NAME_TYPES (plus SOA for
 * the zone itself). Missing names/types are simply absent; TTLs aren't
 * available this way.
 *
 * @param zone the zone; "@" or "" in the list means the zone itself
 * @param names names relative to the zone ("www") or absolute ("www.example.com.")
 * @param server optional DNS server; the system resolver otherwise
 * @param timeoutMs per-query timeout
 */
async function readNames(zone: string, names: string[], server: string, timeoutMs: number): Promise<ZoneRecord[]> {
  const resolver = new dns.promises.Resolver({ timeout: timeoutMs, tries: 2 });
  if (server) resolver.setServers([server]);
  const z = zone.replace(/\.$/, "");
  const out: ZoneRecord[] = [];
  for (const raw of names) {
    const rel = raw.trim();
    // "@" = the zone; a trailing dot = already absolute; else under the zone.
    const absolute = rel === "@" || rel === "" ? z : rel.endsWith(".") ? rel.slice(0, -1) : `${rel}.${z}`;
    const name = relativeName(absolute, z);
    const types = name === "@" ? [...NAME_TYPES, "SOA" as const] : NAME_TYPES;
    for (const type of types) {
      let answers: unknown;
      try {
        answers = await resolver.resolve(absolute, type as "A");
      } catch (err) {
        // "No such name / no records of this type" is normal; anything else
        // (timeout, refused) means the server isn't answering.
        const code = (err as { code?: string }).code;
        if (code === "ENODATA" || code === "ENOTFOUND") continue;
        throw new Error(`${absolute} ${type}: ${code ?? errMsg(err)}`, { cause: err });
      }
      for (const value of answerValues(type, answers)) out.push({ name, type, ttl: null, value });
    }
  }
  return out;
}

/** node:dns answers as zone-file text, matching what a zone transfer shows. */
function answerValues(type: string, answers: unknown): string[] {
  const list = Array.isArray(answers) ? answers : [answers];
  const dot = (n: string) => (n.endsWith(".") ? n.toLowerCase() : `${n.toLowerCase()}.`);
  return list.map((a) => {
    const r = a as Record<string, unknown>;
    switch (type) {
      case "A":
      case "AAAA":
        return String(a);
      case "CNAME":
      case "NS":
        return dot(String(a));
      case "MX":
        return `${r.priority} ${dot(String(r.exchange))}`;
      case "TXT":
        // Each TXT record arrives as its list of strings.
        return (a as string[]).map((s) => quoted(Buffer.from(s, "latin1"))).join(" ");
      case "SRV":
        return `${r.priority} ${r.weight} ${r.port} ${dot(String(r.name))}`;
      case "CAA": {
        const tag = ["issue", "issuewild", "iodef", "contactemail", "contactphone"].find((t) => own(r, t) !== undefined) ?? "unknown";
        return `${r.critical ?? 0} ${tag} ${quoted(Buffer.from(String(own(r, tag) ?? ""), "utf8"))}`;
      }
      case "SOA":
        return `${dot(String(r.nsname))} ${dot(String(r.hostmaster))} ${r.serial} ${r.refresh} ${r.retry} ${r.expire} ${r.minttl}`;
      default:
        return JSON.stringify(a);
    }
  });
}

// ---- Reading a zone without a transfer ("discover") -------------------------

/**
 * Every type discovery asks for at each name it finds (SOA only at the
 * zone itself). DNSSEC's own bookkeeping records (RRSIG, NSEC, NSEC3) are
 * left out: their signatures change every few days on their own, which
 * would look like a change every time. The DNSSEC keys (DNSKEY, DS) are
 * kept — a key change is worth knowing about; "Ignore types" can drop them.
 */
const DISCOVER_TYPES = ["A", "AAAA", "CNAME", "DNAME", "MX", "TXT", "SPF", "NS", "SRV", "PTR", "NAPTR", "CAA", "TLSA", "SSHFP", "HTTPS", "SVCB", "URI", "HINFO", "LOC", "DS", "DNSKEY", "CDS", "CDNSKEY"];
/** Types never recorded by discovery (see DISCOVER_TYPES). */
const BOOKKEEPING_TYPES = new Set(["RRSIG", "NSEC", "NSEC3", "NSEC3PARAM", "OPT"]);

/**
 * Names commonly found in zones, looked up when the zone can't be listed
 * from its NSEC chain. Relative to the zone. Mail, Microsoft 365, web,
 * remote access, service (SRV) records and DKIM selectors of the big mail
 * providers. "Extra names" adds a zone's own.
 */
export const COMMON_NAMES = [
  "www", "mail", "webmail", "smtp", "imap", "pop", "pop3", "mx", "mx1", "mx2", "mail1", "mail2", "relay", "autodiscover", "autoconfig",
  "_dmarc", "_mta-sts", "mta-sts", "_smtp._tls", "_bimi", "default._bimi",
  "default._domainkey", "selector1._domainkey", "selector2._domainkey", "google._domainkey", "k1._domainkey", "k2._domainkey", "s1._domainkey", "s2._domainkey", "mail._domainkey", "dkim._domainkey", "mandrill._domainkey", "zoho._domainkey", "protonmail._domainkey", "protonmail2._domainkey", "protonmail3._domainkey", "fm1._domainkey", "fm2._domainkey", "fm3._domainkey",
  "lyncdiscover", "sip", "enterpriseenrollment", "enterpriseregistration", "msoid",
  "_autodiscover._tcp", "_sip._tls", "_sip._tcp", "_sip._udp", "_sipfederationtls._tcp", "_xmpp-client._tcp", "_xmpp-server._tcp",
  "_imap._tcp", "_imaps._tcp", "_pop3._tcp", "_pop3s._tcp", "_submission._tcp", "_submissions._tcp", "_caldav._tcp", "_caldavs._tcp", "_carddav._tcp", "_carddavs._tcp",
  "_ldap._tcp", "_kerberos._tcp", "_kerberos._udp", "_kpasswd._tcp", "_gc._tcp", "_vlmcs._tcp", "_minecraft._tcp", "_matrix._tcp", "_http._tcp", "_https._tcp",
  "ftp", "sftp", "vpn", "remote", "rdp", "gateway", "gw", "firewall", "fw", "router", "proxy", "owa", "exchange",
  "ns", "ns1", "ns2", "ns3", "ns4", "dns", "dns1", "dns2",
  "api", "app", "apps", "admin", "portal", "login", "sso", "auth", "id", "dashboard", "status", "monitor", "help", "support", "docs", "wiki", "blog", "shop", "store", "news",
  "dev", "test", "staging", "stage", "beta", "demo", "uat", "qa", "preview",
  "cdn", "static", "assets", "img", "images", "media", "files", "download", "downloads", "upload", "m", "mobile",
  "cloud", "git", "gitlab", "jenkins", "ci", "jira", "confluence", "nextcloud", "office", "intranet", "extranet", "crm", "erp", "hr", "calendar", "meet", "chat", "video",
  "db", "sql", "mysql", "backup", "nas", "share", "print", "printer", "voip", "pbx", "phone", "time", "ntp", "ldap", "ad", "dc", "dc1", "dc2", "_acme-challenge",
];

/** Where discovery sends its queries, and whether it asks for recursion. */
type QueryServer = { address: string; family: number; port: number; label: string; recursion: boolean };

/**
 * A plain DNS question for one name and type (class IN), with an EDNS0
 * record (RFC 6891) saying answers up to 4096 bytes fit in one UDP packet.
 *
 * @param name the absolute name to ask about
 * @param type the record type number
 * @param id the query ID (random, so another host can't guess it)
 * @param recursion true to set RD (for a resolver); false for the zone's own server
 */
export function buildQuery(name: string, type: number, id: number, recursion: boolean): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(recursion ? 0x0100 : 0, 2); // RD bit
  header.writeUInt16BE(1, 4); // one question
  header.writeUInt16BE(1, 10); // one additional record: the EDNS0 OPT
  const question = Buffer.alloc(4);
  question.writeUInt16BE(type, 0);
  question.writeUInt16BE(1, 2); // class IN
  // OPT: root name (0), type 41, "class" = UDP size 4096, TTL 0, no data.
  const opt = Buffer.from([0, 0, 41, 0x10, 0x00, 0, 0, 0, 0, 0, 0]);
  return Buffer.concat([header, encodeName(name), question, opt]);
}

/**
 * Sends one query over UDP and waits for its answer. The socket is
 * "connected" to the server, so the operating system drops packets from
 * any other address; answers with another query ID are ignored.
 *
 * @throws "No reply from …" after timeoutMs
 */
function udpExchange(server: QueryServer, query: Buffer, id: number, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket(server.family === 6 ? "udp6" : "udp4");
    let done = false;
    const finish = (err: Error | null, msg?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      if (err) reject(err);
      else resolve(msg!);
    };
    const timer = setTimeout(() => finish(new Error(`No reply from ${server.label} within ${timeoutMs / 1000}s`)), timeoutMs);
    socket.on("error", (err) => finish(err));
    socket.on("message", (msg) => {
      if (msg.length >= 12 && msg.readUInt16BE(0) === id) finish(null, msg);
    });
    socket.connect(server.port, server.address, () => socket.send(query, (err) => err && finish(err)));
  });
}

/**
 * Sends one query over TCP (for an answer too big for UDP) and reads one
 * length-prefixed answer, at most 64 KB (the most a DNS message can be).
 */
function tcpExchange(server: QueryServer, query: Buffer, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: server.address, port: server.port });
    let buffered = Buffer.alloc(0);
    let done = false;
    const finish = (err: Error | null, msg?: Buffer) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(msg!);
    };
    const timer = setTimeout(() => finish(new Error(`No reply from ${server.label} (TCP) within ${timeoutMs / 1000}s`)), timeoutMs);
    socket.once("connect", () => {
      const len = Buffer.alloc(2);
      len.writeUInt16BE(query.length, 0);
      socket.write(Buffer.concat([len, query]));
    });
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length > 65_537) return finish(new Error("DNS answer larger than 64 KB"));
      if (buffered.length >= 2 && buffered.length >= 2 + buffered.readUInt16BE(0)) finish(null, buffered.subarray(2, 2 + buffered.readUInt16BE(0)));
    });
    socket.once("end", () => finish(new Error(`${server.label} closed the connection without answering`)));
    socket.once("error", (err) => finish(err));
  });
}

/** One query's answer: response code, whether it's first-hand (AA), and the records for exactly that name and type. */
type Answer = { rcode: number; authoritative: boolean; records: WireRecord[]; authority: WireRecord[] };

/**
 * Asks one question: UDP (two tries), then TCP if the answer was truncated.
 *
 * @param server where to ask
 * @param name the absolute name
 * @param type the type number
 * @param timeoutMs per attempt
 */
async function ask(server: QueryServer, name: string, type: number, timeoutMs: number): Promise<Answer> {
  const id = crypto.randomInt(65536);
  const query = buildQuery(name, type, id, server.recursion);
  let msg: Buffer | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 2 && !msg; attempt++) {
    try {
      msg = await udpExchange(server, query, id, timeoutMs);
    } catch (err) {
      lastError = err;
    }
  }
  if (!msg) throw lastError instanceof Error ? lastError : new Error(String(lastError));
  // TC flag (0x0200): the answer didn't fit; the whole thing comes over TCP.
  if (msg.readUInt16BE(2) & 0x0200) msg = await tcpExchange(server, query, timeoutMs);
  const parsed = parseTransferMessage(msg, id);
  return { rcode: parsed.rcode, authoritative: Boolean(parsed.flags & 0x0400), records: parsed.records, authority: parsed.authority };
}

/**
 * Picks where discovery asks. A configured server is asked with recursion
 * on (it may be the zone's own server or a resolver). With none, the zone's
 * own name servers (its NS records, looked up through the system resolver)
 * are asked directly, so answers are first-hand and carry the zone's real
 * TTLs; if that fails, the system resolver is used.
 *
 * @param zone the zone
 * @param server the "DNS server" setting ("" = find it)
 * @param timeoutMs per lookup
 */
async function pickServer(zone: string, server: string, timeoutMs: number): Promise<QueryServer> {
  if (server) {
    const { host, port } = hostPort(server);
    const found = await dns.promises.lookup(host);
    return { address: found.address, family: found.family, port, label: server, recursion: true };
  }
  try {
    const resolver = new dns.promises.Resolver({ timeout: Math.min(timeoutMs, 10_000), tries: 2 });
    for (const ns of (await resolver.resolveNs(zone)).sort()) {
      try {
        const found = await dns.promises.lookup(ns);
        return { address: found.address, family: found.family, port: 53, label: ns, recursion: false };
      } catch {
        // That name server's own address doesn't resolve; try the next one.
      }
    }
  } catch {
    // No NS records found; fall back to the system resolver below.
  }
  const [first] = dns.getServers();
  if (!first) throw new Error("No DNS server is configured on this machine — set the check's DNS server");
  const { host, port } = hostPort(first);
  return { address: host, family: net.isIPv6(host) ? 6 : 4, port, label: `${host} (system resolver)`, recursion: true };
}

/** What discovery found, and how. */
export type Discovery = {
  records: ZoneRecord[];
  // The server asked.
  server: string;
  // true when the NSEC chain listed every name (the inventory is complete).
  walked: boolean;
  // Names that exist (had a record or an answer) / names asked about.
  names: number;
  asked: number;
  // true when the zone answers for any name (a "*" wildcard).
  wildcard: boolean;
};

/** Absolute form of a name relative to the zone ("@" → the zone, "www" → www.zone, "x." → x). */
function absoluteName(rel: string, zone: string): string {
  if (rel === "@" || rel === "") return zone;
  return rel.endsWith(".") ? rel.slice(0, -1).toLowerCase() : `${rel.toLowerCase()}.${zone}`;
}

/** Whether an absolute name is the zone or inside it. */
const inZone = (name: string, zone: string) => name === zone || name.endsWith(`.${zone}`);

/**
 * Reads a whole zone without a zone transfer (see the file header).
 *
 * @param zone the zone, lowercase, no trailing dot
 * @param opts server ("" = the zone's own), extra names, whether to try
 *   COMMON_NAMES, per-query timeout, the most names/records to read
 * @throws when the server doesn't answer, refuses, or the zone has no SOA
 */
export async function discoverZone(zone: string, opts: { server: string; extraNames: string[]; commonNames: boolean; timeoutMs: number; maxRecords: number }): Promise<Discovery> {
  const timeoutMs = Math.min(opts.timeoutMs, 10_000);
  const server = await pickServer(zone, opts.server, timeoutMs);
  const deadline = Date.now() + 5 * 60_000;
  let asked = 0;
  // One question, counted and bounded by the overall deadline.
  const query = async (name: string, type: number) => {
    if (Date.now() > deadline) throw new Error("Reading the zone took longer than 5 minutes — turn off common names or list fewer extra names");
    asked++;
    const answer = await ask(server, name, type, timeoutMs);
    // Anything but "no error" and "no such name" means the server isn't
    // answering properly (REFUSED: it doesn't serve this zone to us).
    if (answer.rcode !== 0 && answer.rcode !== 3) throw new Error(`${server.label} answered ${RCODES.at(answer.rcode) ?? answer.rcode} for ${name} ${typeName(type)}`);
    return answer;
  };

  // The zone must exist and have its SOA record.
  const apex = await query(zone, 6);
  if (apex.rcode === 3) throw new Error(`${server.label} says ${zone} doesn't exist (NXDOMAIN)`);
  if (!apex.records.some((r) => r.type === 6 && r.name === zone)) throw new Error(`${zone} isn't a zone on ${server.label} (no SOA record for it) — check the zone name`);

  // 1. Follow the NSEC chain, if the zone has one: each name's NSEC record
  //    gives the next name and the types it has. It's complete only if it
  //    comes back round to the zone; servers that make NSEC records up on
  //    the fly ("\000.name" next names) or use NSEC3 can't be walked.
  const typesAt = new Map<string, string[] | null>();
  let walked = false;
  let current = zone;
  for (;;) {
    const answer = await query(current, 47);
    const nsec = answer.records.find((r) => r.type === 47 && r.name === current);
    if (!nsec) break;
    const [nextText, ...types] = nsec.value.split(" ");
    typesAt.set(current, types);
    const next = nextText.replace(/\.$/, "");
    // A first label of a single zero byte is a made-up "next" name.
    if (!inZone(next, zone) || next.split(".")[0] === "\u0000") break;
    if (next === zone) {
      walked = true;
      break;
    }
    if (typesAt.has(next)) break;
    if (typesAt.size > opts.maxRecords) throw new Error(`Zone has more than ${opts.maxRecords} names — raise "Most records" in the check's settings`);
    current = next;
  }

  // 2. The names to read. A complete walk already has every name; otherwise
  //    the zone itself, the extra names, the common names and whatever the
  //    walk did find. "guessed" names are dropped if they only match a wildcard.
  type Item = { name: string; guessed: boolean };
  const queue: Item[] = [];
  const queued = new Set<string>();
  const enqueue = (name: string, guessed: boolean) => {
    if (queued.has(name) || !inZone(name, zone)) return;
    if (queued.size >= opts.maxRecords) throw new Error(`Found more than ${opts.maxRecords} names — raise "Most records" in the check's settings`);
    queued.add(name);
    queue.push({ name, guessed });
  };
  enqueue(zone, false);
  for (const name of typesAt.keys()) enqueue(name, false);
  if (!walked) {
    for (const rel of opts.extraNames) enqueue(absoluteName(rel.trim(), zone), false);
    if (opts.commonNames) for (const rel of COMMON_NAMES) enqueue(absoluteName(rel, zone), true);
  }

  // 3. A wildcard ("*" record) makes every made-up name exist. Ask about a
  //    random name: if it exists, its answers are the wildcard's, recorded
  //    once as "*", and guessed names that answer exactly the same are just
  //    the wildcard, not names of their own.
  let wildcardSignature: string | null = null;
  let wildcardTypes: string[] = [];
  const out: ZoneRecord[] = [];
  let existing = 0;

  /**
   * Reads every type at one name. Returns its records (relative names), or
   * null if the name doesn't exist. Learns in-zone names its records point at.
   */
  const readOne = async (name: string, known: string[] | null, exact = false): Promise<ZoneRecord[] | null> => {
    let types = known ? known.filter((t) => !BOOKKEEPING_TYPES.has(t)) : name === zone ? ["SOA", ...DISCOVER_TYPES] : DISCOVER_TYPES;
    // exact: ask only for the given types, nothing else (the wildcard comparison).
    if (exact) types = known ?? [];
    else if (!known) {
      // One question first: "no such name" (NXDOMAIN) means no records of
      // any type, so the other ~20 questions are skipped.
      const first = await query(name, 1);
      if (first.rcode === 3) return null;
    }
    // A name with a CNAME can't have other records (except DNSSEC's), so
    // only the CNAME is read there.
    if (!known && !exact) {
      const cname = await query(name, 5);
      if (cname.records.some((r) => r.type === 5 && r.name === name)) types = ["CNAME"];
    }
    const found: ZoneRecord[] = [];
    for (const t of types) {
      const num = typeNumber(t);
      if (num == null) continue;
      const answer = await query(name, num);
      // Only records for exactly this name and type: a resolver also sends
      // the CNAME chain and other helpful extras, which belong elsewhere.
      // A delegated child zone's NS records come back as a referral, in the
      // authority section.
      const records = [...answer.records, ...(num === 2 && name !== zone ? answer.authority : [])].filter((r) => r.type === num && r.name === name);
      for (const r of records) {
        found.push({ name: relativeName(name, zone), type: t, ttl: answer.authoritative ? r.ttl : null, value: r.value });
        // Names inside the zone that this record points at (mail servers,
        // aliases, service hosts) are read too.
        if (!walked) {
          const target = pointsAt(t, r.value);
          if (target) enqueue(target, false);
        }
      }
    }
    return found;
  };

  if (!walked && opts.commonNames) {
    const probe = `looksee-${crypto.randomBytes(6).toString("hex")}.${zone}`;
    const answers = await readOne(probe, null);
    if (answers?.length) {
      wildcardSignature = signature(answers);
      wildcardTypes = [...new Set(answers.map((r) => r.type))];
      for (const r of answers) out.push({ ...r, name: "*" });
    }
  }

  // 4. Read the names, eight at a time. Records found can add more names
  //    to the queue, so the workers run until the queue is really empty.
  //    The first error stops every worker (no more queries are sent).
  let next = 0;
  let failure: unknown = null;
  const worker = async () => {
    while (next < queue.length && !failure) {
      const item = queue[next++];
      try {
        // With a wildcard, every guessed name "exists". Asking only for the
        // wildcard's own types first (one or two questions, not ~25) shows
        // whether it's just the wildcard answering; only a name that answers
        // differently is read in full.
        if (item.guessed && wildcardSignature) {
          const quick = await readOne(item.name, wildcardTypes, true);
          if (quick && signature(quick) === wildcardSignature) continue;
        }
        const records = await readOne(item.name, typesAt.get(item.name) ?? null);
        if (!records) continue;
        if (item.guessed && wildcardSignature && signature(records) === wildcardSignature) continue;
        existing++;
        out.push(...records);
        if (out.length > opts.maxRecords) throw new Error(`Zone has more than ${opts.maxRecords} records — raise "Most records" in the check's settings`);
      } catch (err) {
        failure ??= err;
      }
    }
  };
  while (next < queue.length && !failure) await Promise.all(Array.from({ length: 8 }, worker));
  if (failure) throw failure instanceof Error ? failure : new Error(String(failure));

  return { records: out, server: server.label, walked, names: existing, asked, wildcard: wildcardSignature != null };
}

/** A name's records as one comparable string (type and value, sorted), to spot wildcard answers. */
const signature = (records: ZoneRecord[]) => records.map((r) => `${r.type}\t${r.value}`).sort().join("\n");

/**
 * The name a record points at, for the types that point somewhere: CNAME
 * and DNAME targets, NS and MX hosts, SRV and SVCB/HTTPS targets, PTR.
 *
 * @param type the record type
 * @param value its data as zone-file text ("10 mail.example.com.")
 * @returns the absolute name without its trailing dot, or null
 */
function pointsAt(type: string, value: string): string | null {
  const parts = value.split(" ");
  // Which word of the data is the name: the first for CNAME/DNAME/NS/PTR,
  // the second for MX ("10 host.") and SVCB/HTTPS ("1 host. alpn=…"),
  // the fourth for SRV ("0 5 443 host.").
  const at: Record<string, number> = { CNAME: 0, DNAME: 0, NS: 0, PTR: 0, MX: 1, SVCB: 1, HTTPS: 1, SRV: 3 };
  const index = own(at, type);
  if (index === undefined) return null;
  const word = parts.at(index);
  return word && word !== "." ? word.replace(/\.$/, "").toLowerCase() : null;
}

// ---- Comparing runs ----------------------------------------------------------

/** One change between two inventories of the zone. */
export type ZoneChange = { change: "added" | "removed" | "changed" | "ttl"; name: string; type: string; value: string; previous?: string };

/** A record's identity for comparing runs: name, type and data (not TTL). */
const keyOf = (r: { name: string; type: string; value: string }) => `${r.name}\t${r.type}\t${r.value}`;

/**
 * Compares two inventories. A name+type whose single value was replaced by a
 * single new value is reported as one "changed" (with the previous value)
 * rather than a removal plus an addition; TTL-only changes are reported only
 * when asked for.
 *
 * @param prev the previous run's records: identity key → TTL
 * @param records this run's records
 * @param watchTtl true to report TTL changes too
 */
export function diffZone(prev: Record<string, number | null>, records: ZoneRecord[], watchTtl: boolean): ZoneChange[] {
  const current = new Map(records.map((r) => [keyOf(r), r]));
  const parse = (key: string) => {
    const [name, type, ...rest] = key.split("\t");
    return { name, type, value: rest.join("\t") };
  };
  const added = [...current.entries()].filter(([k]) => !Object.hasOwn(prev, k)).map(([, r]) => r);
  const removed = Object.keys(prev).filter((k) => !current.has(k)).map(parse);
  const changes: ZoneChange[] = [];
  // Pair up a single removal and a single addition of the same name and type.
  const groupKey = (r: { name: string; type: string }) => `${r.name}\t${r.type}`;
  const removedBy = new Map<string, typeof removed>();
  for (const r of removed) removedBy.set(groupKey(r), [...(removedBy.get(groupKey(r)) ?? []), r]);
  const addedBy = new Map<string, ZoneRecord[]>();
  for (const r of added) addedBy.set(groupKey(r), [...(addedBy.get(groupKey(r)) ?? []), r]);
  for (const [g, adds] of addedBy) {
    const rems = removedBy.get(g) ?? [];
    if (adds.length === 1 && rems.length === 1) {
      changes.push({ change: "changed", name: adds[0].name, type: adds[0].type, value: adds[0].value, previous: rems[0].value });
      removedBy.delete(g);
    } else {
      for (const r of adds) changes.push({ change: "added", name: r.name, type: r.type, value: r.value });
    }
  }
  for (const rems of removedBy.values()) for (const r of rems) changes.push({ change: "removed", ...r });
  if (watchTtl) {
    for (const [k, r] of current) {
      const before = own(prev, k);
      if (before !== undefined && before !== null && r.ttl !== null && before !== r.ttl) changes.push({ change: "ttl", name: r.name, type: r.type, value: `${r.value} (TTL ${before} → ${r.ttl})` });
    }
  }
  return changes.sort((a, b) => a.name.localeCompare(b.name) || a.type.localeCompare(b.type));
}

/** One history entry as kept in the check's state and shown on its page. */
type HistoryRow = { when: string; change: string; name: string; type: string; value: string; previous?: string; note?: string };

/** How a change reads in a message: "added www A 192.0.2.1". */
const describe = (c: ZoneChange) => `${c.change} ${c.name} ${c.type} ${c.change === "changed" ? `${c.previous} → ${c.value}` : c.value}`;

/**
 * Brings a record key saved by an older version up to how this version
 * shows it, so upgrading isn't reported as a zone change. Older versions
 * showed some types only by number ("TYPE44") and some data only as hex
 * ("\# 22 01…"); where this version has a name and a readable form for it,
 * the key is rewritten (the hex is decoded the way an answer would be).
 *
 * @param key "name<TAB>type<TAB>value"
 * @returns the key as this version would write it
 */
export function currentKey(key: string): string {
  const [name, type, ...rest] = key.split("\t");
  const value = rest.join("\t");
  const num = typeNumber(type);
  if (num == null) return key;
  let shown = value;
  // The generic form: "\#", the data length, the data as hex — e.g. "\# 4 0a000001".
  const generic = /^\\# (\d+) ([0-9a-f]*)$/.exec(value);
  if (generic) {
    try {
      const data = Buffer.from(generic[2], "hex");
      shown = formatRdata(data, num, 0, data.length);
    } catch {
      // Not decodable on its own; keep the hex.
    }
  }
  return `${name}\t${typeName(num)}\t${shown}`;
}

/** A saved snapshot (key → TTL) with every key brought up to date (currentKey). */
const upgradeSnapshot = (snapshot: Record<string, number | null>) => Object.fromEntries(Object.entries(snapshot).map(([k, ttl]) => [currentKey(k), ttl]));

/** One difference from the baseline, with when it was first seen and for how many runs in a row. */
export type PendingChange = ZoneChange & { since: string; runs: number };

/** A difference's identity, so the same difference is recognised run after run. */
const changeKey = (c: ZoneChange) => [c.change, c.name, c.type, c.value, c.previous ?? ""].join("\t");

/**
 * Applies one accepted difference to the baseline: an added record joins
 * it, a removed one leaves it, a changed one swaps its old value for the
 * new, a TTL change records the new TTL.
 *
 * @param baseline the baseline (key → TTL), changed in place — a Map, so a
 *   key made of record text from the network can never touch an object's
 *   built-in properties (such as "__proto__")
 * @param c the difference
 * @param current this run's records by key, for their TTLs
 */
function applyChange(baseline: Map<string, number | null>, c: ZoneChange, current: Map<string, ZoneRecord>) {
  // A TTL change's value reads "<data> (TTL 300 → 60)"; the record's data is
  // the part before " (TTL" — this regex removes that ending.
  const value = c.change === "ttl" ? c.value.replace(/ \(TTL \d+ → \d+\)$/, "") : c.value;
  const key = keyOf({ name: c.name, type: c.type, value });
  if (c.change === "removed") {
    baseline.delete(key);
    return;
  }
  if (c.change === "changed" && c.previous !== undefined) baseline.delete(keyOf({ name: c.name, type: c.type, value: c.previous }));
  baseline.set(key, current.get(key)?.ttl ?? null);
}

/**
 * The "pinned" comparison: this run's records against a saved baseline.
 *
 * @param baseline the saved baseline (key → TTL)
 * @param pending the differences being tracked, by changeKey
 * @param records this run's (watched) records
 * @param opts watchTtl; acceptAfterRuns (0 = only when accepted by hand);
 *   accept = true when the check was marked recovered since the last run
 *   (take this run's records as the new baseline); now (ISO time)
 * @returns the new baseline and tracked differences, the differences still
 *   outstanding, the ones seen for the first time, the ones accepted this
 *   run, and the ones that went away by themselves
 */
export function trackAgainstBaseline(
  baseline: Record<string, number | null>,
  pending: Record<string, PendingChange>,
  records: ZoneRecord[],
  opts: { watchTtl: boolean; acceptAfterRuns: number; accept: boolean; now: string }
): { baseline: Record<string, number | null>; pending: Record<string, PendingChange>; outstanding: PendingChange[]; fresh: ZoneChange[]; accepted: ZoneChange[]; reverted: PendingChange[] } {
  const current = new Map(records.map((r) => [keyOf(r), r]));
  const diffs = diffZone(baseline, records, opts.watchTtl);
  // Marked recovered: everything as it is now becomes the baseline.
  if (opts.accept) {
    const fresh = Object.fromEntries([...current].map(([k, r]) => [k, r.ttl]));
    return { baseline: fresh, pending: {}, outstanding: [], fresh: [], accepted: diffs, reverted: [] };
  }
  // Maps while working (keys are record text from the network); plain
  // objects again for the stored state.
  const nextBaseline = new Map(Object.entries(baseline));
  const nextPending = new Map<string, PendingChange>();
  const fresh: ZoneChange[] = [];
  const accepted: ZoneChange[] = [];
  for (const d of diffs) {
    const k = changeKey(d);
    const before = own(pending, k);
    if (!before) fresh.push(d);
    const tracked: PendingChange = { ...d, since: before?.since ?? opts.now, runs: (before?.runs ?? 0) + 1 };
    // Seen for enough runs in a row: it's the new normal.
    if (opts.acceptAfterRuns > 0 && tracked.runs >= opts.acceptAfterRuns) {
      applyChange(nextBaseline, d, current);
      accepted.push(d);
    } else {
      nextPending.set(k, tracked);
    }
  }
  // Tracked differences that are gone: the zone went back to the baseline.
  const reverted = Object.entries(pending)
    .filter(([k]) => !nextPending.has(k) && !diffs.some((d) => changeKey(d) === k))
    .map(([, p]) => p);
  return { baseline: Object.fromEntries(nextBaseline), pending: Object.fromEntries(nextPending), outstanding: [...nextPending.values()], fresh, accepted, reverted };
}

/** The field order of each table in the result details (the check page shows them in this order). */
const DETAIL_COLUMNS = {
  changes: ["change", "name", "type", "value", "previous", "since", "runs"],
  history: ["when", "change", "name", "type", "value", "previous", "note"],
  records: ["name", "type", "ttl", "value"],
};

/** Parses the "TSIG key" settings into a key, or null when not set. */
function tsigFrom(config: Config): TsigKey | null | { error: string } {
  const name = str(config, "tsigName");
  const secret = str(config, "tsigSecret");
  if (!name && !secret) return null;
  if (!name || !secret) return { error: "Both the TSIG key name and secret are needed" };
  const algorithm = str(config, "tsigAlgorithm", "hmac-sha256") as TsigKey["algorithm"];
  if (!Object.hasOwn(TSIG_HASH, algorithm)) return { error: `Unsupported TSIG algorithm: ${algorithm}` };
  // A base64 secret: letters, digits, + / and up to two = at the end.
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(secret)) return { error: "The TSIG secret must be base64 (as in the key file's secret line)" };
  return { name, algorithm, keyBase64: secret };
}

/**
 * The dns_zone check: reads the zone, compares it (with the previous run or
 * with the pinned baseline — see the file header), and reports what changed.
 *
 * Status, "each_run": the chosen severity (warn by default) when records
 * changed, held for holdMinutes so a normal "2 failures in a row" alert rule
 * still sees it (marking the check recovered ends the hold); up otherwise.
 * Status, "pinned": the chosen severity while any difference from the
 * baseline is outstanding; up once they're all accepted or reverted.
 * The first run only records a baseline. Value: the number of records.
 * Details: the outstanding (or this run's) changes, the history, and the
 * current records — the check page shows each as its own table.
 *
 * @param config zone, mode (axfr | discover | names), server, names,
 *   extraNames, commonNames, TSIG settings, ignoreNames, ignoreTypes,
 *   watchTtl, watchSoa, severity, baseline (each_run | pinned),
 *   acceptAfterRuns, holdMinutes, maxRecords, timeoutSeconds
 * @param ctx the check's previous state: records or baseline + pending,
 *   history, changedAt, and resolvedAt when it was marked recovered since
 */
export async function probeDnsZone(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const zone = str(config, "zone").trim().replace(/\.$/, "").toLowerCase();
  if (!zone) return warn("Missing zone name");
  const mode = str(config, "mode", "axfr");
  const server = str(config, "server").trim();
  const timeoutMs = Math.min(300, Math.max(1, numOr(config, "timeoutSeconds", 30))) * 1000;
  const maxRecords = Math.min(100_000, Math.max(1, numOr(config, "maxRecords", 5000)));
  const tsig = tsigFrom(config);
  if (tsig && "error" in tsig) return warn(tsig.error);

  // Read the zone.
  const start = Date.now();
  let records: ZoneRecord[];
  // How the zone was read, for the message ("walked the NSEC chain").
  let how = "";
  try {
    if (mode === "names") {
      const names = excludeItems(config.names);
      if (!names.length) return warn('List the names to read (one per line; "@" is the zone itself)');
      records = await readNames(zone, names, server, Math.min(timeoutMs, 30_000));
    } else if (mode === "discover") {
      const found = await discoverZone(zone, { server, extraNames: excludeItems(config.extraNames), commonNames: bool(config, "commonNames", true), timeoutMs, maxRecords });
      records = found.records;
      how = found.walked
        ? ` · every name, from the NSEC chain, via ${found.server}`
        : ` · ${found.names} name(s) found of ${found.asked} looked up${found.wildcard ? ", wildcard present" : ""}, via ${found.server}`;
    } else {
      if (!server) return warn("A zone transfer needs the zone's DNS server address");
      records = await transferZone(zone, server, timeoutMs, maxRecords, tsig ?? undefined);
    }
  } catch (err) {
    return down(`Couldn't read zone ${zone}: ${errMsg(err)}`, { latencyMs: Date.now() - start });
  }
  const latencyMs = Date.now() - start;

  // Leave out what isn't watched: ignored names (wildcards allowed, e.g.
  // _acme-challenge* for certificate renewals), ignored types and, unless
  // asked for, the SOA record — its serial changes with every edit, so it
  // would show up as a change every time anything else changes.
  const ignored = excludeItems(config.ignoreNames, true);
  const ignoredTypes = new Set(excludeItems(config.ignoreTypes, true).map((t) => t.toUpperCase()));
  const soa = records.find((r) => r.type === "SOA");
  const serial = soa?.value.split(" ")[2];
  const watched = records.filter((r) => (bool(config, "watchSoa") || r.type !== "SOA") && !ignoredTypes.has(r.type) && !nameExcluded(r.name, ignored));
  const snapshot: Record<string, number | null> = {};
  for (const r of watched) snapshot[keyOf(r)] = r.ttl;

  const now = new Date().toISOString();
  const oldHistory = Array.isArray(ctx.state.history) ? (ctx.state.history as HistoryRow[]) : [];
  const severity = str(config, "severity", "warn") === "down" ? "down" : "warn";
  // Set by "Mark recovered" (alerting.ts resolveCheck) since the last run;
  // this run's state doesn't carry it on, so it's acted on once.
  const recovered = typeof ctx.state.resolvedAt === "string";
  const recordsTable = watched.slice(0, 2000).map((r) => ({ name: r.name, type: r.type, ttl: r.ttl, value: r.value }));
  const summary = `${watched.length} record(s)${serial ? `, serial ${serial}` : ""}${how}`;

  // ---- "pinned": compare with the saved baseline ----
  if (str(config, "baseline", "each_run") === "pinned") {
    // A check switched from "each_run" starts from its last inventory.
    const saved = (ctx.state.baseline ?? ctx.state.records) as Record<string, number | null> | undefined;
    if (!saved) {
      const state = { baseline: snapshot, pending: {}, history: oldHistory, serial, baselineAt: now };
      return { status: "up", latencyMs, value: watched.length, message: `Baseline recorded: ${summary}`, details: { records: recordsTable }, state };
    }
    const pending = (ctx.state.pending ?? {}) as Record<string, PendingChange>;
    const acceptAfterRuns = Math.max(0, Math.floor(numOr(config, "acceptAfterRuns", 0)));
    const t = trackAgainstBaseline(upgradeSnapshot(saved), pending, watched, { watchTtl: bool(config, "watchTtl"), acceptAfterRuns, accept: recovered, now });
    const rows: HistoryRow[] = [
      ...t.fresh.map((c) => ({ when: now, ...c })),
      ...t.accepted.map((c) => ({ when: now, ...c, change: "accepted", note: `${c.change}${recovered ? " — accepted when marked recovered" : ` — seen for ${acceptAfterRuns} run(s)`}` })),
      ...t.reverted.map((p) => ({ when: now, change: "reverted", name: p.name, type: p.type, value: p.value, previous: p.previous, note: `${p.change} — went back to the baseline by itself` })),
    ];
    const history = [...rows, ...oldHistory].slice(0, 500);
    const state = { baseline: t.baseline, pending: t.pending, history, serial, baselineAt: recovered || t.accepted.length ? now : (ctx.state.baselineAt ?? now) };
    // Outstanding differences, oldest first, with when each was first seen.
    const outstanding = t.outstanding.sort((a, b) => a.since.localeCompare(b.since) || a.name.localeCompare(b.name));
    const details = {
      columns: DETAIL_COLUMNS,
      changes: outstanding.map((p) => ({ change: p.change, name: p.name, type: p.type, value: p.value, previous: p.previous ?? null, since: p.since, runs: p.runs })),
      history: history.slice(0, 200),
      records: recordsTable,
    };
    if (outstanding.length) {
      const freshNote = t.fresh.length ? ` (${t.fresh.length} new this run)` : "";
      const accept = acceptAfterRuns > 0 ? `; accepted after ${acceptAfterRuns} run(s) or when marked recovered` : "; mark the check recovered to accept them";
      const list = outstanding.slice(0, 3).map(describe).join("; ");
      return { status: severity, latencyMs, value: watched.length, message: `${outstanding.length} change(s) from the baseline${freshNote}: ${list}${outstanding.length > 3 ? "; …" : ""}${accept}`, details, state };
    }
    if (recovered) return { status: "up", latencyMs, value: watched.length, message: `Baseline updated (marked recovered): ${summary}`, details, state };
    if (t.accepted.length) return { status: "up", latencyMs, value: watched.length, message: `${t.accepted.length} change(s) accepted into the baseline after ${acceptAfterRuns} run(s): ${summary}`, details, state };
    return { status: "up", latencyMs, value: watched.length, message: `Matches the baseline — ${summary}`, details, state };
  }

  // ---- "each_run": compare with the previous run ----
  const prevSaved = ctx.state.records as Record<string, number | null> | undefined;
  const prev = prevSaved ? upgradeSnapshot(prevSaved) : undefined;
  const changes = prev ? diffZone(prev, watched, bool(config, "watchTtl")) : [];
  const history: HistoryRow[] = [...changes.map((c) => ({ when: now, ...c })), ...oldHistory].slice(0, 500);
  // Marking the check recovered ends the hold on an earlier change.
  const changedAt = changes.length ? Date.now() : recovered ? undefined : (ctx.state.changedAt as number | undefined);
  const lastChange = changes.length ? `${changes.length} change(s): ${changes.slice(0, 3).map(describe).join("; ")}${changes.length > 3 ? "; …" : ""}` : (ctx.state.lastChange as string | undefined);
  const state = { records: snapshot, history, changedAt, lastChange, serial };

  const holdMs = numOr(config, "holdMinutes", 60) * 60_000;
  const recent = changedAt && Date.now() - changedAt < holdMs;
  const details = {
    columns: DETAIL_COLUMNS,
    changes,
    history: history.slice(0, 200),
    records: recordsTable,
  };
  if (!prev) return { status: "up", latencyMs, value: watched.length, message: `Baseline recorded: ${summary}`, details, state };
  if (changes.length) return { status: severity, latencyMs, value: watched.length, message: lastChange ?? "Zone changed", details, state };
  if (recent) return { status: severity, latencyMs, value: watched.length, message: `${lastChange} (${Math.round((Date.now() - changedAt) / 60_000)} min ago)`, details, state };
  return { status: "up", latencyMs, value: watched.length, message: `No changes — ${summary}`, details, state };
}
