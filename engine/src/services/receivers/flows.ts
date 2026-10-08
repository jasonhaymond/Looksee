export type Flow = { src: string; dst: string; protocol: number; srcPort: number; dstPort: number; bytes: number; packets: number };

const ipv4 = (b: Buffer, o: number) => `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
function ipv6(b: Buffer, o: number) {
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) parts.push(b.readUInt16BE(o + i).toString(16));
  return parts.join(":").replace(/(^|:)0(:0)+(:|$)/, "::");
}
function readUInt(b: Buffer, o: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) v = v * 256 + b[o + i];
  return v;
}

export function parseNetflowV5(b: Buffer): Flow[] {
  const count = b.readUInt16BE(2);
  const sampling = b.readUInt16BE(22) & 0x3fff || 1;
  const flows: Flow[] = [];
  for (let i = 0; i < count; i++) {
    const o = 24 + i * 48;
    if (o + 48 > b.length) break;
    flows.push({
      src: ipv4(b, o),
      dst: ipv4(b, o + 4),
      packets: b.readUInt32BE(o + 16) * sampling,
      bytes: b.readUInt32BE(o + 20) * sampling,
      srcPort: b.readUInt16BE(o + 32),
      dstPort: b.readUInt16BE(o + 34),
      protocol: b[o + 38],
    });
  }
  return flows;
}

type TemplateField = { type: number; length: number; enterprise: boolean };
// Templates are per exporter + observation domain/source id + template id,
// and arrive separately from (often after) the data they describe — data
// for an unknown template is dropped until its template shows up.
export class TemplateCache {
  private map = new Map<string, TemplateField[]>();
  set(key: string, fields: TemplateField[]) {
    this.map.set(key, fields);
  }
  get(key: string) {
    return this.map.get(key);
  }
}

function decodeRecord(fields: TemplateField[], b: Buffer, o: number, end: number): { flow: Flow | null; next: number } {
  const f: Partial<Flow> & { srcPort?: number; dstPort?: number } = { bytes: 0, packets: 0 };
  let p = o;
  for (const field of fields) {
    let len = field.length;
    if (len === 0xffff) {
      len = b[p];
      p += 1;
      if (len === 255) {
        len = b.readUInt16BE(p);
        p += 2;
      }
    }
    if (p + len > end) return { flow: null, next: end };
    if (!field.enterprise) {
      switch (field.type) {
        case 1:
        case 85:
        case 23:
          f.bytes = (f.bytes ?? 0) + readUInt(b, p, len);
          break;
        case 2:
        case 86:
        case 24:
          f.packets = (f.packets ?? 0) + readUInt(b, p, len);
          break;
        case 4:
          f.protocol = b[p];
          break;
        case 7:
          f.srcPort = readUInt(b, p, len);
          break;
        case 11:
          f.dstPort = readUInt(b, p, len);
          break;
        case 8:
          f.src = ipv4(b, p);
          break;
        case 12:
          f.dst = ipv4(b, p);
          break;
        case 27:
          f.src = ipv6(b, p);
          break;
        case 28:
          f.dst = ipv6(b, p);
          break;
      }
    }
    p += len;
  }
  if (!f.src || !f.dst) return { flow: null, next: p };
  return { flow: { src: f.src, dst: f.dst, protocol: f.protocol ?? 0, srcPort: f.srcPort ?? 0, dstPort: f.dstPort ?? 0, bytes: f.bytes ?? 0, packets: f.packets ?? 0 }, next: p };
}

function minRecordLength(fields: TemplateField[]) {
  return fields.reduce((a, f) => a + (f.length === 0xffff ? 1 : f.length), 0);
}

// NetFlow v9 (version 9) and IPFIX (version 10) share the template/data
// set model; they differ in header size, set ids, and IPFIX's enterprise
// bit and variable-length fields.
export function parseTemplated(b: Buffer, exporter: string, cache: TemplateCache): Flow[] {
  const version = b.readUInt16BE(0);
  const ipfix = version === 10;
  const headerLen = ipfix ? 16 : 20;
  const domain = ipfix ? b.readUInt32BE(12) : b.readUInt32BE(16);
  const totalLen = ipfix ? Math.min(b.readUInt16BE(2), b.length) : b.length;
  const templateSet = ipfix ? 2 : 0;
  const flows: Flow[] = [];
  let o = headerLen;
  while (o + 4 <= totalLen) {
    const setId = b.readUInt16BE(o);
    const setLen = b.readUInt16BE(o + 2);
    if (setLen < 4) break;
    const end = Math.min(o + setLen, totalLen);
    if (setId === templateSet) {
      let p = o + 4;
      while (p + 4 <= end) {
        const templateId = b.readUInt16BE(p);
        const fieldCount = b.readUInt16BE(p + 2);
        p += 4;
        const fields: TemplateField[] = [];
        for (let i = 0; i < fieldCount && p + 4 <= end; i++) {
          let type = b.readUInt16BE(p);
          const length = b.readUInt16BE(p + 2);
          p += 4;
          const enterprise = ipfix && (type & 0x8000) !== 0;
          if (enterprise) {
            type &= 0x7fff;
            p += 4;
          }
          fields.push({ type, length, enterprise });
        }
        cache.set(`${exporter}|${domain}|${templateId}`, fields);
      }
    } else if (setId >= 256) {
      const fields = cache.get(`${exporter}|${domain}|${setId}`);
      if (fields) {
        const min = minRecordLength(fields);
        let p = o + 4;
        while (p + min <= end && min > 0) {
          const { flow, next } = decodeRecord(fields, b, p, end);
          if (flow) flows.push(flow);
          if (next <= p) break;
          p = next;
        }
      }
    }
    o += setLen;
  }
  return flows;
}

function parseEthernetHeader(h: Buffer): Omit<Flow, "bytes" | "packets"> | null {
  if (h.length < 14) return null;
  let o = 12;
  let ethertype = h.readUInt16BE(o);
  while (ethertype === 0x8100 || ethertype === 0x88a8) {
    o += 4;
    if (o + 2 > h.length) return null;
    ethertype = h.readUInt16BE(o);
  }
  o += 2;
  if (ethertype === 0x0800 && h.length >= o + 20) {
    const ihl = (h[o] & 0x0f) * 4;
    const protocol = h[o + 9];
    const ports = (protocol === 6 || protocol === 17) && h.length >= o + ihl + 4;
    return { src: ipv4(h, o + 12), dst: ipv4(h, o + 16), protocol, srcPort: ports ? h.readUInt16BE(o + ihl) : 0, dstPort: ports ? h.readUInt16BE(o + ihl + 2) : 0 };
  }
  if (ethertype === 0x86dd && h.length >= o + 40) {
    const protocol = h[o + 6];
    const ports = (protocol === 6 || protocol === 17) && h.length >= o + 44;
    return { src: ipv6(h, o + 8), dst: ipv6(h, o + 24), protocol, srcPort: ports ? h.readUInt16BE(o + 40) : 0, dstPort: ports ? h.readUInt16BE(o + 42) : 0 };
  }
  return null;
}

// sFlow v5 flow samples carrying raw packet headers; each sampled packet
// stands for `samplingRate` real ones.
export function parseSflow(b: Buffer): { agent: string | null; flows: Flow[] } {
  if (b.readUInt32BE(0) !== 5) return { agent: null, flows: [] };
  const addrType = b.readUInt32BE(4);
  let o = 8;
  let agent: string | null = null;
  if (addrType === 1) {
    agent = ipv4(b, o);
    o += 4;
  } else if (addrType === 2) {
    agent = ipv6(b, o);
    o += 16;
  }
  o += 12; // sub-agent id, sequence, uptime
  const samples = b.readUInt32BE(o);
  o += 4;
  const flows: Flow[] = [];
  for (let s = 0; s < samples && o + 8 <= b.length; s++) {
    const format = b.readUInt32BE(o) & 0xfff;
    const len = b.readUInt32BE(o + 4);
    const start = o + 8;
    const end = Math.min(start + len, b.length);
    if (format === 1 || format === 3) {
      let p = start + 4; // sequence
      p += format === 1 ? 4 : 8; // source id (expanded: type + index)
      const rate = b.readUInt32BE(p) || 1;
      p += 12; // rate, pool, drops
      p += format === 1 ? 8 : 16; // input/output (expanded: format + value each)
      const records = b.readUInt32BE(p);
      p += 4;
      for (let r = 0; r < records && p + 8 <= end; r++) {
        const recFormat = b.readUInt32BE(p) & 0xfff;
        const recLen = b.readUInt32BE(p + 4);
        const rp = p + 8;
        if (recFormat === 1 && rp + 16 <= end) {
          const headerProtocol = b.readUInt32BE(rp);
          const frameLength = b.readUInt32BE(rp + 4);
          const headerLength = b.readUInt32BE(rp + 12);
          if (headerProtocol === 1) {
            const parsed = parseEthernetHeader(b.subarray(rp + 16, Math.min(rp + 16 + headerLength, end)));
            if (parsed) flows.push({ ...parsed, bytes: frameLength * rate, packets: rate });
          }
        }
        p = rp + recLen;
      }
    }
    o = end;
  }
  return { agent, flows };
}

// The lower port of a conversation is almost always the service (443, 53,
// 22); keying on it instead of the raw destination port keeps ephemeral
// client ports from exploding the number of distinct rows.
export const servicePort = (f: Flow) => (f.srcPort && f.dstPort ? Math.min(f.srcPort, f.dstPort) : f.dstPort || f.srcPort);
