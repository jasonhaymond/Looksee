import crypto from "node:crypto";
import { applyThresholds, type MeasuredResult, type Status } from "./thresholds.js";

// Shape of the 3.x agent's `metrics.extended` (agent/internal/metrics).
// Every field is optional: a platform or permission may not provide it.
export type Snapshot = {
  cpu?: { percent?: number; user?: number; system?: number; iowait?: number; steal?: number; perCore?: number[] };
  load?: { l1?: number; l5?: number; l15?: number; cores?: number };
  mem?: { total?: number; available?: number; percent?: number; swapTotal?: number; swapUsed?: number; swapPercent?: number; pageFaultsPerSec?: number };
  uptimeSeconds?: number;
  bootTime?: number;
  procs?: { total?: number; zombies?: number; threads?: number };
  fds?: { open?: number; max?: number; percent?: number };
  ctxSwitchesPerSec?: number;
  interruptsPerSec?: number;
  temps?: { sensor: string; celsius: number }[];
  fans?: { sensor: string; rpm: number }[];
  battery?: { percent?: number; charging?: boolean; present?: boolean } | null;
  disks?: { mount: string; device?: string; fstype?: string; total: number; used: number; free: number; percent: number; inodesPercent?: number; readOnly?: boolean; stale?: boolean }[];
  diskIO?: { device: string; readBytesPerSec?: number; writeBytesPerSec?: number; readIops?: number; writeIops?: number; awaitMs?: number; busyPercent?: number }[];
  net?: { name: string; rxBytesPerSec?: number; txBytesPerSec?: number; rxErrorsPerSec?: number; txErrorsPerSec?: number; rxDropsPerSec?: number; txDropsPerSec?: number; up?: boolean; speedMbps?: number; mac?: string; addrs?: string[] }[];
  tcp?: Record<string, number>;
  listening?: { port: number; proto: string; address?: string; process?: string }[];
  users?: { count?: number; sessions?: { user: string; terminal?: string; host?: string; started?: number }[] };
  pendingReboot?: boolean | null;
  time?: { offsetMs?: number | null; synced?: boolean | null; server?: string };
  updates?: { total?: number; security?: number; checkedAt?: number } | null;
  defender?: { enabled?: boolean; realtime?: boolean; signatureAgeDays?: number } | null;
  firewall?: { enabled?: boolean; detail?: string } | null;
  encryption?: { enabled?: boolean; detail?: string } | null;
  failedLogins?: number | null;
  smart?: { device: string; model?: string; passed?: boolean; reallocated?: number; pending?: number; wearPercent?: number; tempC?: number }[] | null;
  raid?: { name: string; kind: string; healthy: boolean; state?: string; detail?: string }[] | null;
};

type Kind = "number" | "boolean";
type Agg = "max" | "min" | "sum";

export type MetricDef = {
  key: string;
  label: string;
  group: string;
  kind: Kind;
  unit?: string;
  // What the instance field filters on, if anything ("mount", "interface"...).
  instance?: string;
  instanceRequired?: boolean;
  // How to combine across instances when none is given ("*" or blank).
  agg?: Agg;
  // Boolean metrics: the healthy value.
  expect?: boolean;
  platforms?: string;
  help?: string;
  read: (s: Snapshot, instance: string) => { value: number | boolean; label: string }[] | null;
};

const lc = (s: string) => s.toLowerCase();
const matches = (name: string, instance: string) => !instance || instance === "*" || lc(name) === lc(instance) || lc(name).includes(lc(instance));
const one = (v: number | boolean | undefined | null, label = "") => (v == null ? null : [{ value: v, label }]);
// An exact instance match (mount "/", interface "eth0") wins outright;
// substring matching is only the fallback — otherwise "/" would match every
// mount on the host.
const many = <T>(arr: T[] | null | undefined, instance: string, name: (x: T) => string, val: (x: T) => number | boolean | undefined | null) => {
  if (!arr) return null;
  const usable = arr.filter((x) => val(x) != null);
  const exact = instance && instance !== "*" ? usable.filter((x) => lc(name(x)) === lc(instance)) : [];
  return (exact.length ? exact : usable.filter((x) => matches(name(x), instance))).map((x) => ({ value: val(x)!, label: name(x) }));
};
const MB = 1048576;
const toMbps = (bps?: number) => (bps == null ? undefined : (bps * 8) / 1e6);

export const HOST_METRICS: MetricDef[] = [
  { key: "cpu.percent", label: "CPU usage", group: "CPU & load", kind: "number", unit: "%", read: (s) => one(s.cpu?.percent) },
  { key: "cpu.user", label: "CPU user time", group: "CPU & load", kind: "number", unit: "%", read: (s) => one(s.cpu?.user) },
  { key: "cpu.system", label: "CPU system time", group: "CPU & load", kind: "number", unit: "%", read: (s) => one(s.cpu?.system) },
  { key: "cpu.iowait", label: "CPU iowait", group: "CPU & load", kind: "number", unit: "%", platforms: "Linux", read: (s) => one(s.cpu?.iowait) },
  { key: "cpu.steal", label: "CPU steal (VM)", group: "CPU & load", kind: "number", unit: "%", platforms: "Linux", help: "Time the hypervisor gave this VM's CPU to someone else — high steal means an oversubscribed host.", read: (s) => one(s.cpu?.steal) },
  { key: "cpu.core_max", label: "Busiest single core", group: "CPU & load", kind: "number", unit: "%", read: (s) => one(s.cpu?.perCore?.length ? Math.max(...s.cpu.perCore) : undefined) },
  { key: "load.1", label: "Load average 1 min (per core)", group: "CPU & load", kind: "number", platforms: "Linux, macOS", read: (s) => one(s.load?.l1 != null ? s.load.l1 / (s.load.cores || 1) : undefined) },
  { key: "load.5", label: "Load average 5 min (per core)", group: "CPU & load", kind: "number", platforms: "Linux, macOS", read: (s) => one(s.load?.l5 != null ? s.load.l5 / (s.load.cores || 1) : undefined) },
  { key: "load.15", label: "Load average 15 min (per core)", group: "CPU & load", kind: "number", platforms: "Linux, macOS", read: (s) => one(s.load?.l15 != null ? s.load.l15 / (s.load.cores || 1) : undefined) },
  { key: "ctx.switches_per_sec", label: "Context switches / sec", group: "CPU & load", kind: "number", read: (s) => one(s.ctxSwitchesPerSec) },
  { key: "irq.per_sec", label: "Interrupts / sec", group: "CPU & load", kind: "number", read: (s) => one(s.interruptsPerSec) },

  { key: "mem.percent", label: "Memory used", group: "Memory", kind: "number", unit: "%", read: (s) => one(s.mem?.percent) },
  { key: "mem.available_mb", label: "Memory available", group: "Memory", kind: "number", unit: " MB", help: "Counts reclaimable cache as available — the honest 'how close to OOM' number.", read: (s) => one(s.mem?.available != null ? s.mem.available / MB : undefined) },
  { key: "swap.percent", label: "Swap used", group: "Memory", kind: "number", unit: "%", read: (s) => one(s.mem?.swapTotal ? s.mem.swapPercent : undefined) },
  { key: "mem.page_faults_per_sec", label: "Major page faults / sec", group: "Memory", kind: "number", platforms: "Linux", read: (s) => one(s.mem?.pageFaultsPerSec) },

  { key: "procs.total", label: "Process count", group: "Processes & system", kind: "number", read: (s) => one(s.procs?.total) },
  { key: "procs.zombies", label: "Zombie processes", group: "Processes & system", kind: "number", platforms: "Linux, macOS", read: (s) => one(s.procs?.zombies) },
  { key: "procs.threads", label: "Thread count", group: "Processes & system", kind: "number", read: (s) => one(s.procs?.threads) },
  { key: "fds.percent", label: "Open file handles (% of limit)", group: "Processes & system", kind: "number", unit: "%", platforms: "Linux", read: (s) => one(s.fds?.percent) },
  { key: "uptime.hours", label: "Uptime", group: "Processes & system", kind: "number", unit: " h", read: (s) => one(s.uptimeSeconds != null ? s.uptimeSeconds / 3600 : undefined) },
  { key: "reboot.pending", label: "Reboot pending", group: "Processes & system", kind: "boolean", expect: false, help: "Windows: pending-reboot registry flags. Linux: /var/run/reboot-required or needs-restarting.", read: (s) => one(s.pendingReboot) },
  { key: "users.count", label: "Logged-in sessions", group: "Processes & system", kind: "number", read: (s) => one(s.users?.count) },
  { key: "time.offset_ms", label: "Clock offset vs NTP", group: "Processes & system", kind: "number", unit: " ms", read: (s) => one(s.time?.offsetMs != null ? Math.abs(s.time.offsetMs) : undefined) },
  { key: "time.synced", label: "Clock is NTP-synchronized", group: "Processes & system", kind: "boolean", expect: true, read: (s) => one(s.time?.synced) },

  { key: "temp.max", label: "Temperature", group: "Hardware", kind: "number", unit: "°C", instance: "sensor", agg: "max", platforms: "Linux (Windows/macOS where the OS exposes sensors)", read: (s, i) => many(s.temps, i, (t) => t.sensor, (t) => t.celsius) },
  { key: "fan.rpm", label: "Fan speed", group: "Hardware", kind: "number", unit: " RPM", instance: "fan", agg: "min", platforms: "Linux", read: (s, i) => many(s.fans, i, (f) => f.sensor, (f) => f.rpm) },
  { key: "battery.percent", label: "Battery charge", group: "Hardware", kind: "number", unit: "%", read: (s) => one(s.battery?.present ? s.battery.percent : undefined) },
  { key: "battery.on_ac", label: "Running on AC power", group: "Hardware", kind: "boolean", expect: true, read: (s) => one(s.battery?.present ? s.battery.charging : undefined) },
  { key: "smart.healthy", label: "SMART health passed", group: "Hardware", kind: "boolean", expect: true, instance: "device", platforms: "Needs smartmontools 7+", read: (s, i) => many(s.smart, i, (d) => d.device, (d) => d.passed) },
  { key: "smart.reallocated", label: "SMART reallocated sectors", group: "Hardware", kind: "number", instance: "device", agg: "max", read: (s, i) => many(s.smart, i, (d) => d.device, (d) => d.reallocated) },
  { key: "smart.pending", label: "SMART pending sectors", group: "Hardware", kind: "number", instance: "device", agg: "max", read: (s, i) => many(s.smart, i, (d) => d.device, (d) => d.pending) },
  { key: "smart.wear_percent", label: "SSD wear used", group: "Hardware", kind: "number", unit: "%", instance: "device", agg: "max", read: (s, i) => many(s.smart, i, (d) => d.device, (d) => d.wearPercent) },
  { key: "smart.temp", label: "Drive temperature", group: "Hardware", kind: "number", unit: "°C", instance: "device", agg: "max", read: (s, i) => many(s.smart, i, (d) => d.device, (d) => d.tempC) },
  { key: "raid.healthy", label: "RAID / pool healthy", group: "Hardware", kind: "boolean", expect: true, instance: "array", help: "mdadm, ZFS pools, Btrfs, Windows Storage Spaces, and storcli hardware RAID.", read: (s, i) => many(s.raid, i, (r) => r.name, (r) => r.healthy) },

  { key: "disk.used_percent", label: "Disk used", group: "Disks & filesystems", kind: "number", unit: "%", instance: "mount", agg: "max", read: (s, i) => many(s.disks, i, (d) => d.mount, (d) => d.percent) },
  { key: "disk.free_gb", label: "Disk free space", group: "Disks & filesystems", kind: "number", unit: " GB", instance: "mount", agg: "min", help: "Absolute free space — 5% of 10 TB is still 500 GB, so this often beats a percentage.", read: (s, i) => many(s.disks, i, (d) => d.mount, (d) => d.free / 1e9) },
  { key: "disk.inodes_percent", label: "Inodes used", group: "Disks & filesystems", kind: "number", unit: "%", instance: "mount", agg: "max", platforms: "Linux, macOS", read: (s, i) => many(s.disks, i, (d) => d.mount, (d) => d.inodesPercent) },
  { key: "disk.read_only", label: "Filesystem went read-only", group: "Disks & filesystems", kind: "boolean", expect: false, instance: "mount", read: (s, i) => many(s.disks, i, (d) => d.mount, (d) => d.readOnly) },
  { key: "disk.mounted", label: "Mount present and responsive", group: "Disks & filesystems", kind: "boolean", expect: true, instance: "mount", instanceRequired: true, help: "Fails if the mount point is missing or a network share has gone stale.", read: (s, i) => [{ value: Boolean(s.disks?.some((d) => lc(d.mount) === lc(i) && !d.stale)), label: i }] },
  { key: "diskio.read_mbps", label: "Disk read throughput", group: "Disks & filesystems", kind: "number", unit: " MB/s", instance: "device", agg: "max", read: (s, i) => many(s.diskIO, i, (d) => d.device, (d) => (d.readBytesPerSec != null ? d.readBytesPerSec / MB : undefined)) },
  { key: "diskio.write_mbps", label: "Disk write throughput", group: "Disks & filesystems", kind: "number", unit: " MB/s", instance: "device", agg: "max", read: (s, i) => many(s.diskIO, i, (d) => d.device, (d) => (d.writeBytesPerSec != null ? d.writeBytesPerSec / MB : undefined)) },
  { key: "diskio.iops", label: "Disk IOPS", group: "Disks & filesystems", kind: "number", instance: "device", agg: "max", read: (s, i) => many(s.diskIO, i, (d) => d.device, (d) => (d.readIops ?? 0) + (d.writeIops ?? 0)) },
  { key: "diskio.await_ms", label: "Disk latency (await)", group: "Disks & filesystems", kind: "number", unit: " ms", instance: "device", agg: "max", platforms: "Linux", read: (s, i) => many(s.diskIO, i, (d) => d.device, (d) => d.awaitMs) },
  { key: "diskio.busy_percent", label: "Disk busy", group: "Disks & filesystems", kind: "number", unit: "%", instance: "device", agg: "max", platforms: "Linux", read: (s, i) => many(s.diskIO, i, (d) => d.device, (d) => d.busyPercent) },

  { key: "net.rx_mbps", label: "Network receive", group: "Network", kind: "number", unit: " Mbps", instance: "interface", agg: "max", read: (s, i) => many(s.net, i, (n) => n.name, (n) => toMbps(n.rxBytesPerSec)) },
  { key: "net.tx_mbps", label: "Network transmit", group: "Network", kind: "number", unit: " Mbps", instance: "interface", agg: "max", read: (s, i) => many(s.net, i, (n) => n.name, (n) => toMbps(n.txBytesPerSec)) },
  { key: "net.errors_per_sec", label: "Interface errors / sec", group: "Network", kind: "number", instance: "interface", agg: "max", read: (s, i) => many(s.net, i, (n) => n.name, (n) => (n.rxErrorsPerSec ?? 0) + (n.txErrorsPerSec ?? 0)) },
  { key: "net.drops_per_sec", label: "Interface drops / sec", group: "Network", kind: "number", instance: "interface", agg: "max", read: (s, i) => many(s.net, i, (n) => n.name, (n) => (n.rxDropsPerSec ?? 0) + (n.txDropsPerSec ?? 0)) },
  { key: "net.up", label: "Interface is up", group: "Network", kind: "boolean", expect: true, instance: "interface", instanceRequired: true, read: (s, i) => [{ value: Boolean(s.net?.find((n) => lc(n.name) === lc(i))?.up), label: i }] },
  { key: "net.speed_mbps", label: "Link speed", group: "Network", kind: "number", unit: " Mbps", instance: "interface", instanceRequired: true, help: "Set 'warn below' to your expected speed to catch a port that renegotiated down to 100 Mbps.", read: (s, i) => many(s.net, i, (n) => n.name, (n) => n.speedMbps) },
  { key: "tcp.established", label: "TCP connections established", group: "Network", kind: "number", read: (s) => one(s.tcp?.ESTABLISHED) },
  { key: "tcp.time_wait", label: "TCP connections in TIME_WAIT", group: "Network", kind: "number", read: (s) => one(s.tcp?.TIME_WAIT) },
  { key: "tcp.close_wait", label: "TCP connections in CLOSE_WAIT", group: "Network", kind: "number", help: "A steadily growing CLOSE_WAIT count usually means an application is leaking sockets.", read: (s) => one(s.tcp?.CLOSE_WAIT) },
  { key: "port.listening", label: "Port is listening locally", group: "Network", kind: "boolean", expect: true, instance: "port", instanceRequired: true, read: (s, i) => [{ value: Boolean(s.listening?.some((l) => String(l.port) === String(i).trim())), label: `port ${i}` }] },

  { key: "updates.total", label: "Pending OS updates", group: "Security & updates", kind: "number", help: "apt, dnf/yum, Windows Update, or macOS softwareupdate — checked every 6 hours.", read: (s) => one(s.updates?.total) },
  { key: "updates.security", label: "Pending security updates", group: "Security & updates", kind: "number", read: (s) => one(s.updates?.security) },
  { key: "defender.enabled", label: "Defender antivirus enabled", group: "Security & updates", kind: "boolean", expect: true, platforms: "Windows", read: (s) => one(s.defender?.enabled) },
  { key: "defender.realtime", label: "Defender real-time protection on", group: "Security & updates", kind: "boolean", expect: true, platforms: "Windows", read: (s) => one(s.defender?.realtime) },
  { key: "defender.signature_age_days", label: "Defender signature age", group: "Security & updates", kind: "number", unit: " days", platforms: "Windows", read: (s) => one(s.defender?.signatureAgeDays) },
  { key: "firewall.enabled", label: "Firewall enabled", group: "Security & updates", kind: "boolean", expect: true, help: "Windows Firewall (all profiles), ufw/firewalld/nftables on Linux, the application firewall on macOS.", read: (s) => one(s.firewall?.enabled) },
  { key: "encryption.enabled", label: "System disk encrypted", group: "Security & updates", kind: "boolean", expect: true, help: "BitLocker, LUKS, or FileVault on the system/root volume.", read: (s) => one(s.encryption?.enabled) },
  { key: "logins.failed", label: "Failed logins (per report)", group: "Security & updates", kind: "number", help: "Windows event 4625 or sshd failures in the journal/auth.log since the previous report.", read: (s) => one(s.failedLogins) },
];

export const METRIC_BY_KEY = new Map(HOST_METRICS.map((m) => [m.key, m]));

const fmt = (n: number) => (Math.abs(n) >= 100 ? Math.round(n).toString() : (Math.round(n * 100) / 100).toString());

export function evaluateHostMetric(snapshot: Snapshot, config: Record<string, unknown>): MeasuredResult | null {
  const def = METRIC_BY_KEY.get(String(config.metric ?? ""));
  if (!def) return { status: "warn", latencyMs: null, message: `Unknown metric: ${config.metric}` };
  const instance = String(config.instance ?? "").trim();
  if (def.instanceRequired && !instance) return { status: "warn", latencyMs: null, message: `${def.label} needs a ${def.instance}` };
  const readings = def.read(snapshot, instance);
  if (readings == null || readings.length === 0) {
    return { status: "unknown", latencyMs: null, message: instance && def.instance ? `No ${def.instance} matching "${instance}" on this host` : `${def.label} isn't reported by this host${def.platforms ? ` (${def.platforms})` : ""}` };
  }

  if (def.kind === "boolean") {
    const expect = config.expect == null || config.expect === "" ? def.expect ?? true : config.expect === true || config.expect === "true";
    const bad = readings.filter((r) => Boolean(r.value) !== expect);
    const severity = (String(config.severity ?? "down") === "warn" ? "warn" : "down") as Status;
    if (bad.length) return { status: severity, latencyMs: null, message: `${def.label}: ${bad.map((b) => b.label).filter(Boolean).join(", ") || (expect ? "no" : "yes")}`, value: bad.length };
    return { status: "up", latencyMs: null, message: `${def.label}: ${expect ? "yes" : "no"}${readings.length > 1 ? ` (${readings.length})` : ""}`, value: 0 };
  }

  const nums = readings.map((r) => ({ value: Number(r.value), label: r.label }));
  const agg = def.agg ?? "max";
  const chosen = agg === "sum" ? { value: nums.reduce((a, n) => a + n.value, 0), label: "total" } : nums.reduce((a, b) => (agg === "min" ? (b.value < a.value ? b : a) : b.value > a.value ? b : a));
  const where = nums.length > 1 || (chosen.label && def.instance) ? ` (${chosen.label})` : "";
  return applyThresholds({ status: "up", latencyMs: null, message: `${def.label}: ${fmt(chosen.value)}${def.unit ?? ""}${where}`, value: chosen.value }, config, def.unit ?? "");
}

// host_reboot: bootTime moving forward means the host restarted. The
// failing status is held for holdMinutes so a normal N-consecutive alert
// rule still fires on what is really a single event.
export function evaluateReboot(snapshot: Snapshot, config: Record<string, unknown>, state: Record<string, unknown>): { result: MeasuredResult; state: Record<string, unknown> } {
  const boot = snapshot.bootTime;
  if (boot == null) return { result: { status: "unknown", latencyMs: null, message: "Agent didn't report a boot time" }, state };
  const prev = state.bootTime as number | undefined;
  // A few seconds of jitter in reported boot time is normal clock adjustment.
  const rebooted = prev != null && boot - prev > 60;
  const next = { bootTime: boot, rebootedAt: rebooted ? Date.now() : state.rebootedAt };
  const hold = Number(config.holdMinutes ?? 15) * 60_000;
  const since = next.rebootedAt ? Date.now() - Number(next.rebootedAt) : Infinity;
  const bootIso = new Date(boot * 1000).toISOString().replace("T", " ").slice(0, 16);
  if (since < hold) return { result: { status: String(config.severity ?? "warn") === "down" ? "down" : "warn", latencyMs: null, message: `Host rebooted at ${bootIso} UTC`, value: (snapshot.uptimeSeconds ?? 0) / 3600 }, state: next };
  return { result: { status: "up", latencyMs: null, message: `Up since ${bootIso} UTC`, value: (snapshot.uptimeSeconds ?? 0) / 3600 }, state: next };
}

function itemsFor(what: string, snapshot: Snapshot, inventory: Record<string, unknown> | null): string[] | null {
  switch (what) {
    case "inventory":
      return inventory ? Object.entries(inventory).filter(([k]) => k !== "collectedAt").map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`) : null;
    case "sessions":
      return snapshot.users?.sessions?.map((s) => `${s.user}@${s.terminal ?? "?"}${s.host ? ` from ${s.host}` : ""}`) ?? null;
    case "listening_ports":
      return snapshot.listening?.map((l) => `${l.proto}/${l.port}${l.process ? ` (${l.process})` : ""}`) ?? null;
    case "interfaces":
      return snapshot.net?.map((n) => `${n.name} ${n.mac ?? ""} ${(n.addrs ?? []).join(",")}`.trim()) ?? null;
    case "mounts":
      return snapshot.disks?.map((d) => `${d.mount} (${d.fstype ?? "?"})`) ?? null;
    default:
      return null;
  }
}

// host_change: config drift/new-login style alerts. The first report sets
// the baseline; later differences are listed as added/removed.
export function evaluateChange(snapshot: Snapshot, inventory: Record<string, unknown> | null, config: Record<string, unknown>, state: Record<string, unknown>): { result: MeasuredResult; state: Record<string, unknown> } {
  const what = String(config.what ?? "inventory");
  const items = itemsFor(what, snapshot, inventory);
  if (!items) return { result: { status: "unknown", latencyMs: null, message: `This host doesn't report ${what.replace(/_/g, " ")}` }, state };
  const sorted = [...new Set(items)].sort();
  const hash = crypto.createHash("sha256").update(sorted.join("\n")).digest("hex");
  const prevItems = (state.items as string[] | undefined) ?? null;
  const next: Record<string, unknown> = { hash, items: sorted, changedAt: state.changedAt, lastChange: state.lastChange };
  if (prevItems && state.hash !== hash) {
    const added = sorted.filter((x) => !prevItems.includes(x));
    const removed = prevItems.filter((x) => !sorted.includes(x));
    // Sessions only alert on new logins — logouts are routine.
    if (what !== "sessions" || added.length) {
      next.changedAt = Date.now();
      next.lastChange = [added.length ? `+ ${added.join(", ")}` : "", removed.length ? `− ${removed.join(", ")}` : ""].filter(Boolean).join("  ");
    }
  }
  const hold = Number(config.holdMinutes ?? 15) * 60_000;
  if (next.changedAt && Date.now() - Number(next.changedAt) < hold) {
    return { result: { status: String(config.severity ?? "warn") === "down" ? "down" : "warn", latencyMs: null, message: `${what.replace(/_/g, " ")} changed: ${String(next.lastChange).slice(0, 500)}`, value: sorted.length }, state: next };
  }
  return { result: { status: "up", latencyMs: null, message: prevItems ? `No change (${sorted.length} ${what.replace(/_/g, " ")})` : `Baseline recorded (${sorted.length} ${what.replace(/_/g, " ")})`, value: sorted.length }, state: next };
}
