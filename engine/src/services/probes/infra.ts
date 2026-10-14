// Infrastructure probes: server management controllers (BMC — Redfish or
// IPMI), Proxmox VE, and VMware ESXi/vCenter.
//
// Where this sits: the check scheduler (services/scheduler.ts) calls these
// through the probe registry for the "bmc", "proxmox" and "vmware" check
// types; a site collector runs the same code at a remote site. Each probe
// takes the check's saved `config`, talks to the device's management API,
// and returns a ProbeOutcome: a status (up/warn/down), a one-line message,
// an optional number (`value`) that thresholds and graphs use, and optional
// `details` shown as a table on the check's page.
//
// Security: these probes log in with credentials from the check's config
// (BMC username/password, a Proxmox API token, a vSphere account). They are
// sent only to the configured device, never logged, and never put on a
// command line: ipmitool gets its password through an environment variable.
// Untrusted text that goes into a vSphere XML request is escaped. Many BMCs
// and hypervisors use self-signed certificates, so TLS verification is
// skipped by default (insecureSkipVerify) — the admin can turn it on per check.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { worst, type Status } from "../thresholds.js";
import { type Config, type ProbeOutcome, bool, down, errMsg, numOr, str, warn } from "./types.js";
import { httpRequest } from "./http.js";

// execFile runs a program directly (no shell, so arguments can't be
// interpreted as shell syntax). promisify turns its callback style into a
// promise that `await` can wait for.
const execFileAsync = promisify(execFile);

/**
 * Maps a Redfish "Health" value to a check status.
 *
 * @param h "OK", "Warning", "Critical" or missing
 * @returns down for Critical, warn for Warning, otherwise up
 */
const healthStatus = (h: string | undefined): Status => (h === "Critical" ? "down" : h === "Warning" ? "warn" : "up");

/**
 * H8. Checks a server's management controller (BMC). Redfish is the modern
 * BMC API (iDRAC 8+, iLO 4+, Supermicro X10+, OpenBMC); IPMI-over-LAN via
 * ipmitool covers older boards.
 *
 * @param config the check's settings; `protocol` picks "redfish" (default) or "ipmi"
 * @returns the probe outcome from whichever protocol was chosen
 */
export async function probeBmc(config: Config): Promise<ProbeOutcome> {
  return str(config, "protocol", "redfish") === "ipmi" ? probeIpmi(config) : probeRedfish(config);
}

/**
 * Reads overall system health, power state, temperatures, fans and power
 * supplies over the Redfish REST API, and reports the worst of them.
 *
 * @param config url, optional username/password, insecureSkipVerify, requirePoweredOn
 * @returns down/warn with the failing components listed, or up with a summary;
 *          `value` is the hottest temperature in °C
 */
async function probeRedfish(config: Config): Promise<ProbeOutcome> {
  // Base URL without a trailing slash, e.g. "https://10.1.30.5".
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  const headers: Record<string, string> = { Accept: "application/json" };
  // HTTP Basic authentication: "user:password" base64-encoded in a header.
  if (str(config, "username")) headers.Authorization = `Basic ${Buffer.from(`${str(config, "username")}:${str(config, "password")}`).toString("base64")}`;
  const insecure = bool(config, "insecureSkipVerify", true);
  const start = Date.now();
  // Fetches one Redfish resource as JSON. Redfish links resources by
  // "@odata.id" paths, which may be relative or full URLs.
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
    // Records a component whose health isn't OK and worsens the overall status.
    const flag = (health: string | undefined, what: string) => {
      const s = healthStatus(health);
      if (s !== "up") {
        status = worst(status, s);
        problems.push(`${what}: ${health}`);
      }
    };
    // Systems = the server(s) the BMC manages: overall health and power.
    const systems = await get("/redfish/v1/Systems");
    for (const m of systems.Members ?? []) {
      const sys = await get(m["@odata.id"]);
      // HealthRollup includes sub-components; fall back to the system's own Health.
      flag(sys.Status?.HealthRollup ?? sys.Status?.Health, `System ${sys.Id ?? ""}`.trim());
      if (bool(config, "requirePoweredOn", true) && sys.PowerState && sys.PowerState !== "On") {
        status = "down";
        problems.push(`System power is ${sys.PowerState}`);
      }
    }
    // Chassis = the physical enclosure(s): thermal and power sensors.
    const chassis = await get("/redfish/v1/Chassis");
    for (const m of chassis.Members ?? []) {
      const ch = await get(m["@odata.id"]);
      if (ch.Thermal?.["@odata.id"]) {
        // A chassis whose sensors can't be read is skipped rather than
        // failing the whole check.
        const thermal = await get(ch.Thermal["@odata.id"]).catch(() => null);
        for (const t of thermal?.Temperatures ?? []) {
          // Empty sensor slots report State "Absent".
          if (t.ReadingCelsius == null || t.Status?.State === "Absent") continue;
          temps.push({ name: t.Name, c: t.ReadingCelsius, health: t.Status?.Health });
          flag(t.Status?.Health, t.Name);
        }
        for (const f of thermal?.Fans ?? []) {
          if (f.Status?.State === "Absent") continue;
          // Older firmware names fans with FanName instead of Name.
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

/**
 * Parses `ipmitool sdr elist` output into sensors. Each row looks like
 * "Fan1 | 30h | ok | 29.1 | 5400 RPM" (name | id | status | entity | reading).
 * Lines with fewer than five "|"-separated fields are ignored.
 *
 * @param output ipmitool's standard output
 * @returns one entry per sensor: name, status code and reading text
 */
export function parseIpmiSdr(output: string) {
  const sensors: { name: string; status: string; reading: string }[] = [];
  // Splits on Windows or Unix line endings.
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split("|").map((p) => p.trim());
    if (parts.length < 5) continue;
    sensors.push({ name: parts[0], status: parts[2], reading: parts[4] });
  }
  return sensors;
}

/**
 * Reads every sensor over IPMI-over-LAN with the ipmitool program, which
 * must be installed on the machine running the probe.
 *
 * @param config host, username, password
 * @returns down for critical sensors, warn for non-critical ones, otherwise
 *          up; `value` is the hottest temperature in °C
 */
async function probeIpmi(config: Config): Promise<ProbeOutcome> {
  const host = str(config, "host");
  if (!host) return warn("Missing host");
  const start = Date.now();
  try {
    // -E tells ipmitool to read the password from the IPMI_PASSWORD
    // environment variable. Putting it in the argument list instead would
    // make it visible to any user on the machine (e.g. in `ps` output).
    const { stdout } = await execFileAsync("ipmitool", ["-I", "lanplus", "-H", host, "-U", str(config, "username"), "-E", "sdr", "elist"], {
      env: { ...process.env, IPMI_PASSWORD: str(config, "password") },
      timeout: 30_000,
    });
    const sensors = parseIpmiSdr(stdout);
    if (!sensors.length) return warn("ipmitool returned no sensors");
    // ok = fine, ns = no reading (absent), nc/cr/nr = non-critical/critical/non-recoverable.
    const bad = sensors.filter((s) => !["ok", "ns"].includes(s.status));
    const critical = bad.filter((s) => ["cr", "nr"].includes(s.status));
    // The regex pulls the number out of readings like "41 degrees C" → "41".
    const temps = sensors.map((s) => s.reading.match(/([\d.]+) degrees C/)?.[1]).filter(Boolean).map(Number);
    const maxTemp = temps.length ? Math.max(...temps) : null;
    const latencyMs = Date.now() - start;
    const status: Status = critical.length ? "down" : bad.length ? "warn" : "up";
    // At most five problem sensors in the message; all of them are in details.
    return { status, latencyMs, message: bad.length ? bad.map((s) => `${s.name}: ${s.status} (${s.reading})`).slice(0, 5).join("; ") : `${sensors.length} sensors OK, max ${maxTemp ?? "n/a"}°C`, value: maxTemp, details: sensors };
  } catch (err) {
    const e = err as { code?: string };
    // ENOENT = the operating system couldn't find the ipmitool program.
    if (e.code === "ENOENT") return warn("ipmitool isn't installed on the engine host (apt install ipmitool)");
    return down(errMsg(err));
  }
}

/**
 * I2. Checks a Proxmox VE cluster, node, guest, storage or backups through
 * the Proxmox REST API. Uses API token auth (Datacenter → Permissions → API
 * Tokens); a read-only PVEAuditor role is enough for everything here.
 *
 * @param config url, tokenId, tokenSecret, insecureSkipVerify, `target`
 *        ("cluster", "node", "vm", "storage" or "backups"), `name` (which
 *        node/guest/storage; blank or "*" = all), plus per-target options
 * @returns the probe outcome for the chosen target
 */
export async function probeProxmox(config: Config): Promise<ProbeOutcome> {
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  // Proxmox's token header format: "PVEAPIToken=user@realm!tokenid=secret".
  const headers = { Authorization: `PVEAPIToken=${str(config, "tokenId")}=${str(config, "tokenSecret")}` };
  const insecure = bool(config, "insecureSkipVerify", true);
  const start = Date.now();
  // Fetches one API path; Proxmox wraps every answer in { data: ... }.
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
      // Whole cluster: quorum and which nodes are online.
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
      // One node (the named one, or the first): online, plus CPU or memory use as the value.
      case "node": {
        const nodes = (await get("/nodes")) as { node: string; status: string; cpu: number; mem: number; maxmem: number; uptime: number }[];
        const node = name ? nodes.find((n) => n.node === name) : nodes[0];
        const latencyMs = Date.now() - start;
        if (!node) return { status: "down", latencyMs, message: `Node ${name} not found` };
        if (node.status !== "online") return { status: "down", latencyMs, message: `Node ${node.node} is ${node.status}` };
        const metric = str(config, "metric", "cpu_percent");
        // Proxmox reports CPU as a 0–1 fraction and memory in bytes.
        const value = metric === "memory_percent" ? (node.mem / node.maxmem) * 100 : node.cpu * 100;
        return { status: "up", latencyMs, message: `${node.node}: CPU ${(node.cpu * 100).toFixed(1)}%, RAM ${((node.mem / node.maxmem) * 100).toFixed(1)}%`, value: Math.round(value * 10) / 10 };
      }
      // Guests (VMs and containers): one by ID or name in its expected state,
      // or with no name, a count of stopped guests (templates excluded).
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
      // Storage: down if any matching store is unavailable; otherwise the
      // fullest one's used % is the value.
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
      // Backups: the newest finished vzdump task must have succeeded and be
      // younger than maxAgeHours. The value is its age in hours.
      case "backups": {
        const tasks = (await get("/cluster/tasks")) as { type: string; status?: string; endtime?: number; starttime: number; id: string; node: string }[];
        // A named guest's backups only (task id = the guest ID); an "all
        // guests" job has an empty id and counts for every guest.
        const dumps = tasks.filter((t) => t.type === "vzdump" && t.endtime && (!name || t.id === name || t.id === ""));
        const latencyMs = Date.now() - start;
        if (!dumps.length) return { status: "down", latencyMs, message: "No finished backup (vzdump) tasks in the cluster task log" };
        const latest = dumps.reduce((a, b) => ((b.endtime ?? 0) > (a.endtime ?? 0) ? b : a));
        // endtime is Unix seconds.
        const ageHours = (Date.now() / 1000 - (latest.endtime ?? 0)) / 3600;
        const maxAge = numOr(config, "maxAgeHours", 26);
        const ok = latest.status === "OK";
        // Written as "YYYY-MM-DD HH:MM UTC": readable in an email or chat
        // alert, and the dashboard recognises this form and shows it in the
        // viewer's own time zone (dashboard/app/lib/localTime.ts).
        const when = `${new Date((latest.endtime ?? 0) * 1000).toISOString().replace("T", " ").slice(0, 16)} UTC`;
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

/**
 * Escapes text for safe inclusion in XML. Without this, a username or
 * password containing "<" or "&" would break the request, or let crafted
 * input inject extra XML elements into it.
 */
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Wraps a request body in the SOAP envelope vSphere expects. */
const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:vim25"><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

/**
 * The text of the first <name>...</name> element in an XML string. The regex
 * matches the opening tag (with any attributes), then captures text up to the
 * closing tag, e.g. tag("<a x='1'>hi</a>", "a") → "hi".
 */
const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}[^>]*>([^<]*)</${name}>`))?.[1];

/**
 * Pulls objects out of a vSphere RetrievePropertiesEx reply. Each <objects>
 * element holds an <obj> (the object's internal ID, a "moref") and
 * <propSet> name/value pairs.
 *
 * @param xml the SOAP response body
 * @returns one entry per object: its moref and a property-name → value map
 */
export function parseVimObjects(xml: string): { moref: string; props: Record<string, string> }[] {
  const out: { moref: string; props: Record<string, string> }[] = [];
  // [\s\S]*? matches anything, across lines, as little as possible — so each
  // match stops at the first closing </objects>.
  for (const m of xml.matchAll(/<objects>([\s\S]*?)<\/objects>/g)) {
    const moref = tag(m[1], "obj") ?? "";
    const props: Record<string, string> = {};
    // Each <propSet><name>N</name><val ...>V</val></propSet> becomes props[N] = V.
    for (const p of m[1].matchAll(/<propSet>\s*<name>([^<]+)<\/name>\s*<val[^>]*>([^<]*)<\/val>\s*<\/propSet>/g)) props[p[1]] = p[2];
    out.push({ moref, props });
  }
  return out;
}

/**
 * I3 (ESXi / vCenter). Checks VMs, hosts or datastores through the vSphere
 * SOAP API — the one interface both a standalone ESXi host and vCenter speak.
 * Only the few calls needed here are hand-written, rather than pulling in a
 * full SOAP client library.
 *
 * Flow: get the service directory, log in (session cookie), create a view of
 * every object of the wanted type, read the needed properties of all of them
 * in one call, log out, then judge the results.
 *
 * @param config url, username, password, insecureSkipVerify, `target`
 *        ("vm", "host" or "datastore") and `name` (blank or "*" = all)
 * @returns the probe outcome for the chosen target
 */
export async function probeVmware(config: Config): Promise<ProbeOutcome> {
  const base = str(config, "url").replace(/\/$/, "");
  if (!base) return warn("Missing url");
  const insecure = bool(config, "insecureSkipVerify", true);
  const start = Date.now();
  // The session cookie from Login, sent with every later call.
  let cookie = "";
  // Sends one SOAP request to /sdk and returns the response XML, throwing on
  // a SOAP fault (vSphere's error reply) or a non-200 status.
  const call = async (body: string) => {
    const res = await httpRequest(`${base}/sdk`, {
      method: "POST",
      insecure,
      body: envelope(body),
      headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "urn:vim25/8.0", ...(cookie ? { Cookie: cookie } : {}) },
      timeoutMs: 20_000,
    });
    // Keep just "name=value" from Set-Cookie, dropping attributes like Path.
    const setCookie = res.headers["set-cookie"]?.[0];
    if (setCookie) cookie = setCookie.split(";")[0];
    const fault = tag(res.body, "faultstring");
    if (fault) throw new Error(fault);
    if (res.status !== 200) throw new Error(`vSphere SOAP returned HTTP ${res.status}`);
    return res.body;
  };
  try {
    // The service directory: IDs of the managers used below.
    const sc = await call(`<urn:RetrieveServiceContent><urn:_this type="ServiceInstance">ServiceInstance</urn:_this></urn:RetrieveServiceContent>`);
    const sessionManager = tag(sc, "sessionManager")!;
    const propertyCollector = tag(sc, "propertyCollector")!;
    const viewManager = tag(sc, "viewManager")!;
    const rootFolder = tag(sc, "rootFolder")!;
    // Credentials are XML-escaped (see xmlEscape) before going into the request.
    await call(`<urn:Login><urn:_this type="SessionManager">${sessionManager}</urn:_this><urn:userName>${xmlEscape(str(config, "username"))}</urn:userName><urn:password>${xmlEscape(str(config, "password"))}</urn:password></urn:Login>`);
    const target = str(config, "target", "vm");
    const type = target === "datastore" ? "Datastore" : target === "host" ? "HostSystem" : "VirtualMachine";
    // The properties read for each object type.
    const paths = type === "Datastore" ? ["name", "summary.capacity", "summary.freeSpace", "summary.accessible"] : type === "HostSystem" ? ["name", "overallStatus", "runtime.connectionState", "runtime.inMaintenanceMode"] : ["name", "runtime.powerState", "guest.toolsRunningStatus"];
    // A "container view" = every object of that type anywhere in the inventory.
    const view = tag(
      await call(`<urn:CreateContainerView><urn:_this type="ViewManager">${viewManager}</urn:_this><urn:container type="Folder">${rootFolder}</urn:container><urn:type>${type}</urn:type><urn:recursive>true</urn:recursive></urn:CreateContainerView>`),
      "returnval"
    )!;
    // One call reads the chosen properties of every object in the view.
    const props = await call(
      `<urn:RetrievePropertiesEx><urn:_this type="PropertyCollector">${propertyCollector}</urn:_this><urn:specSet><urn:propSet><urn:type>${type}</urn:type>${paths.map((p) => `<urn:pathSet>${p}</urn:pathSet>`).join("")}</urn:propSet><urn:objectSet><urn:obj type="ContainerView">${view}</urn:obj><urn:skip>true</urn:skip><urn:selectSet xsi:type="urn:TraversalSpec" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><urn:name>traverseEntities</urn:name><urn:type>ContainerView</urn:type><urn:path>view</urn:path><urn:skip>false</urn:skip></urn:selectSet></urn:objectSet></urn:specSet><urn:options/></urn:RetrievePropertiesEx>`
    );
    // Log out so sessions don't pile up on the server; a failed logout
    // doesn't affect the result.
    await call(`<urn:Logout><urn:_this type="SessionManager">${sessionManager}</urn:_this></urn:Logout>`).catch(() => undefined);
    const objects = parseVimObjects(props);
    const latencyMs = Date.now() - start;
    const name = str(config, "name");
    const matching = objects.filter((o) => !name || name === "*" || o.props.name === name);
    if (!matching.length) return { status: "down", latencyMs, message: name ? `${type} "${name}" not found` : `No ${type} objects returned` };

    // VMs: a named VM must be powered on; with no name, count powered-off VMs.
    if (type === "VirtualMachine") {
      const off = matching.filter((o) => o.props["runtime.powerState"] !== "poweredOn");
      const details = matching.map((o) => ({ name: o.props.name, power: o.props["runtime.powerState"], tools: o.props["guest.toolsRunningStatus"] }));
      if (name && name !== "*") return { status: off.length ? "down" : "up", latencyMs, message: `${matching[0].props.name}: ${matching[0].props["runtime.powerState"]}`, details };
      return { status: "up", latencyMs, message: `${matching.length - off.length}/${matching.length} VMs powered on`, value: off.length, details };
    }
    // Datastores: down if any is inaccessible; otherwise the fullest one's used % is the value.
    if (type === "Datastore") {
      const rows = matching.map((o) => {
        // Capacity and free space arrive as byte counts in text form.
        const cap = Number(o.props["summary.capacity"]);
        const free = Number(o.props["summary.freeSpace"]);
        return { name: o.props.name, usedPercent: cap > 0 ? Math.round(((cap - free) / cap) * 1000) / 10 : 0, freeGb: Math.round(free / 1e9), accessible: o.props["summary.accessible"] !== "false" };
      });
      const inaccessible = rows.filter((r) => !r.accessible);
      if (inaccessible.length) return { status: "down", latencyMs, message: `Inaccessible: ${inaccessible.map((r) => r.name).join(", ")}`, details: rows };
      const fullest = rows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
      return { status: "up", latencyMs, message: `${fullest.name} ${fullest.usedPercent}% used (${fullest.freeGb} GB free)`, value: fullest.usedPercent, details: rows };
    }
    // Hosts: disconnected or red = down, yellow = warn.
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
