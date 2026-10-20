// Tests for the engine's network probes: ping, UDP, mail/SSH/LDAP/RDP/FTP
// banners, NTP, DHCP, MQTT, WebSocket, gRPC health, Docker registry and DNS
// (including DNSSEC), plus the text parsers for traceroute and ARP tables.
//
// Every protocol probe is exercised against a real socket server on
// 127.0.0.1 speaking just enough of that protocol — the probe's actual bytes
// on the wire are what's under test, not a mocked client. Servers listen on
// port 0 (the operating system picks a free port), so tests never collide
// with each other or with something else on the machine.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import net from "node:net";
import http from "node:http";
import dgram from "node:dgram";
import { WebSocketServer } from "ws";
import * as grpc from "@grpc/grpc-js";
import { runProbe } from "../src/services/prober.js";
import { parsePingTimes, pingStats, buildDnsQuery, parseDnsFlags } from "../src/services/probes/basic.js";
import { buildDhcpDiscover, parseDhcpOffer, parseArpTable, ldapBindRequest, buildMqttConnect } from "../src/services/probes/protocols.js";
import { parseTraceroute } from "../src/services/probes/services.js";

// Every server started by a test, closed once all tests in the file finish.
const servers: { close: () => void }[] = [];
afterAll(() => servers.forEach((s) => s.close()));

/**
 * Starts a TCP server on a free local port.
 *
 * @param onConnect what the fake server does with each connection
 * @returns the port it listens on
 */
function tcpServer(onConnect: (sock: net.Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer(onConnect);
    srv.listen(0, "127.0.0.1", () => resolve((srv.address() as net.AddressInfo).port));
    servers.push({ close: () => srv.close() });
  });
}

/**
 * Starts a UDP server on a local port (a free one unless `port` is given).
 *
 * @param onMessage what the fake server does with each datagram
 * @param port a specific port, or 0 to let the operating system choose
 * @returns the port it listens on
 */
function udpServer(onMessage: (msg: Buffer, rinfo: dgram.RemoteInfo, sock: dgram.Socket) => void, port = 0): Promise<number> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.on("message", (m, r) => onMessage(m, r, sock));
    sock.bind(port, "127.0.0.1", () => resolve(sock.address().port));
    servers.push({ close: () => sock.close() });
  });
}

/**
 * A UDP port that is free right now, chosen by the operating system: bind to
 * port 0, read which port was assigned, release it. Guessing a random high
 * port instead fails intermittently on Windows, which reserves blocks of
 * high ports for Hyper-V/WSL/Docker (see `netsh int ipv4 show
 * excludedportrange protocol=udp`).
 *
 * @returns a port number the caller can bind to next
 */
function freeUdpPort(): Promise<number> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    sock.bind(0, "127.0.0.1", () => {
      const port = sock.address().port;
      sock.close(() => resolve(port));
    });
  });
}

describe("ping parsing", () => {
  // Proves the reply-time parser handles both Linux and Windows ping output,
  // including Windows's "time<1ms" for sub-millisecond replies.
  it("parses Linux, Windows and sub-millisecond reply lines", () => {
    expect(parsePingTimes("64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms\n64 bytes from 1.1.1.1: icmp_seq=2 ttl=57 time=14.1 ms")).toEqual([12.3, 14.1]);
    expect(parsePingTimes("Reply from 8.8.8.8: bytes=32 time=9ms TTL=117\nReply from 8.8.8.8: bytes=32 time<1ms TTL=117")).toEqual([9, 1]);
  });
  // Proves loss % (1 of 4 lost = 25), average and jitter (largest change
  // between consecutive replies) are computed correctly.
  it("computes loss and jitter", () => {
    const s = pingStats([10, 20, 10], 4);
    expect(s.loss).toBe(25);
    expect(s.avg).toBeCloseTo(13.33, 1);
    expect(s.jitter).toBe(10);
  });
  // Proves the ping probe works end to end with the system ping command.
  it("pings localhost for real and reports loss/latency", async () => {
    const r = await runProbe("ping", { host: "127.0.0.1", count: 2 });
    expect(r.status).toBe("up");
    expect(r.value).toBe(0);
  }, 20_000);
});

describe("UDP", () => {
  // Proves the UDP probe sends its payload and checks the reply's content.
  it("is up when the reply contains the expected text, down when it doesn't", async () => {
    const port = await udpServer((msg, r, sock) => sock.send(Buffer.from(`echo:${msg}`), r.port, r.address));
    expect((await runProbe("udp", { host: "127.0.0.1", port, payload: "hello", expectContains: "echo:hello" })).status).toBe("up");
    expect((await runProbe("udp", { host: "127.0.0.1", port, payload: "hello", expectContains: "nope" })).status).toBe("down");
  });
  // Proves silence (no reply within the timeout) counts as down, not up.
  it("is down when nothing answers", async () => {
    const port = await udpServer(() => undefined);
    const r = await runProbe("udp", { host: "127.0.0.1", port, payload: "x", timeoutSeconds: 1 });
    expect(r.status).toBe("down");
  });
});

describe("protocol probes", () => {
  // Proves the SMTP probe reads the 220 banner, sends EHLO, and — when
  // STARTTLS is required — flags a server that doesn't offer encryption.
  it("SMTP: banner + EHLO capabilities, with STARTTLS requirement", async () => {
    const port = await tcpServer((sock) => {
      sock.write("220 mail.test ESMTP ready\r\n");
      sock.on("data", (d) => {
        if (/^EHLO/i.test(d.toString())) sock.write("250-mail.test hello\r\n250-SIZE 1000\r\n250 STARTTLS\r\n");
      });
    });
    const ok = await runProbe("protocol", { protocol: "smtp", host: "127.0.0.1", port, requireStartTls: true });
    expect(ok.status).toBe("up");
    expect(ok.message).toMatch(/220 mail.test/);
    const noTlsPort = await tcpServer((sock) => {
      sock.write("220 plain ESMTP\r\n");
      sock.on("data", () => sock.write("250 plain hello\r\n"));
    });
    const bad = await runProbe("protocol", { protocol: "smtp", host: "127.0.0.1", port: noTlsPort, requireStartTls: true });
    expect(bad.status).toBe("down");
    expect(bad.message).toMatch(/STARTTLS/);
  });

  // Proves the SSH probe reads the server's identification line and matches it.
  it("SSH: reads the identification banner", async () => {
    const port = await tcpServer((sock) => sock.write("SSH-2.0-OpenSSH_9.6\r\n"));
    const r = await runProbe("protocol", { protocol: "ssh", host: "127.0.0.1", port, expect: "OpenSSH" });
    expect(r.status).toBe("up");
    expect(r.message).toBe("SSH-2.0-OpenSSH_9.6");
  });

  // Proves the IMAP/POP3/FTP greetings are recognised, and that an FTP
  // refusal code (421) counts as down.
  it("IMAP, POP3 and FTP greetings", async () => {
    const imap = await tcpServer((s) => s.write("* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n"));
    const pop = await tcpServer((s) => s.write("+OK POP3 ready\r\n"));
    const ftp = await tcpServer((s) => s.write("220 FTP ready\r\n"));
    const badFtp = await tcpServer((s) => s.write("421 Too many users\r\n"));
    expect((await runProbe("protocol", { protocol: "imap", host: "127.0.0.1", port: imap })).status).toBe("up");
    expect((await runProbe("protocol", { protocol: "pop3", host: "127.0.0.1", port: pop })).status).toBe("up");
    expect((await runProbe("protocol", { protocol: "ftp", host: "127.0.0.1", port: ftp })).status).toBe("up");
    expect((await runProbe("protocol", { protocol: "ftp", host: "127.0.0.1", port: badFtp })).status).toBe("down");
  });

  // Proves the LDAP probe sends a correctly encoded BindRequest with the
  // configured credentials, and reports a rejected bind (code 49) as down.
  it("LDAP: sends a real BindRequest and reads the resultCode", async () => {
    let received: Buffer | null = null;
    const respond = (code: number) =>
      tcpServer((sock) =>
        sock.on("data", (d) => {
          received = d;
          // LDAPMessage { messageID 1, BindResponse { resultCode, matchedDN "", diag "" } }
          sock.write(Buffer.from([0x30, 0x0c, 0x02, 0x01, 0x01, 0x61, 0x07, 0x0a, 0x01, code, 0x04, 0x00, 0x04, 0x00]));
        })
      );
    const okPort = await respond(0);
    const r = await runProbe("protocol", { protocol: "ldap", host: "127.0.0.1", port: okPort, bindDn: "cn=reader,dc=test", bindPassword: "pw" });
    expect(r.status).toBe("up");
    expect(received).toEqual(ldapBindRequest("cn=reader,dc=test", "pw"));
    const badPort = await respond(49);
    const bad = await runProbe("protocol", { protocol: "ldap", host: "127.0.0.1", port: badPort });
    expect(bad.status).toBe("down");
    expect(bad.message).toMatch(/invalid credentials/);
  });

  // Proves the RDP probe completes the first step of the RDP handshake
  // (X.224 Connection Request answered by a Connection Confirm, 0xD0).
  it("RDP: X.224 connection request gets a connection confirm", async () => {
    const port = await tcpServer((sock) =>
      sock.on("data", (d) => {
        if (d[0] === 0x03) sock.write(Buffer.from("0300001302f0801000000000020008000200000000", "hex").subarray(0, 11).fill(0xd0, 5, 6));
      })
    );
    expect((await runProbe("protocol", { protocol: "rdp", host: "127.0.0.1", port })).status).toBe("up");
  });
});

describe("NTP", () => {
  // Proves the NTP probe measures clock offset from a real SNTP reply (a
  // server 250 ms ahead) and warns above the configured threshold.
  it("computes offset and stratum from a real SNTP exchange", async () => {
    const port = await udpServer((msg, r, sock) => {
      const reply = Buffer.alloc(48);
      reply[0] = 0x24; // LI 0, v4, server
      reply[1] = 2; // stratum
      const nowNtp = Date.now() / 1000 + 2_208_988_800 + 0.25; // server is 250ms ahead
      const sec = Math.floor(nowNtp);
      const frac = Math.floor((nowNtp - sec) * 2 ** 32);
      // Receive (32) and transmit (40) timestamps, NTP's seconds + fraction format.
      for (const off of [32, 40]) {
        reply.writeUInt32BE(sec, off);
        reply.writeUInt32BE(frac, off + 4);
      }
      sock.send(reply, r.port, r.address);
    });
    const r = await runProbe("ntp", { host: "127.0.0.1", port, offsetWarnMs: 100 });
    expect(r.status).toBe("warn");
    expect(r.value!).toBeGreaterThan(150);
    expect(r.value!).toBeLessThan(400);
    expect((r.details as { stratum: number }).stratum).toBe(2);
  });
});

describe("DHCP", () => {
  // Proves the DHCP probe sends a DISCOVER the server accepts, reads the
  // OFFER, and reports "rogue" when the answering server isn't the one
  // expected — the check that spots an unauthorised DHCP server on a LAN.
  it("builds a valid DISCOVER and detects a rogue server via expectedServer", async () => {
    const serverPort = await udpServer((msg, rinfo, sock) => {
      const xid = msg.readUInt32BE(4);
      const offer = Buffer.alloc(240);
      offer[0] = 2; // BOOTREPLY
      offer.writeUInt32BE(xid, 4); // same transaction ID as the request
      Buffer.from([192, 168, 1, 50]).copy(offer, 16); // offered address
      offer.writeUInt32BE(0x63825363, 236); // DHCP magic cookie
      // Options: message type OFFER (53=2), server identifier 192.168.1.1 (54), end (255).
      sock.send(Buffer.concat([offer, Buffer.from([53, 1, 2, 54, 4, 192, 168, 1, 1, 255])]), rinfo.port, rinfo.address);
    });
    // The probe binds its own client port (68 in production); two free ports
    // from the OS, one per probe run, rather than guessed ones.
    const clientPort = await freeUdpPort();
    const good = await runProbe("dhcp", { server: "127.0.0.1", serverPort, clientPort, expectedServer: "192.168.1.1" });
    expect(good.status).toBe("up");
    expect(good.message).toMatch(/192\.168\.1\.50/);
    const rogue = await runProbe("dhcp", { server: "127.0.0.1", serverPort, clientPort: await freeUdpPort(), expectedServer: "192.168.1.254" });
    expect(rogue.status).toBe("down");
    expect(rogue.message).toMatch(/rogue/);
  });
  // Proves the DISCOVER carries the DHCP magic cookie, and that the OFFER
  // parser refuses a request packet (it only accepts replies).
  it("round-trips its own packet format", () => {
    const mac = Buffer.from([2, 1, 2, 3, 4, 5]);
    const pkt = buildDhcpDiscover(1234, mac);
    expect(pkt.readUInt32BE(236)).toBe(0x63825363);
    expect(parseDhcpOffer(pkt, 1234)).toBeNull(); // a request, not a reply
  });
});

describe("MQTT", () => {
  // Proves the MQTT probe sends a valid CONNECT (packet type 0x10, protocol
  // name "MQTT"), treats CONNACK code 0 as up, and reports a refusal
  // (code 5 = not authorised) as down.
  it("accepts CONNACK 0 and reports refusal codes", async () => {
    let lastConnect: Buffer | null = null;
    const broker = (rc: number) =>
      tcpServer((sock) =>
        sock.on("data", (d) => {
          lastConnect = d;
          sock.write(Buffer.from([0x20, 0x02, 0x00, rc])); // CONNACK with return code rc
        })
      );
    const ok = await broker(0);
    expect((await runProbe("mqtt", { host: "127.0.0.1", port: ok, username: "u", password: "p" })).status).toBe("up");
    expect(lastConnect![0]).toBe(0x10);
    expect(lastConnect!.includes(Buffer.from("MQTT"))).toBe(true);
    const denied = await broker(5);
    const r = await runProbe("mqtt", { host: "127.0.0.1", port: denied });
    expect(r.status).toBe("down");
    expect(r.message).toMatch(/not authorized/);
    expect(buildMqttConnect("id")[0]).toBe(0x10);
  });
});

describe("WebSocket", () => {
  let port: number;
  // An echo server that answers every message with "pong:<message>".
  beforeAll(async () => {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise((r) => wss.once("listening", r));
    port = (wss.address() as net.AddressInfo).port;
    wss.on("connection", (ws) => ws.on("message", (m) => ws.send(`pong:${m}`)));
    servers.push({ close: () => wss.close() });
  });
  // Proves the probe completes the WebSocket handshake, optionally sends a
  // message, and is down when the expected reply never arrives.
  it("handshakes, sends, and waits for the expected reply", async () => {
    expect((await runProbe("websocket", { url: `ws://127.0.0.1:${port}` })).status).toBe("up");
    expect((await runProbe("websocket", { url: `ws://127.0.0.1:${port}`, send: "ping", expectContains: "pong:ping" })).status).toBe("up");
    expect((await runProbe("websocket", { url: `ws://127.0.0.1:${port}`, send: "ping", expectContains: "never", timeoutSeconds: 1 })).status).toBe("down");
  });
});

describe("gRPC health", () => {
  let port: number;
  // A gRPC server implementing just the standard health-check method:
  // SERVING (1) for any service except "sick", which is NOT_SERVING (2).
  beforeAll(async () => {
    const server = new grpc.Server();
    server.register(
      "/grpc.health.v1.Health/Check",
      (call: grpc.ServerUnaryCall<{ service: string }, number>, cb: grpc.sendUnaryData<number>) => cb(null, call.request.service === "sick" ? 2 : 1),
      (n: number) => Buffer.from([0x08, n]),
      // Must return an object: grpc-js treats a falsy request as "no message".
      (b: Buffer) => ({ service: b.length > 2 ? b.subarray(2).toString() : "" }),
      "unary"
    );
    port = await new Promise((resolve, reject) => server.bindAsync("127.0.0.1:0", grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))));
    servers.push({ close: () => server.forceShutdown() });
  });
  // Proves the probe calls the standard health service and maps its answer.
  it("maps SERVING to up and NOT_SERVING to down", async () => {
    expect((await runProbe("grpc", { host: "127.0.0.1", port })).status).toBe("up");
    const sick = await runProbe("grpc", { host: "127.0.0.1", port, service: "sick" });
    expect(sick.status).toBe("down");
    expect(sick.message).toMatch(/NOT_SERVING/);
  });
});

describe("Docker registry", () => {
  let port: number;
  // A registry that demands a bearer token (like Docker Hub): /v2/ answers
  // 401 pointing at /token; with the token, one manifest exists.
  beforeAll(async () => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://x");
      if (url.pathname === "/token") {
        res.end(JSON.stringify({ token: "tkn" }));
        return;
      }
      if (url.pathname === "/v2/") {
        res.writeHead(401, { "WWW-Authenticate": `Bearer realm="http://127.0.0.1:${port}/token",service="reg"` });
        res.end();
        return;
      }
      if (req.headers.authorization !== "Bearer tkn") {
        res.writeHead(401, { "WWW-Authenticate": `Bearer realm="http://127.0.0.1:${port}/token",service="reg"` });
        res.end();
        return;
      }
      if (url.pathname === "/v2/library/app/manifests/1.0") {
        res.writeHead(200, { "Docker-Content-Digest": "sha256:abcdef0123456789abcdef" });
        res.end();
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    port = (srv.address() as net.AddressInfo).port;
    servers.push({ close: () => srv.close() });
  });
  // Proves the probe follows the token challenge, finds an existing image
  // tag, and reports a missing tag as down.
  it("follows the bearer-token challenge to check a manifest", async () => {
    expect((await runProbe("docker_registry", { url: `http://127.0.0.1:${port}` })).status).toBe("up");
    expect((await runProbe("docker_registry", { url: `http://127.0.0.1:${port}`, image: "library/app", tag: "1.0" })).status).toBe("up");
    const missing = await runProbe("docker_registry", { url: `http://127.0.0.1:${port}`, image: "library/app", tag: "9.9" });
    expect(missing.status).toBe("down");
  });
});

describe("DNS wire format", () => {
  // Proves the hand-built DNS query asks for DNSSEC validation (AD and the
  // EDNS DO bit) and that the reply parser reads the AD flag back.
  it("sets RD+AD and the EDNS DO bit, and reads AD back", () => {
    const q = buildDnsQuery("example.com", 1, 42);
    expect(q.readUInt16BE(0)).toBe(42);
    expect(q.readUInt16BE(2) & 0x0020).toBe(0x0020);
    expect(q.subarray(-11)[7]).toBe(0x80); // DO bit in the OPT TTL
    const reply = Buffer.from(q);
    reply.writeUInt16BE(0x81a0, 2); // QR RD RA AD
    expect(parseDnsFlags(reply)).toMatchObject({ ad: true, rcode: 0 });
  });
  /**
   * A fake resolver that answers A queries with 127.0.0.1. Only the probe's
   * own DNSSEC query sets the AD bit in the request, so `dnssecFlags`
   * applies to that query alone and the plain lookup always succeeds.
   *
   * @param dnssecFlags the header flags returned to the DNSSEC query
   *        (0x81a0 = validated, 0x8180 = not validated, 0x8182 = SERVFAIL)
   * @returns the fake resolver's port
   */
  function fakeResolver(dnssecFlags: number) {
    return udpServer((msg, r, sock) => {
      // Walk the question's name labels to find where the question ends.
      let q = 12;
      // Reviewed false positive: `msg` is a Buffer indexed by a number, not an
      // object indexed by a user-controlled key (reviewed 2026-10-14).
      // eslint-disable-next-line security/detect-object-injection
      while (msg[q] !== 0) q += msg[q] + 1;
      const question = msg.subarray(12, q + 5);
      const isDnssecQuery = (msg.readUInt16BE(2) & 0x0020) !== 0;
      const header = Buffer.alloc(12);
      header.writeUInt16BE(msg.readUInt16BE(0), 0);
      header.writeUInt16BE(isDnssecQuery ? dnssecFlags : 0x8180, 2);
      header.writeUInt16BE(1, 4);
      const rcode = (isDnssecQuery ? dnssecFlags : 0) & 0x0f;
      header.writeUInt16BE(rcode ? 0 : 1, 6);
      // One A record (name pointer to the question, type A, class IN, TTL 60, 127.0.0.1).
      const answer = rcode ? Buffer.alloc(0) : Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 60, 0, 4, 127, 0, 0, 1]);
      sock.send(Buffer.concat([header, question, answer]), r.port, r.address);
    });
  }

  // Proves the DNSSEC check: a validated answer is up, an unvalidated one is
  // down (so a resolver that stops validating is noticed), SERVFAIL is down.
  it("checks DNSSEC: AD set is up, no AD is down, SERVFAIL is down", async () => {
    const validated = await fakeResolver(0x81a0);
    const unsigned = await fakeResolver(0x8180);
    const bogus = await fakeResolver(0x8182);
    const probe = (port: number) => runProbe("dns", { hostname: "example.test", dnssec: true, server: `127.0.0.1:${port}` });
    const ok = await probe(validated);
    expect(ok.status).toBe("up");
    expect(ok.message).toBe("127.0.0.1");
    const noAd = await probe(unsigned);
    expect(noAd.status).toBe("down");
    expect(noAd.message).toMatch(/not DNSSEC-authenticated/);
    const fail = await probe(bogus);
    expect(fail.status).toBe("down");
    expect(fail.message).toMatch(/SERVFAIL/);
  });

  // Proves "expected value" catches a DNS answer that changed (e.g. hijacked
  // or misconfigured records).
  it("matches an expected answer value", async () => {
    const port = await fakeResolver(0x81a0);
    expect((await runProbe("dns", { hostname: "example.test", server: `127.0.0.1:${port}`, expectedValue: "127.0.0.1" })).status).toBe("up");
    expect((await runProbe("dns", { hostname: "example.test", server: `127.0.0.1:${port}`, expectedValue: "10.9.9.9" })).status).toBe("down");
  });
});

describe("parsers", () => {
  // Proves hop lists are read from both Unix traceroute and Windows tracert,
  // with timeouts kept as "*" so a path change is still detected.
  it("parses traceroute and tracert output", () => {
    expect(parseTraceroute(" 1  192.168.1.1  0.5 ms\n 2  *\n 3  1.1.1.1  9 ms")).toEqual(["192.168.1.1", "*", "1.1.1.1"]);
    expect(parseTraceroute("Tracing route to 1.1.1.1\n  1    <1 ms    <1 ms    <1 ms  10.0.0.1\n  2     *        *        *     Request timed out.\n  3     9 ms     8 ms     9 ms  1.1.1.1")).toEqual(["10.0.0.1", "*", "1.1.1.1"]);
  });
  // Proves IP→MAC tables are read from Linux `ip neigh`, Windows `arp -a`
  // and BSD/macOS `arp -a`, MACs are normalised to colons, and FAILED
  // entries (no MAC) are skipped.
  it("parses ip neigh, Windows arp -a, and BSD arp -a", () => {
    const t = parseArpTable(
      "192.168.1.1 dev eth0 lladdr aa:bb:cc:dd:ee:ff REACHABLE\n192.168.1.9 dev eth0  FAILED\n  10.0.0.5          00-11-22-33-44-55     dynamic\n? (172.16.0.2) at 0:1:2:3:4:5 on en0 ifscope [ethernet]"
    );
    expect(t.get("192.168.1.1")).toBe("aa:bb:cc:dd:ee:ff");
    expect(t.has("192.168.1.9")).toBe(false);
    expect(t.get("10.0.0.5")).toBe("00:11:22:33:44:55");
    expect(t.get("172.16.0.2")).toBe("0:1:2:3:4:5");
  });
});

describe("TCP port with send and expect", () => {
  // Proves the advanced TCP settings: a greeting banner is matched, a
  // command is sent and its reply matched, and a wrong or missing reply
  // fails within the timeout instead of passing just because it connected.
  it("matches banners and replies", async () => {
    const banner = await tcpServer((sock) => sock.write("220 mail.example ESMTP\r\n"));
    expect((await runProbe("tcp", { host: "127.0.0.1", port: banner, expectText: "ESMTP" })).status).toBe("up");
    const redis = await tcpServer((sock) => sock.on("data", (d) => sock.write(d.toString().startsWith("PING") ? "+PONG\r\n" : "-ERR\r\n")));
    const ok = await runProbe("tcp", { host: "127.0.0.1", port: redis, sendText: "PING\r\n", expectText: "+PONG" });
    expect(ok.status).toBe("up");
    expect(ok.message).toBe("+PONG");
    const silent = await tcpServer(() => undefined);
    const quiet = await runProbe("tcp", { host: "127.0.0.1", port: silent, expectText: "hello", timeoutSeconds: 1 });
    expect(quiet.status).toBe("down");
    expect(quiet.message).toMatch(/no reply containing "hello" within 1s/);
    expect((await runProbe("tcp", { host: "127.0.0.1", port: silent })).status).toBe("up");
  });
});
