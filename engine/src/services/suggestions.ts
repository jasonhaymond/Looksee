import type { Snapshot } from "./endpointMetrics.js";

export type Suggestion = { key: string; name: string; type: string; config: Record<string, unknown>; reason: string; intervalSeconds?: number; group?: string; endpointScoped?: boolean };

type EndpointLike = { name: string; hostname?: string | null; os: string | null; lastSnapshot: unknown; availableServices: unknown; inventory: unknown; processInventory?: unknown; serviceInventory?: unknown; availableProcesses?: unknown };
type ServiceRow = { name: string; displayName?: string; state?: string; startType?: string };
type ProcessRow = { name: string; memoryMb?: number };
type ExistingCheck = { type: string; config: unknown };

const VIRTUAL_IFACE = /^(lo|docker|veth|br-|virbr|vmnet|vEthernet|tun|tap|wg|zt|tailscale|Loopback|isatap|Teredo|Bluetooth|Local Area Connection\*)/i;
const PSEUDO_FS = /^(tmpfs|devtmpfs|overlay|squashfs|proc|sysfs|cgroup|nsfs|autofs|fuse\.snapfuse|efivarfs|ramfs)$/i;

// Services worth a dedicated up/down check whenever the agent sees them.
const NOTABLE_SERVICES = ["ssh", "sshd", "nginx", "caddy", "apache2", "httpd", "postgresql", "mysql", "mariadb", "docker", "containerd", "redis-server", "redis", "smbd", "nfs-server", "pihole-FTL", "unbound", "named", "wireguard", "tailscaled", "zfs-zed", "pveproxy", "pvedaemon", "MSSQLSERVER", "W3SVC", "WinRM", "TermService", "Spooler", "DNS", "NTDS", "DHCPServer", "vmms", "VeeamBackupSvc"];

function key(s: Pick<Suggestion, "type" | "config">) {
  const c = s.config as Record<string, unknown>;
  return [s.type, c.metric ?? "", c.instance ?? c.mount ?? c.serviceName ?? c.container ?? c.what ?? c.url ?? c.logName ?? c.unit ?? "", c.port ?? "", c.measure && c.measure !== "count" && c.measure !== "status" ? c.measure : ""].join("|").toLowerCase();
}

// Well-known listening ports -> the check that proves the service works
// from the network, not just that its process exists.
const PORT_CHECKS: Record<number, { label: string; type: string; config: (addr: string) => Record<string, unknown> }[]> = {
  22: [{ label: "SSH", type: "protocol", config: (a) => ({ host: a, protocol: "ssh", port: 22 }) }],
  25: [{ label: "SMTP", type: "protocol", config: (a) => ({ host: a, protocol: "smtp", port: 25 }) }],
  53: [{ label: "DNS server", type: "tcp", config: (a) => ({ host: a, port: 53 }) }],
  80: [{ label: "web (HTTP)", type: "http", config: (a) => ({ url: `http://${a}/`, method: "GET" }) }],
  389: [{ label: "LDAP", type: "tcp", config: (a) => ({ host: a, port: 389 }) }],
  443: [
    { label: "web (HTTPS)", type: "http", config: (a) => ({ url: `https://${a}/`, method: "GET", insecureSkipVerify: true }) },
    { label: "TLS certificate", type: "ssl_cert", config: (a) => ({ host: a, port: 443, warnDays: 14, criticalDays: 3, checkHostname: false }) },
  ],
  445: [{ label: "file sharing (SMB)", type: "tcp", config: (a) => ({ host: a, port: 445 }) }],
  587: [{ label: "SMTP submission", type: "tcp", config: (a) => ({ host: a, port: 587 }) }],
  993: [{ label: "IMAPS", type: "tcp", config: (a) => ({ host: a, port: 993 }) }],
  1433: [{ label: "SQL Server port", type: "tcp", config: (a) => ({ host: a, port: 1433 }) }],
  1883: [{ label: "MQTT broker", type: "mqtt", config: (a) => ({ host: a, port: 1883 }) }],
  3000: [{ label: "web app on :3000", type: "http", config: (a) => ({ url: `http://${a}:3000/`, method: "GET" }) }],
  3306: [{ label: "MySQL/MariaDB port", type: "tcp", config: (a) => ({ host: a, port: 3306 }) }],
  3389: [{ label: "Remote Desktop", type: "tcp", config: (a) => ({ host: a, port: 3389 }) }],
  5432: [{ label: "PostgreSQL port", type: "tcp", config: (a) => ({ host: a, port: 5432 }) }],
  5900: [{ label: "VNC", type: "tcp", config: (a) => ({ host: a, port: 5900 }) }],
  6379: [{ label: "Redis port", type: "tcp", config: (a) => ({ host: a, port: 6379 }) }],
  8006: [{ label: "Proxmox web UI", type: "http", config: (a) => ({ url: `https://${a}:8006/`, method: "GET", insecureSkipVerify: true }) }],
  8080: [{ label: "web app on :8080", type: "http", config: (a) => ({ url: `http://${a}:8080/`, method: "GET" }) }],
  8443: [{ label: "web app on :8443", type: "http", config: (a) => ({ url: `https://${a}:8443/`, method: "GET", insecureSkipVerify: true }) }],
  9090: [{ label: "Prometheus/Cockpit on :9090", type: "tcp", config: (a) => ({ host: a, port: 9090 }) }],
  9200: [{ label: "Elasticsearch", type: "http", config: (a) => ({ url: `http://${a}:9200/_cluster/health`, method: "GET", bodyNotContains: '"status":"red"' }) }],
  27017: [{ label: "MongoDB port", type: "tcp", config: (a) => ({ host: a, port: 27017 }) }],
  32400: [{ label: "Plex", type: "http", config: (a) => ({ url: `http://${a}:32400/identity`, method: "GET" }) }],
};

// Server software worth a "is it running" check when found, by process or
// service name. Matched case-insensitively against the whole name.
const NOTABLE = /^(sshd?|nginx|caddy|apache2|httpd|traefik|haproxy|postgres(ql)?(@.*)?|mysqld?|mariadbd?|mariadb|mongod|redis-server|redis|memcached|sqlservr(\.exe)?|MSSQL\$?\w*|MSSQLSERVER|SQLSERVERAGENT|W3SVC|IISADMIN|WinRM|TermService|Spooler|DNS|NTDS|DHCPServer|vmms|Veeam\w*|docker(d)?|containerd|kubelet|k3s|smbd|nmbd|nfs-server|vsftpd|proftpd|postfix|exim4?|dovecot|named|bind9|unbound|pihole-FTL|AdGuardHome|wg-quick@\w+|openvpn(@\w+)?|tailscaled|zerotier-one|plexmediaserver|Plex Media Server(\.exe)?|jellyfin|emby-server|home-?assistant|php-fpm\S*|tomcat\d*|jenkins|gitlab-runsvdir|elasticsearch|grafana-server|grafana|prometheus|influxd|mosquitto|unifi|zabbix-agent2?|crowdsec|fail2ban|chronyd?|ntpd?|smartd|zfs-zed|pveproxy|pvedaemon|ceph-\w+|apcupsd|nut-server|upsd|cups(d)?|nextcloud\w*|syncthing|minio|rabbitmq-server|kafka|nginx-proxy-manager|portainer)$/i;
const DATABASE_PROCESS = /^(postgres|mysqld|mariadbd|mongod|redis-server|sqlservr\.exe|influxd|elasticsearch|memcached)$/i;

// L10: turn one agent snapshot into a checklist of sensible checks with
// sensible thresholds, minus whatever this host already has.
export function suggestChecks(host: EndpointLike, existing: ExistingCheck[]): Suggestion[] {
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

  // Services: from the 4.0 inventory (state + start type) when there is
  // one, else the older name-only list.
  const inventory = Array.isArray(host.serviceInventory) ? (host.serviceInventory as ServiceRow[]) : null;
  const names = Array.isArray(host.availableServices) ? (host.availableServices as string[]) : [];
  const serviceRows: ServiceRow[] = inventory ?? names.map((name) => ({ name }));
  const seenServices = new Set<string>();
  for (const svc of serviceRows) {
    const base = svc.name.replace(/\.service$/, "");
    const enabled = !svc.startType || /auto|enabled|static/i.test(svc.startType);
    const running = !svc.state || /running|active/i.test(svc.state);
    if (!(NOTABLE.test(base) || NOTABLE_SERVICES.some((n) => n.toLowerCase() === base.toLowerCase())) || !enabled || !running) continue;
    seenServices.add(base.toLowerCase());
    add(`service ${svc.displayName && svc.displayName !== base ? `${svc.displayName} (${base})` : base}`, "agent_service", { serviceName: base }, svc.state ? `${svc.state}, starts ${svc.startType ?? "automatically"}.` : "Well-known service found on this host.");
  }

  // Processes without a matching service (apps started by hand, Docker on
  // a desktop, databases run as plain processes).
  const procs: ProcessRow[] = Array.isArray(host.processInventory) ? (host.processInventory as ProcessRow[]) : Array.isArray(host.availableProcesses) ? (host.availableProcesses as string[]).map((name) => ({ name })) : [];
  const procNames = [...new Set(procs.map((p) => p.name))];
  for (const name of procNames) {
    const base = name.replace(/\.exe$/i, "");
    if (!NOTABLE.test(name) && !NOTABLE.test(base)) continue;
    // A process that belongs to a service already suggested (postgres ->
    // postgresql, mysqld -> mysql) would only duplicate that check.
    const lower = base.toLowerCase().replace(/d$/, "");
    if ([...seenServices].some((s) => s.startsWith(lower) || lower.startsWith(s))) continue;
    add(`process ${name}`, "agent_process", { serviceName: name, measure: "count", minCount: 1 }, "Server software running as a process on this host.");
  }
  for (const name of procNames.filter((n) => DATABASE_PROCESS.test(n))) {
    const mem = procs.filter((p) => p.name === name).reduce((a, p) => a + (p.memoryMb ?? 0), 0);
    if (mem > 0) add(`${name} memory`, "agent_process", { serviceName: name, measure: "memory_mb", warnAbove: Math.round(mem * 2), criticalAbove: Math.round(mem * 3) }, `Database process using ${Math.round(mem)} MB now — warns at twice that.`);
  }

  // Containers: one overview check, plus one per container when there are
  // few enough to be worth naming individually.
  if (s.availableContainers?.length) {
    add("Docker containers", "agent_docker", { container: "*", measure: "status" }, `${s.availableContainers.length} container(s) found.`);
    if (s.availableContainers.length <= 25) for (const c of s.availableContainers) add(`container ${c}`, "agent_docker", { container: c, measure: "status" }, "Running and healthy.");
    add("container restarts", "agent_docker", { container: "*", measure: "restart_count", warnAbove: 0, criticalAbove: 3 }, "Crash-looping containers.");
  }

  // OS logs: the events worth an alert on any machine.
  if (isWindows) {
    add("unexpected shutdowns", "agent_eventlog", { logName: "System", eventIds: "41,6008", levels: "critical,error", severity: "down" }, "Kernel-Power 41 / EventLog 6008 — the machine lost power or crashed.");
    add("service crashes", "agent_eventlog", { logName: "System", eventIds: "7031,7034", levels: "critical,error,warning", severity: "warn" }, "Service Control Manager: a service terminated unexpectedly.");
    add("disk errors", "agent_eventlog", { logName: "System", eventIds: "7,11,51,153", levels: "critical,error,warning", severity: "warn" }, "Bad blocks, controller errors and I/O retries.");
  } else if (/linux/i.test(host.os ?? "") || s.load) {
    add("critical journal entries", "agent_journal", { unit: "", priority: "crit", pattern: "" }, "Anything logged at critical or worse.");
  }

  // Network-side checks for listening services: the agent proves the
  // process runs, these prove it answers from the network.
  const address = host.hostname || primaryAddress(s);
  if (address) {
    const ports = new Set((s.listening ?? []).filter((l) => l.proto?.startsWith("tcp") && !/^(127\.|::1$|\[::1\])/.test(l.address ?? "")).map((l) => l.port));
    for (const port of ports) {
      for (const pc of PORT_CHECKS[port] ?? []) add(`${pc.label} reachable`, pc.type, pc.config(address), `Port ${port} is listening${(s.listening ?? []).find((l) => l.port === port)?.process ? ` (${(s.listening ?? []).find((l) => l.port === port)!.process})` : ""}; checks it answers over the network at ${address}.`);
    }
    add("reachable (ping)", "ping", { host: address, count: 3, lossWarnPercent: 20, lossCriticalPercent: 100 }, `Network reachability of ${address} from Looksee.`);
  }

  const have = new Set(existing.map((e) => key({ type: e.type, config: (e.config ?? {}) as Record<string, unknown> })));
  const unique = new Map<string, Suggestion>();
  for (const sug of out) if (!have.has(sug.key) && !unique.has(sug.key)) unique.set(sug.key, { ...sug, group: groupOf(sug.type) });
  return [...unique.values()];
}

function groupOf(type: string): string {
  if (type === "host_metric" || type === "disk_forecast" || type === "agent_heartbeat" || type === "host_reboot") return "Health & resources";
  if (type === "agent_service" || type === "agent_process" || type === "agent_services_overview") return "Services & software";
  if (type === "agent_docker") return "Containers";
  if (type === "agent_eventlog" || type === "agent_journal") return "Logs";
  return "Network reachability";
}

// The host's main LAN address, for network checks against it.
function primaryAddress(s: Snapshot): string | null {
  for (const n of s.net ?? []) {
    if (!n.up || VIRTUAL_IFACE.test(n.name)) continue;
    for (const a of n.addrs ?? []) {
      const ip = a.split("/")[0];
      if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip)) return ip;
    }
  }
  return null;
}
