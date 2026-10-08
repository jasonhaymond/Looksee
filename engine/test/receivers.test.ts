import "dotenv/config";
import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray, like } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { events, flowRecords } from "../src/db/schema.js";
import { parseSyslog, sourceAllowed, ingestSyslog, addFlows, flushFlows } from "../src/services/receivers/index.js";
import { TemplateCache, parseNetflowV5, parseSflow, parseTemplated, servicePort } from "../src/services/receivers/flows.js";
import { runProbe } from "../src/services/prober.js";

const marker = `looksee-test-${crypto.randomUUID().slice(0, 8)}`;
const exporter = `198.51.100.${Math.floor(Math.random() * 200) + 1}`;
afterAll(async () => {
  await db.delete(events).where(like(events.message, `%${marker}%`));
  await db.delete(flowRecords).where(eq(flowRecords.exporter, exporter));
});

describe("syslog parsing", () => {
  it("parses RFC 5424", () => {
    const p = parseSyslog("<165>1 2026-10-07T12:00:00Z fw01 sshd 123 - - Failed password for root");
    expect(p).toEqual({ facility: 20, severity: 5, host: "fw01", app: "sshd", message: "Failed password for root" });
  });
  it("parses BSD / RFC 3164", () => {
    const p = parseSyslog("<11>Oct  7 12:00:00 switch1 kernel[0]: port 3 link down");
    expect(p).toMatchObject({ facility: 1, severity: 3, host: "switch1", app: "kernel", message: "port 3 link down" });
  });
  it("keeps text without a PRI as-is", () => {
    expect(parseSyslog("plain text").message).toBe("plain text");
  });
});

describe("receiver source allowlist", () => {
  it("allows private ranges by default and rejects public ones", () => {
    expect(sourceAllowed("192.168.1.10")).toBe(true);
    expect(sourceAllowed("::ffff:10.0.0.5")).toBe(true);
    expect(sourceAllowed("172.31.255.255")).toBe(true);
    expect(sourceAllowed("172.32.0.1")).toBe(false);
    expect(sourceAllowed("8.8.8.8")).toBe(false);
    expect(sourceAllowed("fd12::1")).toBe(true);
    expect(sourceAllowed("2001:db8::1")).toBe(false);
  });
  it("honours an explicit list and *", () => {
    expect(sourceAllowed("8.8.8.8", "8.8.8.0/24")).toBe(true);
    expect(sourceAllowed("8.8.9.8", "8.8.8.0/24")).toBe(false);
    expect(sourceAllowed("1.2.3.4", "*")).toBe(true);
  });
});

function v5Packet(): Buffer {
  const header = Buffer.alloc(24);
  header.writeUInt16BE(5, 0);
  header.writeUInt16BE(1, 2);
  header.writeUInt16BE(0, 22);
  const rec = Buffer.alloc(48);
  Buffer.from([10, 0, 0, 5]).copy(rec, 0);
  Buffer.from([1, 1, 1, 1]).copy(rec, 4);
  rec.writeUInt32BE(10, 16);
  rec.writeUInt32BE(15000, 20);
  rec.writeUInt16BE(51515, 32);
  rec.writeUInt16BE(443, 34);
  rec[38] = 6;
  return Buffer.concat([header, rec]);
}

function v9Packets(): { template: Buffer; data: Buffer } {
  const header = (count: number) => {
    const h = Buffer.alloc(20);
    h.writeUInt16BE(9, 0);
    h.writeUInt16BE(count, 2);
    h.writeUInt32BE(7, 16); // source id
    return h;
  };
  // template 256: IPV4_SRC(8,4) IPV4_DST(12,4) IN_BYTES(1,4) IN_PKTS(2,4) PROTOCOL(4,1) L4_DST(11,2)
  const fields = [[8, 4], [12, 4], [1, 4], [2, 4], [4, 1], [11, 2]];
  const tpl = Buffer.alloc(4 + 4 + fields.length * 4);
  tpl.writeUInt16BE(0, 0);
  tpl.writeUInt16BE(tpl.length, 2);
  tpl.writeUInt16BE(256, 4);
  tpl.writeUInt16BE(fields.length, 6);
  fields.forEach(([t, l], i) => {
    tpl.writeUInt16BE(t, 8 + i * 4);
    tpl.writeUInt16BE(l, 10 + i * 4);
  });
  const rec = Buffer.alloc(19);
  Buffer.from([192, 168, 1, 20]).copy(rec, 0);
  Buffer.from([9, 9, 9, 9]).copy(rec, 4);
  rec.writeUInt32BE(2000, 8);
  rec.writeUInt32BE(4, 12);
  rec[16] = 17;
  rec.writeUInt16BE(53, 17);
  const dataSet = Buffer.alloc(4 + rec.length + 1); // padded
  dataSet.writeUInt16BE(256, 0);
  dataSet.writeUInt16BE(dataSet.length, 2);
  rec.copy(dataSet, 4);
  return { template: Buffer.concat([header(1), tpl]), data: Buffer.concat([header(1), dataSet]) };
}

function ipfixPacket(): Buffer {
  const fields = [[8, 4], [12, 4], [1, 8], [2, 8], [4, 1]];
  const tpl = Buffer.alloc(8 + fields.length * 4);
  tpl.writeUInt16BE(2, 0);
  tpl.writeUInt16BE(tpl.length, 2);
  tpl.writeUInt16BE(300, 4);
  tpl.writeUInt16BE(fields.length, 6);
  fields.forEach(([t, l], i) => {
    tpl.writeUInt16BE(t, 8 + i * 4);
    tpl.writeUInt16BE(l, 10 + i * 4);
  });
  const rec = Buffer.alloc(25);
  Buffer.from([10, 1, 1, 1]).copy(rec, 0);
  Buffer.from([10, 2, 2, 2]).copy(rec, 4);
  rec.writeBigUInt64BE(123456n, 8);
  rec.writeBigUInt64BE(100n, 16);
  rec[24] = 6;
  const data = Buffer.alloc(4 + rec.length);
  data.writeUInt16BE(300, 0);
  data.writeUInt16BE(data.length, 2);
  rec.copy(data, 4);
  const header = Buffer.alloc(16);
  header.writeUInt16BE(10, 0);
  header.writeUInt16BE(16 + tpl.length + data.length, 2);
  header.writeUInt32BE(1, 12);
  return Buffer.concat([header, tpl, data]);
}

function sflowPacket(): Buffer {
  // Ethernet + IPv4 + TCP header of one sampled packet.
  const eth = Buffer.alloc(14 + 20 + 4);
  eth.writeUInt16BE(0x0800, 12);
  eth[14] = 0x45;
  eth[14 + 9] = 6;
  Buffer.from([172, 16, 0, 9]).copy(eth, 14 + 12);
  Buffer.from([93, 184, 216, 34]).copy(eth, 14 + 16);
  eth.writeUInt16BE(50000, 34);
  eth.writeUInt16BE(443, 36);
  const rawHeader = Buffer.alloc(16 + 40); // protocol, frame len, stripped, header len + padded header
  rawHeader.writeUInt32BE(1, 0);
  rawHeader.writeUInt32BE(1500, 4);
  rawHeader.writeUInt32BE(eth.length, 12);
  eth.copy(rawHeader, 16);
  const record = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.alloc(4), rawHeader]);
  record.writeUInt32BE(rawHeader.length, 4);
  const sampleBody = Buffer.alloc(32);
  sampleBody.writeUInt32BE(1, 0); // seq
  sampleBody.writeUInt32BE(3, 4); // source id
  sampleBody.writeUInt32BE(512, 8); // sampling rate
  sampleBody.writeUInt32BE(1, 28); // records
  const sample = Buffer.concat([Buffer.alloc(8), sampleBody, record]);
  sample.writeUInt32BE(1, 0);
  sample.writeUInt32BE(sampleBody.length + record.length, 4);
  const header = Buffer.alloc(28);
  header.writeUInt32BE(5, 0);
  header.writeUInt32BE(1, 4);
  Buffer.from([10, 0, 0, 254]).copy(header, 8);
  header.writeUInt32BE(1, 24);
  return Buffer.concat([header, sample]);
}

describe("flow parsing", () => {
  it("NetFlow v5", () => {
    expect(parseNetflowV5(v5Packet())).toEqual([{ src: "10.0.0.5", dst: "1.1.1.1", packets: 10, bytes: 15000, srcPort: 51515, dstPort: 443, protocol: 6 }]);
  });
  it("NetFlow v9: data is decoded once its template has arrived", () => {
    const cache = new TemplateCache();
    const { template, data } = v9Packets();
    expect(parseTemplated(data, "x", cache)).toEqual([]);
    expect(parseTemplated(template, "x", cache)).toEqual([]);
    expect(parseTemplated(data, "x", cache)).toEqual([{ src: "192.168.1.20", dst: "9.9.9.9", bytes: 2000, packets: 4, protocol: 17, srcPort: 0, dstPort: 53 }]);
  });
  it("IPFIX with 8-byte counters", () => {
    const flows = parseTemplated(ipfixPacket(), "y", new TemplateCache());
    expect(flows).toEqual([{ src: "10.1.1.1", dst: "10.2.2.2", bytes: 123456, packets: 100, protocol: 6, srcPort: 0, dstPort: 0 }]);
  });
  it("sFlow v5 raw packet headers, scaled by the sampling rate", () => {
    const { agent, flows } = parseSflow(sflowPacket());
    expect(agent).toBe("10.0.0.254");
    expect(flows).toEqual([{ src: "172.16.0.9", dst: "93.184.216.34", protocol: 6, srcPort: 50000, dstPort: 443, bytes: 1500 * 512, packets: 512 }]);
  });
  it("keys conversations on the service (lower) port", () => {
    expect(servicePort({ src: "", dst: "", protocol: 6, srcPort: 51515, dstPort: 443, bytes: 0, packets: 0 })).toBe(443);
  });
  it("aggregates per minute and writes rows", async () => {
    addFlows(exporter, parseNetflowV5(v5Packet()));
    addFlows(exporter, parseNetflowV5(v5Packet()));
    expect(await flushFlows()).toBeGreaterThan(0);
    const rows = await db.query.flowRecords.findMany({ where: eq(flowRecords.exporter, exporter) });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ srcAddr: "10.0.0.5", dstAddr: "1.1.1.1", dstPort: 443, bytes: 30000, packets: 20 });
  });
});

describe("event ingest + match checks", () => {
  it("counts matching syslog lines inside the window, filtered by severity", async () => {
    await ingestSyslog(`<11>Oct  7 12:00:00 sw1 kernel: ${marker} link down`, "10.9.9.9");
    await ingestSyslog(`<14>Oct  7 12:00:01 sw1 kernel: ${marker} informational`, "10.9.9.9");
    const r = await runProbe("syslog_match", { pattern: marker, maxSeverity: 3, windowMinutes: 5 });
    expect(r.status).toBe("down");
    expect(r.value).toBe(1);
    const all = await runProbe("syslog_match", { pattern: marker, windowMinutes: 5, criticalAbove: 5 });
    expect(all.status).toBe("up");
    expect(all.value).toBe(2);
    const rows = await db.query.events.findMany({ where: inArray(events.sourceIp, ["10.9.9.9"]) });
    expect(rows.some((e) => e.message.includes(marker))).toBe(true);
  });
  it("reports an invalid regex as a warn, not a crash", async () => {
    const r = await runProbe("syslog_match", { pattern: "([" });
    expect(r.status).toBe("warn");
  });
});
