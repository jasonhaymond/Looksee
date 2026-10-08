import net from "node:net";
import dns from "node:dns/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as snmp from "net-snmp";
import { parseArpTable } from "./probes/protocols.js";

// The network side of discovery, with no database access, so a site
// collector runs the identical scan on its own LAN.

const execFileAsync = promisify(execFile);

// Ports that identify what a device is and which checks make sense for it.
export const DISCOVERY_PORTS: Record<number, string> = {
  22: "ssh",
  53: "dns",
  80: "http",
  443: "https",
  445: "smb",
  631: "ipp",
  3306: "mysql",
  3389: "rdp",
  5432: "postgres",
  8006: "proxmox",
  8080: "http-alt",
  8443: "https-alt",
  9100: "printer",
};

export const MAX_SCAN_ADDRESSES = 1024;

export function expandCidr(cidr: string): string[] {
  const m = cidr.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (!m) throw new Error("Use IPv4 CIDR notation, e.g. 192.168.1.0/24");
  const bits = Number(m[2]);
  if (bits < 22 || bits > 32) throw new Error("Scan ranges are limited to /22 (1024 addresses) or smaller");
  const base = m[1].split(".").map(Number).reduce((a, o) => a * 256 + o, 0);
  const size = 2 ** (32 - bits);
  const start = Math.floor(base / size) * size;
  const toIp = (n: number) => [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
  if (size <= 2) return Array.from({ length: size }, (_, i) => toIp(start + i));
  return Array.from({ length: size - 2 }, (_, i) => toIp(start + i + 1));
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]);
    })
  );
}

function tcpOpen(host: string, port: number, timeoutMs = 700): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function pingOnce(host: string): Promise<boolean> {
  const args = process.platform === "win32" ? ["-n", "1", "-w", "800", host] : ["-c", "1", "-W", "1", host];
  try {
    const { stdout } = await execFileAsync("ping", args, { timeout: 4000 });
    return /time[=<]/i.test(stdout);
  } catch {
    return false;
  }
}

function snmpSysInfo(host: string, community: string): Promise<{ sysName?: string; sysDescr?: string } | null> {
  return new Promise((resolve) => {
    const session = snmp.createSession(host, community, { timeout: 1200, retries: 0, version: snmp.Version2c });
    session.on("error", () => undefined);
    session.get(["1.3.6.1.2.1.1.5.0", "1.3.6.1.2.1.1.1.0"], (err, vbs) => {
      session.close();
      if (err || !vbs) return resolve(null);
      const val = (i: number) => (vbs[i] && !snmp.isVarbindError(vbs[i]) ? String(vbs[i].value) : undefined);
      resolve({ sysName: val(0), sysDescr: val(1)?.slice(0, 200) });
    });
  });
}

export type ScannedDevice = {
  ip: string;
  hostname: string | null;
  mac: string | null;
  pingable: boolean;
  openPorts: { port: number; service: string }[];
  snmp: { sysName?: string; sysDescr?: string } | null;
};

export type DiscoveredDevice = ScannedDevice & {
  knownHostId: string | null;
  suggestedChecks: { type: string; name: string; config: Record<string, unknown> }[];
};

export function suggestForDevice(d: ScannedDevice): DiscoveredDevice["suggestedChecks"] {
  const label = d.hostname ?? d.snmp?.sysName ?? d.ip;
  const ports = new Set(d.openPorts.map((p) => p.port));
  const out: DiscoveredDevice["suggestedChecks"] = [];
  if (d.pingable) out.push({ type: "ping", name: `${label} ping`, config: { host: d.ip, count: 3 } });
  else if (d.mac) out.push({ type: "arp_presence", name: `${label} present`, config: { ip: d.ip, mac: d.mac } });
  if (ports.has(443)) {
    out.push({ type: "http", name: `${label} HTTPS`, config: { url: `https://${d.hostname ?? d.ip}/`, insecureSkipVerify: true } });
    if (d.hostname) out.push({ type: "ssl_cert", name: `${label} certificate`, config: { host: d.hostname, port: 443, warnDays: 14 } });
  } else if (ports.has(80)) out.push({ type: "http", name: `${label} HTTP`, config: { url: `http://${d.ip}/` } });
  if (ports.has(22)) out.push({ type: "protocol", name: `${label} SSH`, config: { protocol: "ssh", host: d.ip, port: 22 } });
  if (ports.has(3389)) out.push({ type: "protocol", name: `${label} RDP`, config: { protocol: "rdp", host: d.ip, port: 3389 } });
  if (ports.has(53)) out.push({ type: "dns", name: `${label} DNS`, config: { hostname: "example.com", server: d.ip } });
  if (ports.has(5432) || ports.has(3306)) out.push({ type: "tcp", name: `${label} database port`, config: { host: d.ip, port: ports.has(5432) ? 5432 : 3306 } });
  if (ports.has(8006)) out.push({ type: "proxmox", name: `${label} Proxmox node`, config: { url: `https://${d.ip}:8006`, target: "node", insecureSkipVerify: true } });
  if (d.snmp) {
    out.push({ type: "snmp_interfaces", name: `${label} interfaces`, config: { host: d.ip, version: "2c", community: "public", alertOnOperDown: true } });
    out.push({ type: "snmp", name: `${label} reboot`, config: { host: d.ip, version: "2c", community: "public", preset: "uptime_reboot" } });
    if (ports.has(9100) || ports.has(631) || /printer|laserjet|officejet|brother|epson|canon|xerox|ricoh/i.test(d.snmp.sysDescr ?? "")) {
      out.push({ type: "snmp", name: `${label} toner/ink`, config: { host: d.ip, version: "2c", community: "public", preset: "printer_supplies", warnBelow: 15, criticalBelow: 5 } });
    }
  }
  return out;
}

// H7: sweep a subnet (ping + a short TCP port list, since plenty of devices
// drop ping), then enrich responders with reverse DNS, ARP MAC, and SNMP
// sysName/sysDescr. onProgress receives the partial list as devices turn up.
export async function scanNetwork(cidr: string, community: string, onProgress: (found: ScannedDevice[]) => Promise<void> | void): Promise<ScannedDevice[]> {
  const addresses = expandCidr(cidr);
  const found = new Map<string, ScannedDevice>();
  let lastFlush = Date.now();
  await pool(addresses, 64, async (ip) => {
    const [pingable, ...open] = await Promise.all([pingOnce(ip), ...Object.keys(DISCOVERY_PORTS).map((p) => tcpOpen(ip, Number(p)))]);
    const openPorts = Object.entries(DISCOVERY_PORTS)
      .filter((_, i) => open[i])
      .map(([port, service]) => ({ port: Number(port), service }));
    if (!pingable && !openPorts.length) return;
    found.set(ip, { ip, hostname: null, mac: null, pingable, openPorts, snmp: null });
    if (Date.now() - lastFlush >= 2000) {
      lastFlush = Date.now();
      await onProgress([...found.values()]);
    }
  });
  let arp = new Map<string, string>();
  try {
    arp = parseArpTable((await execFileAsync(process.platform === "linux" ? "ip" : "arp", process.platform === "linux" ? ["neigh", "show"] : ["-a"])).stdout);
  } catch {
    // ARP enrichment is best-effort
  }
  await pool([...found.values()], 32, async (d) => {
    d.hostname = (await dns.reverse(d.ip).catch(() => []))[0] ?? null;
    d.mac = arp.get(d.ip) ?? null;
    d.snmp = await snmpSysInfo(d.ip, community);
  });
  return [...found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}
