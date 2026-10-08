import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import net from "node:net";
import * as snmp from "net-snmp";
import { runProbe } from "../src/services/prober.js";
import { parsePrometheus, labelMatcher } from "../src/services/probes/apps.js";
import { parseIpmiSdr, parseVimObjects } from "../src/services/probes/infra.js";
import { findChrome } from "../src/services/probes/services.js";

type Route = (req: http.IncomingMessage, url: URL, body: string) => { status?: number; headers?: Record<string, string>; body?: string } | undefined;
const closers: (() => void)[] = [];
afterAll(() => closers.forEach((c) => c()));

async function fakeHttp(route: Route): Promise<string> {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const out = route(req, new URL(req.url!, "http://x"), body) ?? { status: 404, body: "not found" };
      res.writeHead(out.status ?? 200, { "Content-Type": "application/json", ...(out.headers ?? {}) });
      res.end(out.body ?? "");
    });
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  closers.push(() => srv.close());
  return `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}`;
}

describe("HTTP extras", () => {
  let base: string;
  beforeAll(async () => {
    base = await fakeHttp((_req, url) => {
      if (url.pathname === "/json") return { body: JSON.stringify({ status: "ok", queue: { depth: 42 }, items: [{ name: "a" }] }) };
      if (url.pathname === "/hop1") return { status: 301, headers: { Location: "/hop2" } };
      if (url.pathname === "/hop2") return { status: 302, headers: { Location: "/final" } };
      if (url.pathname === "/final") return { body: "landed" };
      if (url.pathname === "/error-page") return { body: "<h1>Fatal ERROR occurred</h1>" };
      if (url.pathname === "/slow") return undefined;
      return { body: "hello world" };
    });
  });

  it("fails when forbidden text is present (bodyNotContains) and checks regex", async () => {
    expect((await runProbe("http", { url: `${base}/error-page`, bodyNotContains: "ERROR" })).status).toBe("down");
    expect((await runProbe("http", { url: `${base}/`, bodyNotContains: "ERROR" })).status).toBe("up");
    expect((await runProbe("http", { url: `${base}/`, bodyRegex: "hel+o\\s+w" })).status).toBe("up");
    expect((await runProbe("http", { url: `${base}/`, bodyRegex: "^goodbye" })).status).toBe("down");
  });

  it("evaluates a JSON path, and exposes numeric values to thresholds", async () => {
    const eq = await runProbe("http", { url: `${base}/json`, jsonPath: "$.status", jsonExpected: "ok" });
    expect(eq.status).toBe("up");
    const wrong = await runProbe("http", { url: `${base}/json`, jsonPath: "$.status", jsonExpected: "degraded" });
    expect(wrong.status).toBe("down");
    const depth = await runProbe("http", { url: `${base}/json`, jsonPath: "queue.depth", warnAbove: 40, criticalAbove: 100 });
    expect(depth.value).toBe(42);
    expect(depth.status).toBe("warn");
    expect((await runProbe("http", { url: `${base}/json`, jsonPath: "items[0].name", jsonOperator: "equals", jsonExpected: "a" })).status).toBe("up");
  });

  it("tracks the redirect chain, final URL, and status lists", async () => {
    const r = await runProbe("http", { url: `${base}/hop1`, expectedFinalUrl: `${base}/final` });
    expect(r.status).toBe("up");
    expect((r.details as { redirects: string[] }).redirects).toHaveLength(2);
    expect((await runProbe("http", { url: `${base}/hop1`, maxRedirectsAllowed: 1 })).status).toBe("warn");
    expect((await runProbe("http", { url: `${base}/hop1`, followRedirects: false, expectedStatus: "301" })).status).toBe("up");
    expect((await runProbe("http", { url: `${base}/hop1`, followRedirects: false, expectedStatus: "200-299" })).status).toBe("down");
    expect((await runProbe("http", { url: `${base}/hop1`, followRedirects: false, expectedStatus: "3xx" })).status).toBe("up");
  });

  it("applies latency thresholds to any check", async () => {
    const srv = http.createServer((_req, res) => setTimeout(() => res.end("slow"), 150));
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    closers.push(() => srv.close());
    const url = `http://127.0.0.1:${(srv.address() as net.AddressInfo).port}/`;
    const w = await runProbe("http", { url, latencyWarnMs: 50, latencyCriticalMs: 5000 });
    expect(w.status).toBe("warn");
    expect(w.message).toMatch(/warn over 50ms/);
    expect((await runProbe("http", { url, latencyWarnMs: 20, latencyCriticalMs: 60 })).status).toBe("down");
  });
});

describe("Prometheus scrape", () => {
  let base: string;
  let counter = 1000;
  beforeAll(async () => {
    base = await fakeHttp(() => {
      counter += 500;
      return {
        headers: { "Content-Type": "text/plain" },
        body: `# HELP node_filesystem_avail_bytes x\nnode_filesystem_avail_bytes{mountpoint="/",fstype="ext4"} 5e9\nnode_filesystem_avail_bytes{mountpoint="/boot",fstype="vfat"} 2e8\nhttp_requests_total{code="200"} ${counter}\nhttp_requests_total{code="500"} 3\n`,
      };
    });
  });
  it("parses exposition format and label matchers", () => {
    const s = parsePrometheus('a{x="1",y="two"} 3\n# comment\nb 4.5 1700000000\n');
    expect(s).toEqual([
      { name: "a", labels: { x: "1", y: "two" }, value: 3 },
      { name: "b", labels: {}, value: 4.5 },
    ]);
    expect(labelMatcher('code=~"5..", job!=x')({ code: "503", job: "y" })).toBe(true);
  });
  it("aggregates matching series and applies thresholds", async () => {
    const r = await runProbe("prometheus", { url: base, metric: "node_filesystem_avail_bytes", labels: 'mountpoint="/"', aggregation: "min", warnBelow: 1e10 });
    expect(r.value).toBe(5e9);
    expect(r.status).toBe("warn");
  });
  it("turns a counter into a rate using the previous run's state", async () => {
    const first = await runProbe("prometheus", { url: base, metric: "http_requests_total", labels: 'code="200"', rate: true });
    expect(first.skip).toBe(true);
    await new Promise((r) => setTimeout(r, 200));
    const second = await runProbe("prometheus", { url: base, metric: "http_requests_total", labels: 'code="200"', rate: true }, { state: first.state! });
    expect(second.value!).toBeGreaterThan(0);
  });
});

describe("web server status pages", () => {
  it("parses nginx stub_status and Apache ?auto", async () => {
    let n = 100;
    const base = await fakeHttp((_req, url) => {
      if (url.pathname === "/nginx") {
        n += 50;
        return { headers: { "Content-Type": "text/plain" }, body: `Active connections: 7 \nserver accepts handled requests\n 10 10 ${n} \nReading: 0 Writing: 1 Waiting: 6 \n` };
      }
      if (url.pathname === "/server-status") return { headers: { "Content-Type": "text/plain" }, body: "Total Accesses: 500\nBusyWorkers: 3\nIdleWorkers: 7\n" };
      return undefined;
    });
    const ng = await runProbe("webserver_status", { kind: "nginx", url: `${base}/nginx`, metric: "active_connections", warnAbove: 5 });
    expect(ng.value).toBe(7);
    expect(ng.status).toBe("warn");
    const ap = await runProbe("webserver_status", { kind: "apache", url: `${base}/server-status`, metric: "busy_percent" });
    expect(ap.value).toBe(30);
  });
});

describe("app integrations", () => {
  it("Nextcloud: maintenance mode warns; serverinfo metrics read", async () => {
    let maintenance = false;
    const base = await fakeHttp((req, url) => {
      if (url.pathname === "/status.php") return { body: JSON.stringify({ installed: true, maintenance, needsDbUpgrade: false, versionstring: "30.0.1" }) };
      if (url.pathname.includes("serverinfo") && req.headers["nc-token"] === "tok")
        return { body: JSON.stringify({ ocs: { data: { nextcloud: { system: { freespace: 12e9, apps: { num_updates_available: 2 } } }, activeUsers: { last5minutes: 3 } } } }) };
      return { status: 401 };
    });
    expect((await runProbe("app_integration", { app: "nextcloud", url: base })).status).toBe("up");
    const free = await runProbe("app_integration", { app: "nextcloud", url: base, token: "tok", metric: "free_space_gb", warnBelow: 20 });
    expect(free.value).toBe(12);
    expect(free.status).toBe("warn");
    maintenance = true;
    expect((await runProbe("app_integration", { app: "nextcloud", url: base })).status).toBe("warn");
  });

  it("Home Assistant: entity state and unavailable entities", async () => {
    const base = await fakeHttp((req, url) => {
      if (req.headers.authorization !== "Bearer ha") return { status: 401 };
      if (url.pathname === "/api/") return { body: JSON.stringify({ message: "API running." }) };
      if (url.pathname === "/api/states/sensor.temp") return { body: JSON.stringify({ state: "21.5", attributes: { unit_of_measurement: "°C" } }) };
      if (url.pathname === "/api/states/switch.pump") return { body: JSON.stringify({ state: "unavailable", attributes: {} }) };
      return undefined;
    });
    const t = await runProbe("app_integration", { app: "home_assistant", url: base, token: "ha", entityId: "sensor.temp", criticalAbove: 30 });
    expect(t.value).toBe(21.5);
    expect(t.status).toBe("up");
    expect((await runProbe("app_integration", { app: "home_assistant", url: base, token: "ha", entityId: "switch.pump" })).status).toBe("down");
    expect((await runProbe("app_integration", { app: "home_assistant", url: base, token: "wrong" })).status).toBe("down");
  });

  it("Pi-hole v6: blocking disabled is down", async () => {
    let blocking = "enabled";
    const base = await fakeHttp((req, url, body) => {
      if (url.pathname === "/api/auth" && JSON.parse(body || "{}").password === "pw") return { body: JSON.stringify({ session: { sid: "s1" } }) };
      if (req.headers.sid !== "s1") return { status: 401 };
      if (url.pathname === "/api/dns/blocking") return { body: JSON.stringify({ blocking }) };
      if (url.pathname === "/api/stats/summary") return { body: JSON.stringify({ queries: { total: 1000, percent_blocked: 12.5 }, gravity: { domains_being_blocked: 90000 } }) };
      return undefined;
    });
    const ok = await runProbe("app_integration", { app: "pihole", url: base, token: "pw", metric: "percent_blocked" });
    expect(ok.status).toBe("up");
    expect(ok.value).toBe(12.5);
    blocking = "disabled";
    expect((await runProbe("app_integration", { app: "pihole", url: base, token: "pw" })).status).toBe("down");
  });
});

describe("infrastructure APIs", () => {
  it("Redfish: rolls up system, temperature, fan and PSU health", async () => {
    let fanHealth = "OK";
    const base = await fakeHttp((req, url) => {
      if (req.headers.authorization !== `Basic ${Buffer.from("root:calvin").toString("base64")}`) return { status: 401 };
      const map: Record<string, unknown> = {
        "/redfish/v1/Systems": { Members: [{ "@odata.id": "/redfish/v1/Systems/1" }] },
        "/redfish/v1/Systems/1": { Id: "1", PowerState: "On", Status: { Health: "OK", HealthRollup: "OK" } },
        "/redfish/v1/Chassis": { Members: [{ "@odata.id": "/redfish/v1/Chassis/1" }] },
        "/redfish/v1/Chassis/1": { Thermal: { "@odata.id": "/redfish/v1/Chassis/1/Thermal" }, Power: { "@odata.id": "/redfish/v1/Chassis/1/Power" } },
        "/redfish/v1/Chassis/1/Thermal": { Temperatures: [{ Name: "CPU1", ReadingCelsius: 55, Status: { Health: "OK", State: "Enabled" } }], Fans: [{ Name: "Fan1", Reading: 5400, Status: { Health: fanHealth, State: "Enabled" } }] },
        "/redfish/v1/Chassis/1/Power": { PowerSupplies: [{ Name: "PSU1", Status: { Health: "OK", State: "Enabled" } }] },
      };
      const body = map[url.pathname];
      return body ? { body: JSON.stringify(body) } : undefined;
    });
    const ok = await runProbe("bmc", { protocol: "redfish", url: base, username: "root", password: "calvin" });
    expect(ok.status).toBe("up");
    expect(ok.value).toBe(55);
    fanHealth = "Critical";
    const bad = await runProbe("bmc", { protocol: "redfish", url: base, username: "root", password: "calvin" });
    expect(bad.status).toBe("down");
    expect(bad.message).toMatch(/Fan1: Critical/);
  });

  it("parses ipmitool sdr and vSphere property replies", () => {
    expect(parseIpmiSdr("Fan1 | 30h | ok | 29.1 | 5400 RPM\nPS2 Status | 71h | cr | 10.2 | Failure detected")).toEqual([
      { name: "Fan1", status: "ok", reading: "5400 RPM" },
      { name: "PS2 Status", status: "cr", reading: "Failure detected" },
    ]);
    const xml = `<returnval><objects><obj type="VirtualMachine">vm-1</obj><propSet><name>name</name><val xsi:type="xsd:string">web01</val></propSet><propSet><name>runtime.powerState</name><val xsi:type="VirtualMachinePowerState">poweredOff</val></propSet></objects></returnval>`;
    expect(parseVimObjects(xml)).toEqual([{ moref: "vm-1", props: { name: "web01", "runtime.powerState": "poweredOff" } }]);
  });

  it("Proxmox: token header, guests, storage and backup task age", async () => {
    const now = Math.floor(Date.now() / 1000);
    const base = await fakeHttp((req, url) => {
      if (req.headers.authorization !== "PVEAPIToken=mon@pve!looksee=secret") return { status: 401 };
      const routes: Record<string, unknown> = {
        "/api2/json/nodes": [{ node: "pve1", status: "online", cpu: 0.12, mem: 4e9, maxmem: 16e9, uptime: 1000 }],
        "/api2/json/cluster/resources": url.searchParams.get("type") === "storage" ? [{ storage: "local-zfs", node: "pve1", disk: 900, maxdisk: 1000, status: "available" }] : [{ vmid: 101, name: "web", status: "running", node: "pve1", type: "qemu" }, { vmid: 102, name: "old", status: "stopped", node: "pve1", type: "lxc" }],
        "/api2/json/cluster/tasks": [{ type: "vzdump", status: "OK", starttime: now - 7300, endtime: now - 7200, id: "", node: "pve1" }],
      };
      const body = routes[url.pathname];
      return body ? { body: JSON.stringify({ data: body }) } : undefined;
    });
    const auth = { url: base, tokenId: "mon@pve!looksee", tokenSecret: "secret" };
    expect((await runProbe("proxmox", { ...auth, target: "node", name: "pve1", metric: "memory_percent" })).value).toBe(25);
    expect((await runProbe("proxmox", { ...auth, target: "vm", name: "102" })).status).toBe("down");
    expect((await runProbe("proxmox", { ...auth, target: "vm", name: "*" })).value).toBe(1);
    expect((await runProbe("proxmox", { ...auth, target: "storage", criticalAbove: 85 })).status).toBe("down");
    const backups = await runProbe("proxmox", { ...auth, target: "backups", maxAgeHours: 1 });
    expect(backups.status).toBe("down");
    expect((await runProbe("proxmox", { ...auth, target: "backups", maxAgeHours: 26 })).status).toBe("up");
    expect((await runProbe("proxmox", { ...auth, tokenSecret: "nope", target: "node" })).status).toBe("down");
  });

  it("domain expiry via an RDAP server", async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString();
    const base = await fakeHttp((_req, url) => {
      if (url.pathname === "/domain/example.test") return { body: JSON.stringify({ events: [{ eventAction: "expiration", eventDate: soon }] }) };
      return { status: 404 };
    });
    const r = await runProbe("domain_expiry", { domain: "example.test", rdapServer: base, warnDays: 30, criticalDays: 7 });
    expect(r.status).toBe("warn");
    expect(r.value).toBe(9);
    expect((await runProbe("domain_expiry", { domain: "nope.test", rdapServer: base })).status).toBe("down");
  });

  it("public IP: change detection held as warn", async () => {
    let ip = "203.0.113.5";
    const base = await fakeHttp(() => ({ headers: { "Content-Type": "text/plain" }, body: ip }));
    const first = await runProbe("public_ip", { url: base });
    expect(first.status).toBe("up");
    ip = "203.0.113.9";
    const second = await runProbe("public_ip", { url: base }, { state: first.state! });
    expect(second.status).toBe("warn");
    expect(second.message).toMatch(/203\.0\.113\.5 → 203\.0\.113\.9/);
  });
});

describe("SNMP against an in-process agent", () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  let agent: { close: () => void; getMib: () => any; getAuthorizer: () => any };
  let uptime = 500000;
  beforeAll(() => {
    agent = snmp.createAgent({ port, disableAuthorization: true, address: "127.0.0.1" }, () => undefined);
    agent.getAuthorizer().addCommunity("public");
    const mib = agent.getMib();
    const RO = snmp.MaxAccess["read-only"];
    mib.registerProvider({
      name: "sysUpTime",
      type: snmp.MibProviderType.Scalar,
      oid: "1.3.6.1.2.1.1.3",
      scalarType: snmp.ObjectType.TimeTicks,
      maxAccess: RO,
      handler: (r: any) => {
        r.instanceNode.value = uptime;
        r.done();
      },
    });
    mib.setScalarValue("sysUpTime", uptime);
    mib.registerProvider({
      name: "ifTable",
      type: snmp.MibProviderType.Table,
      oid: "1.3.6.1.2.1.2.2.1",
      maxAccess: snmp.MaxAccess["not-accessible"],
      tableColumns: [
        { number: 1, name: "ifIndex", type: snmp.ObjectType.Integer, maxAccess: RO },
        { number: 2, name: "ifDescr", type: snmp.ObjectType.OctetString, maxAccess: RO },
        { number: 5, name: "ifSpeed", type: snmp.ObjectType.Gauge, maxAccess: RO },
        { number: 7, name: "ifAdminStatus", type: snmp.ObjectType.Integer, maxAccess: RO },
        { number: 8, name: "ifOperStatus", type: snmp.ObjectType.Integer, maxAccess: RO },
        { number: 10, name: "ifInOctets", type: snmp.ObjectType.Counter, maxAccess: RO },
        { number: 16, name: "ifOutOctets", type: snmp.ObjectType.Counter, maxAccess: RO },
      ],
      tableIndex: [{ columnName: "ifIndex" }],
    });
    mib.addTableRow("ifTable", [1, "port1", 1000000000, 1, 1, 1000, 2000]);
    mib.addTableRow("ifTable", [2, "port2", 1000000000, 1, 2, 0, 0]);
    mib.addTableRow("ifTable", [3, "port3-disabled", 1000000000, 2, 2, 0, 0]);
    mib.registerProvider({
      name: "prtMarkerSupplies",
      type: snmp.MibProviderType.Table,
      oid: "1.3.6.1.2.1.43.11.1.1",
      maxAccess: snmp.MaxAccess["not-accessible"],
      tableColumns: [
        { number: 1, name: "idx", type: snmp.ObjectType.Integer, maxAccess: RO },
        { number: 6, name: "desc", type: snmp.ObjectType.OctetString, maxAccess: RO },
        { number: 8, name: "max", type: snmp.ObjectType.Integer, maxAccess: RO },
        { number: 9, name: "level", type: snmp.ObjectType.Integer, maxAccess: RO },
      ],
      tableIndex: [{ columnName: "idx" }],
    });
    mib.addTableRow("prtMarkerSupplies", [1, "Black Toner", 100, 8]);
    mib.addTableRow("prtMarkerSupplies", [2, "Cyan Toner", 100, 60]);
    closers.push(() => agent.close());
  });

  const base = () => ({ host: "127.0.0.1", port, version: "2c", community: "public" });

  it("reads a single OID with thresholds", async () => {
    const r = await runProbe("snmp", { ...base(), oid: "1.3.6.1.2.1.2.2.1.5.1", scale: 1e-6, warnBelow: 10000 });
    expect(r.value).toBe(1000);
    expect(r.status).toBe("warn");
  });

  it("aggregates a walk", async () => {
    expect((await runProbe("snmp", { ...base(), oid: "1.3.6.1.2.1.2.2.1.8", mode: "walk_count" })).value).toBe(3);
  });

  it("printer_supplies preset finds the lowest supply", async () => {
    const r = await runProbe("snmp", { ...base(), preset: "printer_supplies", warnBelow: 15 });
    expect(r.value).toBe(8);
    expect(r.status).toBe("warn");
    expect(r.message).toMatch(/Black Toner 8%/);
  });

  it("uptime_reboot preset detects sysUpTime going backwards", async () => {
    const first = await runProbe("snmp", { ...base(), preset: "uptime_reboot" });
    expect(first.status).toBe("up");
    uptime = 100;
    agent.getMib().setScalarValue("sysUpTime", uptime);
    const second = await runProbe("snmp", { ...base(), preset: "uptime_reboot" }, { state: first.state! });
    expect(second.status).toBe("warn");
    expect(second.message).toMatch(/rebooted/);
  });

  it("interface table: oper-down ports whose admin status is up fail; admin-down ports are ignored", async () => {
    const r = await runProbe("snmp_interfaces", { ...base() });
    expect(r.status).toBe("down");
    expect(r.message).toMatch(/1 port\(s\) down: port2/);
    const filtered = await runProbe("snmp_interfaces", { ...base(), interfaceFilter: "^port1$" });
    expect(filtered.status).toBe("up");
    expect((filtered.details as unknown[]).length).toBe(1);
  });

  it("rejects an unsupported SNMPv3 protocol instead of silently using SHA-1", async () => {
    const r = await runProbe("snmp", { host: "127.0.0.1", port, version: "3", username: "u", authProtocol: "sha999", oid: "1.3.6.1.2.1.1.3.0" });
    expect(r.status).toBe("down");
    expect(r.message).toMatch(/Unsupported SNMPv3 auth protocol/);
  });
});

describe("database probes (real Postgres)", () => {
  const url = new URL(process.env.DATABASE_URL ?? "postgres://looksee:looksee@localhost:5432/looksee");
  const cfg = { engine: "postgres", host: url.hostname, port: Number(url.port), username: decodeURIComponent(url.username), password: decodeURIComponent(url.password), database: url.pathname.slice(1) };
  it("connects, reads a query value, and reads server stats", async () => {
    expect((await runProbe("database", cfg)).status).toBe("up");
    expect((await runProbe("database", { ...cfg, metric: "query_value", query: "SELECT 41 + 1" })).value).toBe(42);
    const conns = await runProbe("database", { ...cfg, metric: "connections_percent" });
    expect(conns.status).toBe("up");
    expect(conns.value!).toBeGreaterThan(0);
    expect((await runProbe("database", { ...cfg, metric: "database_size_mb" })).value!).toBeGreaterThan(1);
    expect((await runProbe("database", { ...cfg, metric: "replication_lag_seconds" })).value).toBe(0);
  });
  it("reports bad credentials as down", async () => {
    expect((await runProbe("database", { ...cfg, password: "wrong-password" })).status).toBe("down");
  });
});

describe("headless browser", () => {
  it.skipIf(!findChrome())("renders a page, waits for an element, and catches JavaScript errors", async () => {
    const base = await fakeHttp((_req, url) => {
      const html = url.pathname === "/broken" ? "<html><body><h1>Hi</h1><script>undefinedFunction()</script></body></html>" : '<html><head><title>Fake App</title></head><body><div id="app"></div><script>document.getElementById("app").innerText = "Rendered by JS"</script></body></html>';
      return { headers: { "Content-Type": "text/html" }, body: html };
    });
    const ok = await runProbe("browser", { url: `${base}/`, waitForSelector: "#app", expectText: "Rendered by JS" });
    expect(ok.status).toBe("up");
    expect(ok.message).toMatch(/Fake App/);
    const broken = await runProbe("browser", { url: `${base}/broken` });
    expect(broken.status).toBe("warn");
    expect(broken.message).toMatch(/JavaScript error/);
  }, 60_000);
});
