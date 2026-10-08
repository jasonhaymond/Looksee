import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { worst, type Status } from "../thresholds.js";
import { type Config, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { httpRequest } from "./http.js";

const execFileAsync = promisify(execFile);

const healthStatus = (h: string | undefined): Status => (h === "Critical" ? "down" : h === "Warning" ? "warn" : "up");

// H8. Redfish is the modern BMC API (iDRAC 8+, iLO 4+, Supermicro X10+,
// OpenBMC); IPMI-over-LAN via ipmitool covers older boards.
export async function probeBmc(config: Config): Promise<ProbeOutcome> {
  return str(config, "protocol", "redfish") === "ipmi" ? probeIpmi(config) : probeRedfish(config);
}

async function probeRedfish(config: Config): Promise<ProbeOutcome> {
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (str(config, "username")) headers.Authorization = `Basic ${Buffer.from(`${str(config, "username")}:${str(config, "password")}`).toString("base64")}`;
  const insecure = bool(config, "insecureSkipVerify", true);
  const start = Date.now();
  const get = async (path: string) => {
    const res = await httpRequest(path.startsWith("http") ? path : `${base}${path}`, { headers, insecure, timeoutMs: 15_000 });
    if (res.status === 401) throw new Error("Redfish authentication failed (HTTP 401)");
    if (res.status !== 200) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    return JSON.parse(res.body) as Record<string, any>;
  };
  try {
    let status: Status = "up";
    const problems: string[] = [];
    const temps: { name: string; c: number; health?: string }[] = [];
    const fans: { name: string; reading: number | null; health?: string }[] = [];
    const psus: { name: string; health?: string }[] = [];
    const flag = (health: string | undefined, what: string) => {
      const s = healthStatus(health);
      if (s !== "up") {
        status = worst(status, s);
        problems.push(`${what}: ${health}`);
      }
    };
    const systems = await get("/redfish/v1/Systems");
    for (const m of systems.Members ?? []) {
      const sys = await get(m["@odata.id"]);
      flag(sys.Status?.HealthRollup ?? sys.Status?.Health, `System ${sys.Id ?? ""}`.trim());
      if (bool(config, "requirePoweredOn", true) && sys.PowerState && sys.PowerState !== "On") {
        status = "down";
        problems.push(`System power is ${sys.PowerState}`);
      }
    }
    const chassis = await get("/redfish/v1/Chassis");
    for (const m of chassis.Members ?? []) {
      const ch = await get(m["@odata.id"]);
      if (ch.Thermal?.["@odata.id"]) {
        const thermal = await get(ch.Thermal["@odata.id"]).catch(() => null);
        for (const t of thermal?.Temperatures ?? []) {
          if (t.ReadingCelsius == null || t.Status?.State === "Absent") continue;
          temps.push({ name: t.Name, c: t.ReadingCelsius, health: t.Status?.Health });
          flag(t.Status?.Health, t.Name);
        }
        for (const f of thermal?.Fans ?? []) {
          if (f.Status?.State === "Absent") continue;
          fans.push({ name: f.Name ?? f.FanName, reading: f.Reading ?? null, health: f.Status?.Health });
          flag(f.Status?.Health, f.Name ?? f.FanName);
        }
      }
      if (ch.Power?.["@odata.id"]) {
        const power = await get(ch.Power["@odata.id"]).catch(() => null);
        for (const p of power?.PowerSupplies ?? []) {
          if (p.Status?.State === "Absent") continue;
          psus.push({ name: p.Name, health: p.Status?.Health });
          flag(p.Status?.Health, p.Name);
        }
      }
    }
    const maxTemp = temps.length ? Math.max(...temps.map((t) => t.c)) : null;
    const latencyMs = Date.now() - start;
    const summary = `${temps.length} temps (max ${maxTemp ?? "n/a"}°C), ${fans.length} fans, ${psus.length} PSUs`;
    return { status, latencyMs, message: problems.length ? problems.join("; ") : `All healthy — ${summary}`, value: maxTemp, details: { temps, fans, psus } };
  } catch (err) {
    return down(errMsg(err));
  }
}

// `ipmitool sdr elist` rows: "Fan1 | 30h | ok | 29.1 | 5400 RPM". The
// password travels via the IPMI_PASSWORD env var (-E), never argv.
export function parseIpmiSdr(output: string) {
  const sensors: { name: string; status: string; reading: string }[] = [];
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 5) continue;
    sensors.push({ name: parts[0], status: parts[2], reading: parts[4] });
  }
  return sensors;
}

async function probeIpmi(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  if (!host) return warn("Missing host");
  const start = Date.now();
  try {
    const { stdout } = await execFileAsync("ipmitool", ["-I", "lanplus", "-H", host, "-U", str(config, "username"), "-E", "sdr", "elist"], {
      env: { ...process.env, IPMI_PASSWORD: str(config, "password") },
      timeout: 30_000,
    });
    const sensors = parseIpmiSdr(stdout);
    if (!sensors.length) return warn("ipmitool returned no sensors");
    // ok = fine, ns = no reading (absent), nc/cr/nr = non-critical/critical/non-recoverable.
    const bad = sensors.filter((s) => !["ok", "ns"].includes(s.status));
    const critical = bad.filter((s) => ["cr", "nr"].includes(s.status));
    const temps = sensors.map((s) => s.reading.match(/([\d.]+) degrees C/)?.[1]).filter(Boolean).map(Number);
    const maxTemp = temps.length ? Math.max(...temps) : null;
    const latencyMs = Date.now() - start;
    const status: Status = critical.length ? "down" : bad.length ? "warn" : "up";
    return { status, latencyMs, message: bad.length ? bad.map((s) => `${s.name}: ${s.status} (${s.reading})`).slice(0, 5).join("; ") : `${sensors.length} sensors OK, max ${maxTemp ?? "n/a"}°C`, value: maxTemp, details: sensors };
  } catch (err) {
    const e = err as { code?: string };
    if (e.code === "ENOENT") return warn("ipmitool isn't installed on the engine host (apt install ipmitool)");
    return down(errMsg(err));
  }
}

// I2. API token auth (Datacenter → Permissions → API Tokens); a read-only
// PVEAuditor role is enough for everything here.
export async function probeProxmox(config: Config): Promise<ProbeOutcome> {
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  const headers = { Authorization: `PVEAPIToken=${str(config, "tokenId")}=${str(config, "tokenSecret")}` };
  const insecure = bool(config, "insecureSkipVerify", true);
  const start = Date.now();
  const get = async (path: string) => {
    const res = await httpRequest(`${base}/api2/json${path}`, { headers, insecure, timeoutMs: 15_000 });
    if (res.status === 401) throw new Error("Proxmox rejected the API token (HTTP 401)");
    if (res.status !== 200) throw new Error(`GET ${path} returned HTTP ${res.status}`);
    return (JSON.parse(res.body) as { data: any }).data;
  };
  const target = str(config, "target", "node");
  const name = str(config, "name");
  try {
    switch (target) {
      case "cluster": {
        const items = (await get("/cluster/status")) as { type: string; name: string; online?: number; quorate?: number }[];
        const cluster = items.find((i) => i.type === "cluster");
        const nodes = items.filter((i) => i.type === "node");
        const offline = nodes.filter((n) => !n.online);
        const latencyMs = Date.now() - start;
        if (cluster && !cluster.quorate) return { status: "down", latencyMs, message: "Cluster has lost quorum", details: items };
        if (offline.length) return { status: "down", latencyMs, message: `Node(s) offline: ${offline.map((n) => n.name).join(", ")}`, value: offline.length, details: items };
        return { status: "up", latencyMs, message: `${nodes.length} node(s) online${cluster ? ", quorate" : ""}`, value: 0, details: items };
      }
      case "node": {
        const nodes = (await get("/nodes")) as { node: string; status: string; cpu: number; mem: number; maxmem: number; uptime: number }[];
        const node = name ? nodes.find((n) => n.node === name) : nodes[0];
        const latencyMs = Date.now() - start;
        if (!node) return { status: "down", latencyMs, message: `Node ${name} not found` };
        if (node.status !== "online") return { status: "down", latencyMs, message: `Node ${node.node} is ${node.status}` };
        const metric = str(config, "metric", "cpu_percent");
        const value = metric === "memory_percent" ? (node.mem / node.maxmem) * 100 : node.cpu * 100;
        return { status: "up", latencyMs, message: `${node.node}: CPU ${(node.cpu * 100).toFixed(1)}%, RAM ${((node.mem / node.maxmem) * 100).toFixed(1)}%`, value: Math.round(value * 10) / 10 };
      }
      case "vm": {
        const vms = (await get("/cluster/resources?type=vm")) as { vmid: number; name: string; status: string; node: string; type: string; template?: number }[];
        const latencyMs = Date.now() - start;
        if (!name || name === "*") {
          const stopped = vms.filter((v) => v.status !== "running" && !v.template);
          return { status: "up", latencyMs, message: `${vms.length - stopped.length}/${vms.length} guests running`, value: stopped.length, details: stopped.map((v) => ({ vmid: v.vmid, name: v.name, status: v.status })) };
        }
        const vm = vms.find((v) => String(v.vmid) === name || v.name === name);
        if (!vm) return { status: "down", latencyMs, message: `Guest ${name} not found` };
        const expected = str(config, "expectedStatus", "running");
        return { status: vm.status === expected ? "up" : "down", latencyMs, message: `${vm.type} ${vm.vmid} (${vm.name}) on ${vm.node}: ${vm.status}` };
      }
      case "storage": {
        const stores = (await get("/cluster/resources?type=storage")) as { storage: string; node: string; disk: number; maxdisk: number; status: string }[];
        const matching = stores.filter((s) => !name || s.storage === name);
        const latencyMs = Date.now() - start;
        if (!matching.length) return { status: "down", latencyMs, message: `Storage ${name} not found` };
        const unavailable = matching.filter((s) => s.status !== "available");
        if (unavailable.length) return { status: "down", latencyMs, message: `Unavailable: ${unavailable.map((s) => `${s.storage}@${s.node}`).join(", ")}` };
        const worstStore = matching.reduce((a, b) => (b.disk / b.maxdisk > a.disk / a.maxdisk ? b : a));
        const pct = (worstStore.disk / worstStore.maxdisk) * 100;
        return { status: "up", latencyMs, message: `${worstStore.storage}@${worstStore.node} ${pct.toFixed(1)}% used`, value: Math.round(pct * 10) / 10, details: matching };
      }
      case "backups": {
        const tasks = (await get("/cluster/tasks")) as { type: string; status?: string; endtime?: number; starttime: number; id: string; node: string }[];
        const dumps = tasks.filter((t) => t.type === "vzdump" && t.endtime && (!name || t.id === name || t.id === ""));
        const latencyMs = Date.now() - start;
        if (!dumps.length) return { status: "down", latencyMs, message: "No finished backup (vzdump) tasks in the cluster task log" };
        const latest = dumps.reduce((a, b) => ((b.endtime ?? 0) > (a.endtime ?? 0) ? b : a));
        const ageHours = (Date.now() / 1000 - (latest.endtime ?? 0)) / 3600;
        const maxAge = numOr(config, "maxAgeHours", 26);
        const ok = latest.status === "OK";
        const when = new Date((latest.endtime ?? 0) * 1000).toISOString().replace("T", " ").slice(0, 16);
        if (!ok) return { status: "down", latencyMs, message: `Last backup on ${latest.node} failed: ${latest.status}`, value: ageHours };
        if (ageHours > maxAge) return { status: "down", latencyMs, message: `Last backup finished ${ageHours.toFixed(1)}h ago (${when})`, value: ageHours };
        return { status: "up", latencyMs, message: `Last backup OK at ${when} on ${latest.node}`, value: Math.round(ageHours * 10) / 10 };
      }
      default:
        return warn(`Unknown Proxmox target: ${target}`);
    }
  } catch (err) {
    return down(errMsg(err));
  }
}

const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:vim25"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1];

// Objects out of a RetrievePropertiesEx reply: each <objects> holds an
// <obj> moref and <propSet> name/val pairs.
export function parseVimObjects(xml: string): { moref: string; props: Record<string, string> }[] {
  const out: { moref: string; props: Record<string, string> }[] = [];
  for (const m of xml.matchAll(/<objects>([\s\S]*?)<\/objects>/g)) {
    const moref = tag(m[1], "obj") ?? "";
    const props: Record<string, string> = {};
    for (const p of m[1].matchAll(/<propSet>\s*<name>([^<]+)<\/name>\s*<val[^>]*>([^<]*)<\/val>\s*<\/propSet>/g)) props[p[1]] = p[2];
    out.push({ moref, props });
  }
  return out;
}

// I3 (ESXi / vCenter). The vSphere SOAP API is the one interface both a
// standalone ESXi host and vCenter speak; only the few calls needed here
// are hand-written rather than pulling in a full SOAP client.
export async function probeVmware(config: Config): Promise<ProbeOutcome> {
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  const insecure = bool(config, "insecureSkipVerify", true);
  const start = Date.now();
  let cookie = "";
  const call = async (body: string) => {
    const res = await httpRequest(`${base}/sdk`, {
      method: "POST",
      insecure,
      body: envelope(body),
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "urn:vim25/8.0", ...(cookie ? { Cookie: cookie } : {}) },
      timeoutMs: 20_000,
    });
    const setCookie = res.headers["set-cookie"]?.[0];
    if (setCookie) cookie = setCookie.split(";")[0];
    const fault = tag(res.body, "faultstring");
    if (fault) throw new Error(fault);
    if (res.status !== 200) throw new Error(`vSphere SOAP returned HTTP ${res.status}`);
    return res.body;
  };
  try {
    const sc = await call(`<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">ServiceInstance</urn:_this></urn:RetrieveServiceContent>`);
    const sessionManager = tag(sc, "sessionManager")!;
    const propertyCollector = tag(sc, "propertyCollector")!;
    const viewManager = tag(sc, "viewManager")!;
    const rootFolder = tag(sc, "rootFolder")!;
    await call(`<urn:Login><urn:_this type="SessionManager">${sessionManager}</urn:_this><urn:userName>${xmlEscape(str(config, "username"))}</urn:userName><urn:password>${xmlEscape(str(config, "password"))}</urn:password></urn:Login>`);
    const target = str(config, "target", "vm");
    const type = target === "datastore" ? "Datastore" : target === "host" ? "HostSystem" : "VirtualMachine";
    const paths = type === "Datastore" ? ["name", "summary.capacity", "summary.freeSpace", "summary.accessible"] : type === "HostSystem" ? ["name", "overallStatus", "runtime.connectionState", "runtime.inMaintenanceMode"] : ["name", "runtime.powerState", "guest.toolsRunningStatus"];
    const view = tag(
      await call(`<urn:CreateContainerView><urn:_this type="ViewManager">${viewManager}</urn:_this><urn:container type="Folder">${rootFolder}</urn:container><urn:type>${type}</urn:type><urn:recursive>true</urn:recursive></urn:CreateContainerView>`),
      "returnval"
    )!;
    const props = await call(
      `<urn:RetrievePropertiesEx><urn:_this type="PropertyCollector">${propertyCollector}</urn:_this><urn:specSet><urn:propSet><urn:type>${type}</urn:type>${paths.map((p) => `<urn:pathSet>${p}</urn:pathSet>`).join("")}</urn:propSet><urn:objectSet><urn:obj type="ContainerView">${view}</urn:obj><urn:skip>true</urn:skip><urn:selectSet xsi:type="urn:TraversalSpec" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><urn:name>traverseEntities</urn:name><urn:type>ContainerView</urn:type><urn:path>view</urn:path><urn:skip>false</urn:skip></urn:selectSet></urn:objectSet></urn:specSet><urn:options/></urn:RetrievePropertiesEx>`
    );
    await call(`<urn:Logout><urn:_this type="SessionManager">${sessionManager}</urn:_this></urn:Logout>`).catch(() => undefined);
    const objects = parseVimObjects(props);
    const latencyMs = Date.now() - start;
    const name = str(config, "name");
    const matching = objects.filter((o) => !name || name === "*" || o.props.name === name);
    if (!matching.length) return { status: "down", latencyMs, message: name ? `${type} "${name}" not found` : `No ${type} objects returned` };

    if (type === "VirtualMachine") {
      const off = matching.filter((o) => o.props["runtime.powerState"] !== "poweredOn");
      const details = matching.map((o) => ({ name: o.props.name, power: o.props["runtime.powerState"], tools: o.props["guest.toolsRunningStatus"] }));
      if (name && name !== "*") return { status: off.length ? "down" : "up", latencyMs, message: `${matching[0].props.name}: ${matching[0].props["runtime.powerState"]}`, details };
      return { status: "up", latencyMs, message: `${matching.length - off.length}/${matching.length} VMs powered on`, value: off.length, details };
    }
    if (type === "Datastore") {
      const rows = matching.map((o) => {
        const cap = Number(o.props["summary.capacity"]);
        const free = Number(o.props["summary.freeSpace"]);
        return { name: o.props.name, usedPercent: cap > 0 ? Math.round(((cap - free) / cap) * 1000) / 10 : 0, freeGb: Math.round(free / 1e9), accessible: o.props["summary.accessible"] !== "false" };
      });
      const inaccessible = rows.filter((r) => !r.accessible);
      if (inaccessible.length) return { status: "down", latencyMs, message: `Inaccessible: ${inaccessible.map((r) => r.name).join(", ")}`, details: rows };
      const fullest = rows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
      return { status: "up", latencyMs, message: `${fullest.name} ${fullest.usedPercent}% used (${fullest.freeGb} GB free)`, value: fullest.usedPercent, details: rows };
    }
    let status: Status = "up";
    const issues: string[] = [];
    for (const o of matching) {
      const overall = o.props.overallStatus;
      const conn = o.props["runtime.connectionState"];
      if (conn && conn !== "connected") {
        status = "down";
        issues.push(`${o.props.name} ${conn}`);
      } else if (overall === "red") {
        status = "down";
        issues.push(`${o.props.name} status red`);
      } else if (overall === "yellow") {
        status = worst(status, "warn");
        issues.push(`${o.props.name} status yellow`);
      }
    }
    return { status, latencyMs, message: issues.length ? issues.join("; ") : `${matching.length} host(s) green and connected`, details: matching.map((o) => ({ name: o.props.name, ...o.props })) };
  } catch (err) {
    return down(errMsg(err));
  }
}
