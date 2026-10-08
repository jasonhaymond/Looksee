import type { Snapshot } from "./hostMetrics.js";

export type Suggestion = { key: string; name: string; type: string; config: Record<string, unknown>; reason: string; intervalSeconds?: number };

type HostLike = { name: string; os: string | null; lastSnapshot: unknown; availableServices: unknown; inventory: unknown };
type ExistingCheck = { type: string; config: unknown };

const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|vEthernet|tun|tap|wg|zt|tailscale|Loopback|isatap|Teredo|Bluetooth|Local Area Connection\*)/i;
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup|nsfs|autofs|fuse\.snapfuse|efivarfs|ramfs)$/i;

// Services worth a dedicated up/down check whenever the agent sees them.
const NOTABLE_SERVICES = ["ssh", "sshd", "nginx", "caddy", "apache2", "httpd", "postgresql", "mysql", "mariadb", "docker", "containerd", "redis-server", "redis", "smbd", "nfs-server", "pihole-FTL", "unbound", "named", "wireguard", "tailscaled", "zfs-zed", "pveproxy", "pvedaemon", "MSSQLSERVER", "W3SVC", "WinRM", "TermService", "Spooler", "DNS", "NTDS", "DHCPServer", "vmms", "VeeamBackupSvc"];

function key(s: Pick<Suggestion, "type" | "config">) {
  const c = s.config as Record<string, unknown>;
  return [s.type, c.metric ?? "", c.instance ?? c.mount ?? c.serviceName ?? c.container ?? c.what ?? ""].join("|").toLowerCase();
}

// L10: turn one agent snapshot into a checklist of sensible checks with
// sensible thresholds, minus whatever this host already has.
export function suggestChecks(host: HostLike, existing: ExistingCheck[]): Suggestion[] {
  const s = (host.lastSnapshot ?? {}) as Snapshot & { availableContainers?: string[] };
  const isWindows = /windows/i.test(host.os ?? "") || /windows/i.test(JSON.stringify(host.inventory ?? {}));
  const out: Suggestion[] = [];
  const add = (name: string, type: string, config: Record<string, unknown>, reason: string, intervalSeconds?: number) => {
    const sug = { name: `${host.name}: ${name}`, type, config, reason, intervalSeconds, key: "" };
    sug.key = key(sug);
    out.push(sug);
  };

  add("agent online", "agent_heartbeat", { maxSilenceSeconds: 180 }, "Alerts if the agent stops reporting (host down, agent crashed, network cut).");
  add("unexpected reboot", "host_reboot", { holdMinutes: 15, severity: "warn" }, "Flags any reboot so an unplanned one doesn't go unnoticed.");
  if (s.cpu) add("CPU", "host_metric", { metric: "cpu.percent", warnAbove: 85, criticalAbove: 97 }, "Sustained CPU saturation.");
  if (s.mem) add("memory", "host_metric", { metric: "mem.percent", warnAbove: 90, criticalAbove: 97 }, "Memory pressure before the OOM killer acts.");
  if (s.mem?.swapTotal) add("swap", "host_metric", { metric: "swap.percent", warnAbove: 50, criticalAbove: 85 }, "Heavy swapping slows everything on the host.");
  if (s.load?.l5 != null && !isWindows) add("load (5 min)", "host_metric", { metric: "load.5", warnAbove: 1.5, criticalAbove: 3 }, "Run-queue length per core.");
  if (s.cpu?.steal != null && s.cpu.steal > 0) add("CPU steal", "host_metric", { metric: "cpu.steal", warnAbove: 10, criticalAbove: 25 }, "This looks like a VM; steal shows an oversubscribed hypervisor.");

  for (const d of s.disks ?? []) {
    if (PSEUDO_FS.test(d.fstype ?? "") || d.total < 1e9) continue;
    add(`disk ${d.mount}`, "host_metric", { metric: "disk.used_percent", instance: d.mount, warnAbove: 85, criticalAbove: 95 }, `${(d.total / 1e9).toFixed(0)} GB ${d.fstype ?? ""} volume.`);
    add(`disk ${d.mount} forecast`, "disk_forecast", { mount: d.mount, warnDays: 14, criticalDays: 3, lookbackDays: 7 }, "Warns days before the volume fills at its current growth rate.", 3600);
    if (d.inodesPercent != null) add(`inodes ${d.mount}`, "host_metric", { metric: "disk.inodes_percent", instance: d.mount, warnAbove: 85, criticalAbove: 95 }, "Running out of inodes fails writes even with free space.");
    add(`${d.mount} read-only`, "host_metric", { metric: "disk.read_only", instance: d.mount, severity: "down" }, "Filesystems remount read-only after I/O errors.");
  }
  for (const n of s.net ?? []) {
    if (VIRTUAL_IFACE.test(n.name) || !n.up) continue;
    add(`link ${n.name}`, "host_metric", { metric: "net.up", instance: n.name, severity: "down" }, `Physical interface${n.speedMbps ? ` at ${n.speedMbps} Mbps` : ""}.`);
    add(`errors ${n.name}`, "host_metric", { metric: "net.errors_per_sec", instance: n.name, warnAbove: 1, criticalAbove: 10 }, "Interface errors point at cabling/duplex problems.");
  }
  for (const d of s.smart ?? []) add(`SMART ${d.device}`, "host_metric", { metric: "smart.healthy", instance: d.device, severity: "down" }, `${d.model ?? "Drive"} self-assessment.`);
  for (const d of s.smart ?? []) if (d.wearPercent != null) add(`SSD wear ${d.device}`, "host_metric", { metric: "smart.wear_percent", instance: d.device, warnAbove: 80, criticalAbove: 95 }, "SSD endurance used.");
  for (const r of s.raid ?? []) add(`${r.kind} ${r.name}`, "host_metric", { metric: "raid.healthy", instance: r.name, severity: "down" }, `${r.kind} array/pool health.`);
  if (s.updates) add("security updates", "host_metric", { metric: "updates.security", warnAbove: 0, criticalAbove: 20 }, "Outstanding security patches.", 3600);
  if (s.pendingReboot != null) add("reboot pending", "host_metric", { metric: "reboot.pending", severity: "warn" }, "Updates installed but not active until a reboot.", 3600);
  if (s.time?.synced != null) add("clock sync", "host_metric", { metric: "time.synced", severity: "warn" }, "Unsynchronized clocks break TLS, Kerberos and log correlation.");
  if (s.time?.offsetMs != null) add("clock offset", "host_metric", { metric: "time.offset_ms", warnAbove: 500, criticalAbove: 5000 }, "Drift from NTP time.");
  if (s.firewall) add("firewall", "host_metric", { metric: "firewall.enabled", severity: "warn" }, "Host firewall switched off.", 3600);
  if (s.encryption) add("disk encryption", "host_metric", { metric: "encryption.enabled", severity: "warn" }, "System volume encryption state.", 3600);
  if (s.defender) {
    add("Defender real-time", "host_metric", { metric: "defender.realtime", severity: "down" }, "Real-time antivirus protection.");
    add("Defender signatures", "host_metric", { metric: "defender.signature_age_days", warnAbove: 3, criticalAbove: 7 }, "Out-of-date antivirus definitions.", 3600);
  }
  if (s.failedLogins != null) add("failed logins", "host_metric", { metric: "logins.failed", warnAbove: 10, criticalAbove: 50 }, "Brute-force attempts against this host.");
  if (s.battery?.present) add("battery", "host_metric", { metric: "battery.percent", warnBelow: 30, criticalBelow: 10 }, "Battery charge.");
  if (s.temps?.length) add("temperature", "host_metric", { metric: "temp.max", warnAbove: 80, criticalAbove: 90 }, `${s.temps.length} temperature sensor(s).`);

  add(isWindows ? "stopped automatic services" : "failed systemd units", "agent_services_overview", { exclude: "" }, isWindows ? "Automatic-start services that aren't running." : "Any systemd unit in a failed state.");
  const services = Array.isArray(host.availableServices) ? (host.availableServices as string[]) : [];
  for (const svc of services.filter((x) => NOTABLE_SERVICES.some((n) => n.toLowerCase() === x.toLowerCase()))) add(`service ${svc}`, "agent_service", { serviceName: svc }, "Well-known service found on this host.");
  if (s.availableContainers?.length) add("Docker containers", "agent_docker", { container: "*", measure: "status" }, `${s.availableContainers.length} container(s) found.`);

  const have = new Set(existing.map((e) => key({ type: e.type, config: (e.config ?? {}) as Record<string, unknown> })));
  return out.filter((sug) => !have.has(sug.key));
}
