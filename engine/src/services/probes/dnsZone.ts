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
// Two ways to read the zone:
// - "axfr" (zone transfer): asks the zone's DNS server for the whole zone in
//   one TCP conversation (RFC 5936). Complete, but the server must allow
//   transfers to Looksee's address (BIND allow-transfer, Windows DNS "Zone
//   Transfers" tab), optionally authenticated with a TSIG key (RFC 8945).
// - "names": asks for a list of names one by one (A, AAAA, CNAME, MX, TXT,
//   NS, SRV, CAA). Works against any server, including public ones that
//   refuse transfers, but only sees the names listed.
//
// Security: everything read from the network is untrusted. The DNS message
// parser checks every length and offset against the buffer, only follows
// name-compression pointers that point backwards (so a crafted answer can't
// loop forever), and caps the total size and record count. The TSIG secret
// is a write-only check setting (lib/secrets.ts) and is never logged or put
// in a result. Responses' own TSIG signatures aren't verified — the key
// proves Looksee to the server, not the other way round — so a transfer
// over an untrusted network could in principle be tampered with in transit.

import crypto from "node:crypto";
import dns from "node:dns";
import net from "node:net";
import { type Config, type ProbeContext, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { excludeItems, nameExcluded } from "./exclude.js";
import { own } from "../../lib/own.js";

// ---- Wire format -----------------------------------------------------------

/** DNS record type numbers this check knows by name (others show as TYPEnnn). */
const TYPE_NAMES: Record<number, string> = { 1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 39: "DNAME", 43: "DS", 48: "DNSKEY", 257: "CAA" };
const typeName = (n: number) => own(TYPE_NAMES, n) ?? `TYPE${n}`;

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
  switch (type) {
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
 * @param msg the message (without its TCP length prefix)
 * @param id the query ID it must answer
 * @returns its answer records, with record names still absolute
 */
export function parseTransferMessage(msg: Buffer, id: number): { rcode: number; records: { name: string; type: number; ttl: number; value: string }[] } {
  if (msg.length < 12) throw new Error("DNS message too short");
  if (msg.readUInt16BE(0) !== id) throw new Error("DNS answer for a different query");
  const rcode = msg.readUInt16BE(2) & 0x000f;
  const qd = msg.readUInt16BE(4);
  const an = msg.readUInt16BE(6);
  let pos = 12;
  // Skip the question section: a name, then type and class.
  for (let i = 0; i < qd; i++) pos = readName(msg, pos).next + 4;
  const records: { name: string; type: number; ttl: number; value: string }[] = [];
  for (let i = 0; i < an; i++) {
    const { name, next } = readName(msg, pos);
    if (next + 10 > msg.length) throw new Error("DNS record header runs past the end of the message");
    const type = msg.readUInt16BE(next);
    const ttl = msg.readUInt32BE(next + 4);
    const rdlen = msg.readUInt16BE(next + 8);
    const start = next + 10;
    if (start + rdlen > msg.length) throw new Error("DNS record data runs past the end of the message");
    records.push({ name, type, ttl, value: formatRdata(msg, type, start, rdlen) });
    pos = start + rdlen;
  }
  return { rcode, records };
}

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
type HistoryRow = { when: string; change: string; name: string; type: string; value: string; previous?: string };

/** How a change reads in a message: "added www A 192.0.2.1". */
const describe = (c: ZoneChange) => `${c.change} ${c.name} ${c.type} ${c.change === "changed" ? `${c.previous} → ${c.value}` : c.value}`;

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
 * The dns_zone check: reads the zone, compares it with the previous run, and
 * reports what changed.
 *
 * Status: the chosen severity (warn by default) when records changed, held
 * for holdMinutes so a normal "2 failures in a row" alert rule still sees
 * it; up otherwise. The first run only records a baseline. Value: the number
 * of records. Details: this run's changes, the recent history and the
 * current records (the check page shows the first of those that isn't empty).
 *
 * @param config zone, mode (axfr | names), server, names, TSIG settings,
 *   ignoreNames, watchTtl, watchSoa, severity, holdMinutes, maxRecords,
 *   timeoutSeconds
 * @param ctx the check's previous state: records, history, changedAt
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
  try {
    if (mode === "names") {
      const names = excludeItems(config.names);
      if (!names.length) return warn('List the names to read (one per line; "@" is the zone itself)');
      records = await readNames(zone, names, server, Math.min(timeoutMs, 30_000));
    } else {
      if (!server) return warn("A zone transfer needs the zone's DNS server address");
      records = await transferZone(zone, server, timeoutMs, maxRecords, tsig ?? undefined);
    }
  } catch (err) {
    return down(`Couldn't read zone ${zone}: ${errMsg(err)}`, { latencyMs: Date.now() - start });
  }
  const latencyMs = Date.now() - start;

  // Leave out what isn't watched: ignored names (wildcards allowed, e.g.
  // _acme-challenge* for certificate renewals) and, unless asked for, the
  // SOA record — its serial changes with every edit, so it would show up as
  // a change every time anything else changes.
  const ignored = excludeItems(config.ignoreNames, true);
  const soa = records.find((r) => r.type === "SOA");
  const serial = soa?.value.split(" ")[2];
  const watched = records.filter((r) => (bool(config, "watchSoa") || r.type !== "SOA") && !nameExcluded(r.name, ignored));
  const snapshot: Record<string, number | null> = {};
  for (const r of watched) snapshot[keyOf(r)] = r.ttl;

  // Compare with the previous run (none on the first run: baseline only).
  const prev = ctx.state.records as Record<string, number | null> | undefined;
  const changes = prev ? diffZone(prev, watched, bool(config, "watchTtl")) : [];
  const now = new Date().toISOString();
  const oldHistory = Array.isArray(ctx.state.history) ? (ctx.state.history as HistoryRow[]) : [];
  const history: HistoryRow[] = [...changes.map((c) => ({ when: now, ...c })), ...oldHistory].slice(0, 500);
  const changedAt = changes.length ? Date.now() : (ctx.state.changedAt as number | undefined);
  const lastChange = changes.length ? `${changes.length} change(s): ${changes.slice(0, 3).map(describe).join("; ")}${changes.length > 3 ? "; …" : ""}` : (ctx.state.lastChange as string | undefined);
  const state = { records: snapshot, history, changedAt, lastChange, serial };

  const severity = str(config, "severity", "warn") === "down" ? "down" : "warn";
  const holdMs = numOr(config, "holdMinutes", 60) * 60_000;
  const recent = changedAt && Date.now() - changedAt < holdMs;
  const details = {
    changes,
    history: history.slice(0, 200),
    records: watched.slice(0, 1000).map((r) => ({ name: r.name, type: r.type, ttl: r.ttl, value: r.value })),
  };
  const summary = `${watched.length} record(s)${serial ? `, serial ${serial}` : ""}`;
  if (!prev) return { status: "up", latencyMs, value: watched.length, message: `Baseline recorded: ${summary}`, details, state };
  if (changes.length) return { status: severity, latencyMs, value: watched.length, message: lastChange ?? "Zone changed", details, state };
  if (recent) return { status: severity, latencyMs, value: watched.length, message: `${lastChange} (${Math.round((Date.now() - changedAt) / 60_000)} min ago)`, details, state };
  return { status: "up", latencyMs, value: watched.length, message: `No changes — ${summary}`, details, state };
}
