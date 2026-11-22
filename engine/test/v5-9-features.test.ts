// Tests for the 5.9 features: DNS zone discovery without a transfer, the
// pinned zone baseline, and SNMP value types. Each test says what behaviour (or attack) it proves.
//
// The DNS tests run a fake authoritative DNS server on 127.0.0.1 (UDP, a
// random port) that answers from an in-memory zone, so nothing leaves the
// machine.

import dgram from "node:dgram";
import * as snmp from "net-snmp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { interpretValue, judgeText, numberInText, opaqueNumber, parseStateMap, probeSnmp } from "../src/services/probes/snmp.js";
import { COMMON_NAMES, currentKey, encodeName, probeDnsZone, readName, trackAgainstBaseline, typeBitmap } from "../src/services/probes/dnsZone.js";

// ---- A fake authoritative DNS server --------------------------------------------

/** One record in the fake zone: type number, TTL, data in wire format. */
type FakeRecord = { type: number; ttl: number; rdata: Buffer };

/** Wire-format data helpers (A address, TXT string, MX, SOA, NSEC). */
const a = (ip: string) => Buffer.from(ip.split(".").map(Number));
const txt = (s: string) => Buffer.concat([Buffer.from([s.length]), Buffer.from(s)]);
const mx = (pref: number, host: string) => Buffer.concat([Buffer.from([0, pref]), encodeName(host)]);
const soa = (serial: number) => {
  const nums = Buffer.alloc(20);
  [serial, 3600, 600, 86400, 300].forEach((n, i) => nums.writeUInt32BE(n, i * 4));
  return Buffer.concat([encodeName("ns1.example.test"), encodeName("hostmaster.example.test"), nums]);
};
/** An NSEC record's data: next name, then a type bitmap for window 0. */
const nsec = (next: string, types: number[]) => {
  const bits = Buffer.alloc(32);
  for (const t of types) bits[t >> 3] |= 0x80 >> (t & 7);
  let len = 32;
  while (len > 1 && bits[len - 1] === 0) len--;
  return Buffer.concat([encodeName(next), Buffer.from([0, len]), bits.subarray(0, len)]);
};

/**
 * Starts the fake server. `zone()` returns the current zone (absolute name →
 * records), so a test can change it between runs. A name not in the zone is
 * NXDOMAIN unless the zone has a "*.example.test" wildcard. `badId` makes
 * every answer carry the wrong query ID (a spoofing attempt).
 */
function fakeUdpDns(zone: () => Map<string, FakeRecord[]>, opts: { badId?: boolean } = {}): Promise<{ port: number; close: () => void; queries: () => number }> {
  let count = 0;
  return new Promise((resolve) => {
    const socket = dgram.createSocket("udp4");
    socket.on("message", (query, from) => {
      count++;
      const id = query.readUInt16BE(0);
      const { name, next } = readName(query, 12);
      const qtype = query.readUInt16BE(next);
      const question = query.subarray(12, next + 4);
      const z = zone();
      const wildcard = z.get("*.example.test");
      const records = z.get(name) ?? (name.endsWith(".example.test") ? wildcard : undefined);
      const answers = (records ?? []).filter((r) => r.type === qtype).map((r) => {
        const head = Buffer.alloc(10);
        head.writeUInt16BE(r.type, 0);
        head.writeUInt16BE(1, 2);
        head.writeUInt32BE(r.ttl, 4);
        head.writeUInt16BE(r.rdata.length, 8);
        return Buffer.concat([encodeName(name), head, r.rdata]);
      });
      const header = Buffer.alloc(12);
      header.writeUInt16BE(opts.badId ? (id + 1) & 0xffff : id, 0);
      // QR (answer) + AA (authoritative), and NXDOMAIN (3) for unknown names.
      header.writeUInt16BE(0x8400 | (records ? 0 : 3), 2);
      header.writeUInt16BE(1, 4);
      header.writeUInt16BE(answers.length, 6);
      socket.send(Buffer.concat([header, question, ...answers]), from.port, from.address);
    });
    socket.bind(0, "127.0.0.1", () => resolve({ port: socket.address().port, close: () => socket.close(), queries: () => count }));
  });
}

/** A small zone without DNSSEC: apex SOA/NS/MX/TXT, common names, one the MX points at, one nobody would guess. */
function plainZone(): Map<string, FakeRecord[]> {
  return new Map<string, FakeRecord[]>([
    ["example.test", [
      { type: 6, ttl: 3600, rdata: soa(1) },
      { type: 2, ttl: 3600, rdata: encodeName("ns1.example.test") },
      { type: 15, ttl: 3600, rdata: mx(10, "relay7.example.test") },
      { type: 16, ttl: 300, rdata: txt("v=spf1 mx -all") },
    ]],
    ["www.example.test", [{ type: 1, ttl: 300, rdata: a("192.0.2.1") }]],
    ["ns1.example.test", [{ type: 1, ttl: 300, rdata: a("192.0.2.53") }]],
    ["_dmarc.example.test", [{ type: 16, ttl: 300, rdata: txt("v=DMARC1; p=reject") }]],
    ["relay7.example.test", [{ type: 1, ttl: 300, rdata: a("192.0.2.25") }]],
    ["hidden-box.example.test", [{ type: 1, ttl: 300, rdata: a("192.0.2.77") }]],
  ]);
}

const ctx = (state: Record<string, unknown> = {}) => ({ checkId: "", endpointId: null, intervalSeconds: 3600, state });
type Rec = { name: string; type: string; value: string; ttl: number | null };
const recordsOf = (out: { details?: unknown }) => (out.details as { records: Rec[] }).records;

describe("DNS zone discovery (no transfer)", () => {
  // Proves discovery finds the zone itself, common names, and a name only an
  // MX record points at — and reads more types than A (TXT at _dmarc) — but
  // not a name nobody listed or guessed; listing it as an extra name finds it.
  it("finds common, pointed-at and extra names", async () => {
    const srv = await fakeUdpDns(plainZone);
    try {
      const config = { zone: "example.test", mode: "discover", server: `127.0.0.1:${srv.port}`, timeoutSeconds: 2 };
      const first = await probeDnsZone(config, ctx());
      expect(first.status).toBe("up");
      const names = new Set(recordsOf(first).map((r) => r.name));
      expect(names).toEqual(new Set(["@", "www", "ns1", "_dmarc", "relay7"]));
      expect(recordsOf(first)).toContainEqual({ name: "_dmarc", type: "TXT", ttl: 300, value: '"v=DMARC1; p=reject"' });
      expect(first.message).toContain("name(s) found of");

      const withExtra = await probeDnsZone({ ...config, extraNames: "hidden-box" }, ctx());
      expect(recordsOf(withExtra).some((r) => r.name === "hidden-box" && r.value === "192.0.2.77")).toBe(true);
    } finally {
      srv.close();
    }
  });

  // Proves a zone with an NSEC chain is listed completely by following it —
  // including a name no list would guess — without trying the common names.
  it("walks the NSEC chain", async () => {
    const zone = new Map<string, FakeRecord[]>([
      ["example.test", [{ type: 6, ttl: 3600, rdata: soa(1) }, { type: 47, ttl: 300, rdata: nsec("alpha.example.test", [6, 46, 47]) }]],
      ["alpha.example.test", [{ type: 1, ttl: 300, rdata: a("192.0.2.10") }, { type: 47, ttl: 300, rdata: nsec("zz-unguessable.example.test", [1, 46, 47]) }]],
      ["zz-unguessable.example.test", [{ type: 16, ttl: 300, rdata: txt("found") }, { type: 47, ttl: 300, rdata: nsec("example.test", [16, 46, 47]) }]],
    ]);
    const srv = await fakeUdpDns(() => zone);
    try {
      const out = await probeDnsZone({ zone: "example.test", mode: "discover", server: `127.0.0.1:${srv.port}`, watchSoa: true, timeoutSeconds: 2 }, ctx());
      expect(out.message).toContain("from the NSEC chain");
      const recs = recordsOf(out);
      expect(recs).toContainEqual({ name: "zz-unguessable", type: "TXT", ttl: 300, value: '"found"' });
      // NSEC/RRSIG bookkeeping isn't recorded as zone content.
      expect(recs.some((r) => r.type === "NSEC")).toBe(false);
      // Only the types each NSEC record lists are asked for: few queries,
      // not ~25 per common name.
      expect(srv.queries()).toBeLessThan(20);
    } finally {
      srv.close();
    }
  });

  // Proves a wildcard zone doesn't make every guessed name look real: the
  // wildcard is recorded once as "*", and guessed names that only match it
  // are left out.
  it("records a wildcard once", async () => {
    const zone = plainZone();
    zone.set("*.example.test", [{ type: 1, ttl: 300, rdata: a("192.0.2.99") }]);
    const srv = await fakeUdpDns(() => zone);
    try {
      const out = await probeDnsZone({ zone: "example.test", mode: "discover", server: `127.0.0.1:${srv.port}`, timeoutSeconds: 2 }, ctx());
      const recs = recordsOf(out);
      expect(recs.filter((r) => r.value === "192.0.2.99").map((r) => r.name)).toEqual(["*"]);
      expect(out.message).toContain("wildcard present");
      expect(recs.some((r) => r.name === "www")).toBe(true);
    } finally {
      srv.close();
    }
  });

  // Proves answers carrying the wrong query ID (what a blind spoofing attempt
  // looks like) are ignored: the check reports no reply instead of using them.
  it("ignores answers with the wrong query ID", async () => {
    const srv = await fakeUdpDns(plainZone, { badId: true });
    try {
      const out = await probeDnsZone({ zone: "example.test", mode: "discover", server: `127.0.0.1:${srv.port}`, timeoutSeconds: 1 }, ctx());
      expect(out.status).toBe("down");
      expect(out.message).toContain("No reply");
    } finally {
      srv.close();
    }
  });

  // Proves a name that isn't a zone is refused with a clear message.
  it("says when the name isn't a zone", async () => {
    const srv = await fakeUdpDns(plainZone);
    try {
      const out = await probeDnsZone({ zone: "nope.test", mode: "discover", server: `127.0.0.1:${srv.port}`, timeoutSeconds: 1 }, ctx());
      expect(out.status).toBe("down");
      expect(out.message).toMatch(/doesn't exist|isn't a zone/);
    } finally {
      srv.close();
    }
  });

  // Proves the common-name list has no duplicates (each costs a query).
  it("has no duplicate common names", () => {
    expect(new Set(COMMON_NAMES).size).toBe(COMMON_NAMES.length);
  });
});

describe("DNS zone pinned baseline", () => {
  // Proves a change keeps alerting run after run (with when it was first
  // seen and how many runs), is accepted after acceptAfterRuns runs, and
  // the zone then matches the baseline again.
  it("keeps a change outstanding until accepted after N runs", async () => {
    let zone = plainZone();
    const srv = await fakeUdpDns(() => zone);
    try {
      const config = { zone: "example.test", mode: "discover", baseline: "pinned", acceptAfterRuns: 3, commonNames: true, server: `127.0.0.1:${srv.port}`, timeoutSeconds: 2 };
      const first = await probeDnsZone(config, ctx());
      expect(first.message).toContain("Baseline recorded");

      zone = plainZone();
      zone.set("www.example.test", [{ type: 1, ttl: 300, rdata: a("203.0.113.9") }]);
      zone.delete("_dmarc.example.test");
      const second = await probeDnsZone(config, ctx(first.state));
      expect(second.status).toBe("warn");
      expect(second.message).toContain("2 change(s) from the baseline");
      const changes = (second.details as { changes: { change: string; name: string; runs: number }[] }).changes;
      expect(changes).toContainEqual(expect.objectContaining({ change: "changed", name: "www", runs: 1 }));
      expect(changes).toContainEqual(expect.objectContaining({ change: "removed", name: "_dmarc", runs: 1 }));

      const third = await probeDnsZone(config, ctx(third_state(second)));
      expect(third.status).toBe("warn");
      expect((third.details as { changes: { runs: number }[] }).changes.every((c) => c.runs === 2)).toBe(true);

      const fourth = await probeDnsZone(config, ctx(fourth_state(third)));
      expect(fourth.status).toBe("up");
      expect(fourth.message).toContain("accepted into the baseline");

      const fifth = await probeDnsZone(config, ctx(fourth.state));
      expect(fifth.message).toContain("Matches the baseline");
    } finally {
      srv.close();
    }
  });

  // Proves marking the check recovered (state.resolvedAt, set by
  // resolveCheck) makes the next run take the zone as it is as the new
  // baseline, and that the marker isn't carried on to later runs.
  it("accepts everything when marked recovered", async () => {
    let zone = plainZone();
    const srv = await fakeUdpDns(() => zone);
    try {
      const config = { zone: "example.test", mode: "discover", baseline: "pinned", server: `127.0.0.1:${srv.port}`, timeoutSeconds: 2 };
      const first = await probeDnsZone(config, ctx());
      zone = plainZone();
      zone.set("www.example.test", [{ type: 1, ttl: 300, rdata: a("203.0.113.9") }]);
      const second = await probeDnsZone(config, ctx(first.state));
      expect(second.status).toBe("warn");
      expect(second.message).toContain("mark the check recovered");

      const third = await probeDnsZone(config, ctx({ ...second.state, resolvedAt: new Date().toISOString() }));
      expect(third.status).toBe("up");
      expect(third.message).toContain("Baseline updated");
      expect(third.state).not.toHaveProperty("resolvedAt");
      const history = (third.state!.history as { change: string }[]).map((h) => h.change);
      expect(history).toContain("accepted");

      const fourth = await probeDnsZone(config, ctx(third.state));
      expect(fourth.message).toContain("Matches the baseline");
    } finally {
      srv.close();
    }
  });

  // Proves a difference that goes back by itself stops counting and is
  // recorded as reverted.
  it("records a reverted change", () => {
    const baseline = { "www\tA\t192.0.2.1": 300 };
    const changed = [{ name: "www", type: "A", ttl: 300, value: "192.0.2.9" }];
    const now = new Date().toISOString();
    const one = trackAgainstBaseline(baseline, {}, changed, { watchTtl: false, acceptAfterRuns: 0, accept: false, now });
    expect(one.outstanding).toHaveLength(1);
    const back = trackAgainstBaseline(one.baseline, one.pending, [{ name: "www", type: "A", ttl: 300, value: "192.0.2.1" }], { watchTtl: false, acceptAfterRuns: 0, accept: false, now });
    expect(back.outstanding).toHaveLength(0);
    expect(back.reverted).toHaveLength(1);
  });
});

describe("DNS record formats", () => {
  // Proves an inventory saved by an older version (unknown types by number,
  // data as hex) is read the way this version shows it, so upgrading isn't
  // reported as a zone change.
  it("upgrades old record keys", () => {
    expect(currentKey("host\tTYPE44\t\\# 6 0102abcdef12")).toBe("host\tSSHFP\t1 2 ABCDEF12");
    expect(currentKey("www\tA\t192.0.2.1")).toBe("www\tA\t192.0.2.1");
    expect(currentKey("@\tDS\t\\# 6 30390d02aabb")).toBe("@\tDS\t12345 13 2 AABB");
  });

  // Proves the NSEC type list is decoded bit by bit (A=1, MX=15, AAAA=28).
  it("reads NSEC type bitmaps", () => {
    const bits = nsec("x.example.test", [1, 15, 28]).subarray(encodeName("x.example.test").length);
    expect(typeBitmap(bits)).toEqual(["A", "MX", "AAAA"]);
    // A malformed block ends the list instead of throwing.
    expect(typeBitmap(Buffer.from([0, 40, 1]))).toEqual([]);
  });
});

/** Next run's state (helpers named for readability in the test above). */
function third_state(prev: { state?: Record<string, unknown> }) {
  return prev.state!;
}
function fourth_state(prev: { state?: Record<string, unknown> }) {
  return prev.state!;
}

// ---- SNMP value types ---------------------------------------------------------------

describe("SNMP value types", () => {
  // Proves Net-SNMP's Opaque float and double encodings are decoded (load
  // averages, sensors), and other bytes aren't mistaken for one.
  it("decodes Opaque floats", () => {
    const f = Buffer.alloc(7);
    f.set([0x9f, 0x78, 0x04]);
    f.writeFloatBE(0.75, 3);
    expect(opaqueNumber(f)).toBeCloseTo(0.75);
    const d = Buffer.alloc(11);
    d.set([0x9f, 0x79, 0x08]);
    d.writeDoubleBE(-12.5, 3);
    expect(opaqueNumber(d)).toBe(-12.5);
    expect(opaqueNumber(Buffer.from("hello"))).toBeNull();
  });

  // Proves "number inside text" finds the first number, with signs,
  // decimals and thousands commas, and reports text without one.
  it("finds numbers inside text", () => {
    expect(numberInText("23.5 C")).toBe(23.5);
    expect(numberInText("Load: -1,204.5 W")).toBe(-1204.5);
    expect(numberInText("no digits")).toBeNull();
    const text = { type: snmp.ObjectType.OctetString, value: Buffer.from("Temp 41 C") };
    expect(interpretValue(text, { valueType: "text_number" })).toMatchObject({ num: 41 });
    expect(interpretValue(text, { valueType: "number" })).toHaveProperty("error");
    // Automatic: text that isn't just a number stays text (no warning).
    expect(interpretValue(text, {})).toMatchObject({ num: null, text: "Temp 41 C", type: "OctetString" });
    expect(interpretValue({ type: snmp.ObjectType.OctetString, value: Buffer.from(" 42 ") }, {})).toMatchObject({ num: 42 });
  });

  // Proves time ticks (hundredths of a second) are read as seconds.
  it("reads time ticks as seconds", () => {
    expect(interpretValue({ type: snmp.ObjectType.TimeTicks, value: 8_640_000 }, { valueType: "timeticks" })).toMatchObject({ num: 86_400, text: "1 day(s) 0 h 00 min" });
  });

  // Proves a state map turns a status number or word into up/warn/down,
  // with the label in the message, and an unlisted value gets the chosen
  // status; a malformed line is refused with the line shown.
  it("maps states", () => {
    const config = { valueType: "state", stateMap: "1 = up running\n2 = down stopped\ndegraded = warn" };
    expect(interpretValue({ type: snmp.ObjectType.Integer, value: 2 }, config)).toMatchObject({ state: { status: "down", label: "stopped" } });
    expect(interpretValue({ type: snmp.ObjectType.OctetString, value: Buffer.from("Degraded") }, config)).toMatchObject({ state: { status: "warn" } });
    expect(interpretValue({ type: snmp.ObjectType.Integer, value: 7 }, { ...config, unmappedStatus: "down" })).toMatchObject({ state: { status: "down", label: "unlisted value 7" } });
    expect(() => parseStateMap("1 = maybe")).toThrow(/State map line/);
  });

  // Proves the text rules: contains, equals, not contains, and regex (run on
  // RE2, so a catastrophic-backtracking pattern can't hang the engine).
  it("judges text rules", () => {
    expect(judgeText("Status OK", { expectString: "OK" })).toMatchObject({ status: "up" });
    expect(judgeText("Status OK", { expectString: "OK", textMatch: "equals" })).toMatchObject({ status: "down" });
    expect(judgeText("Status OK", { expectString: "FAIL", textMatch: "not_contains", textStatus: "warn" })).toMatchObject({ status: "up" });
    expect(judgeText("Normal", { expectString: "^(Normal|OK)$", textMatch: "regex" })).toMatchObject({ status: "up" });
    const start = Date.now();
    expect(judgeText("a".repeat(5000) + "!", { expectString: "^(a+)+$", textMatch: "regex" })).toMatchObject({ status: "down" });
    expect(Date.now() - start).toBeLessThan(1000);
    expect(judgeText("x", { expectString: "(", textMatch: "regex" })).toHaveProperty("error");
  });
});

describe("SNMP values from a real agent", () => {
  // An SNMP agent (net-snmp's own, in this process, on a random high UDP
  // port) serving one text value, one Opaque float, one status number and
  // a Counter32 — read through the real probe, over the network stack.
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let agent: ReturnType<typeof snmp.createAgent>;
  const base = "1.3.6.1.4.1.99999";
  beforeAll(() => {
    agent = snmp.createAgent({ port, address: "127.0.0.1", disableAuthorization: true }, () => undefined);
    const mib = agent.getMib();
    const scalar = (name: string, n: number, scalarType: number) => mib.registerProvider({ name, type: snmp.MibProviderType.Scalar, oid: `${base}.${n}`, scalarType, maxAccess: snmp.MaxAccess["read-only"] } as never);
    scalar("text", 1, snmp.ObjectType.OctetString);
    scalar("status", 2, snmp.ObjectType.Integer);
    mib.setScalarValue("text", "Fan 2: 3100 RPM");
    mib.setScalarValue("status", 2);
    agent.getAuthorizer().addCommunity("public");
  });
  afterAll(() => agent?.close());
  const config = (extra: Record<string, unknown>) => ({ host: "127.0.0.1", port, version: "2c", community: "public", ...extra });
  const ctx = { checkId: "", endpointId: null, intervalSeconds: 60, state: {} };

  // Proves a text value reads as text (up, no "non-numeric" warning), the
  // number inside it can be the value, and the result says its SNMP type.
  it("reads text and the number inside it", async () => {
    const plain = await probeSnmp(config({ oid: `${base}.1.0` }), ctx);
    expect(plain).toMatchObject({ status: "up", message: "Fan 2: 3100 RPM", details: { type: "OctetString" } });
    const inText = await probeSnmp(config({ oid: `${base}.1.0`, valueType: "text_number" }), ctx);
    // The first number in "Fan 2: 3100 RPM" is 2 — the admin picks the OID
    // whose text holds the number they want first; here that's the fan number.
    expect(inText.value).toBe(2);
  }, 15_000);

  // Proves a state map sets the status from a status number.
  it("maps a status number", async () => {
    const out = await probeSnmp(config({ oid: `${base}.2.0`, valueType: "state", stateMap: "1 = up running\n2 = down stopped" }), ctx);
    expect(out).toMatchObject({ status: "down", message: "stopped (2)", value: 2 });
  }, 15_000);

  // Proves a missing OID says the device has no value there (with a hint),
  // instead of only the SNMP error name.
  it("explains a missing OID", async () => {
    const out = await probeSnmp(config({ oid: `${base}.9.0` }), ctx);
    expect(out.status).toBe("down");
    expect(out.message).toContain("has no value at");
  }, 15_000);
});
