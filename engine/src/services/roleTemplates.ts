// Server-role and security templates for endpoints: the checks a web server,
// database server, DNS server, mail server, file server, domain controller,
// hypervisor, Docker host, backup server or print server should have — and a
// security baseline per operating system.
//
// Where this sits: GET /api/endpoints/:id/role-templates lists every
// template with whether the endpoint looks like that role (detected from
// what its agent reports: services, processes, listening ports, installed
// packages) and the checks it would add (minus ones already there);
// POST …/:templateId/apply creates them (routes/endpoints.ts). Detected
// roles also feed the endpoint's ordinary suggestions (services/suggestions.ts).
//
// Each template returns Suggestion objects — the same shape as suggested
// checks, so they're created the same way and duplicates are recognised by
// the same key.

import type { Snapshot } from "./endpointMetrics.js";
import { suggestionKey, type Suggestion } from "./suggestions.js";
import type { SoftwareReport } from "./software.js";

/** What's known about an endpoint, gathered once for all templates. */
export type HostFacts = {
  name: string;
  os: string;
  isWindows: boolean;
  isLinux: boolean;
  isMac: boolean;
  isServer: boolean;
  // Lower-case names of running services, processes and installed packages.
  services: Set<string>;
  processes: Set<string>;
  packages: Set<string>;
  // TCP ports listening on a non-loopback address.
  ports: Set<number>;
  // The address network checks should use (hostname, else LAN IP).
  address: string | null;
  containers: string[];
};

type EndpointRow = {
  name: string;
  hostname?: string | null;
  os: string | null;
  inventory?: unknown;
  lastSnapshot: unknown;
  serviceInventory?: unknown;
  availableServices?: unknown;
  processInventory?: unknown;
  availableProcesses?: unknown;
  software?: unknown;
};

/**
 * Gathers the facts templates detect roles from.
 *
 * @param host the endpoint row
 * @param address the address for network checks (from suggestions.ts)
 */
export function hostFacts(host: EndpointRow, address: string | null): HostFacts {
  const s = (host.lastSnapshot ?? {}) as Snapshot & { availableContainers?: string[] };
  const inv = JSON.stringify(host.inventory ?? {});
  // What the OS is, from its name and inventory, as plain lower-case text.
  const os = `${host.os ?? ""} ${inv}`.toLowerCase();
  const mentions = (...words: string[]) => words.some((w) => os.includes(w));
  const lower = (list: unknown, pick: (x: Record<string, unknown>) => unknown = (x) => x.name) =>
    new Set((Array.isArray(list) ? list : []).map((x) => String(typeof x === "string" ? x : pick(x as Record<string, unknown>) ?? "").toLowerCase().replace(/\.service$|\.exe$/, "")).filter(Boolean));
  // Only services that run and start by themselves count — a disabled,
  // stopped service doesn't make a role, and a check on it would just fail.
  const running = Array.isArray(host.serviceInventory)
    ? (host.serviceInventory as Record<string, unknown>[]).filter((svc) => (!svc.state || /running|active/i.test(String(svc.state)) && !/inactive/i.test(String(svc.state))) && (!svc.startType || /auto|enabled|static/i.test(String(svc.startType))))
    : null;
  const services = new Set(running ? [...lower(running)] : [...lower(host.availableServices)]);
  const processes = new Set([...lower(host.processInventory), ...lower(host.availableProcesses)]);
  const sw = host.software as SoftwareReport | null | undefined;
  const packages = new Set((sw?.packages ?? []).map((p) => p.n.toLowerCase()));
  const ports = new Set((s.listening ?? []).filter((l) => l.proto?.startsWith("tcp") && !/^(127\.|::1$|\[::1\])/.test(l.address ?? "")).map((l) => l.port));
  return {
    name: host.name,
    os: host.os ?? "",
    isWindows: mentions("windows"),
    isLinux: mentions("linux", "ubuntu", "debian", "rocky", "alma", "centos", "fedora", "alpine", "arch") || Boolean(s.load && !mentions("darwin", "mac")),
    isMac: mentions("darwin", "macos", "mac os"),
    isServer: mentions("server", "linux", "ubuntu", "debian", "rocky", "alma", "centos"),
    services,
    processes,
    packages,
    ports,
    address: host.hostname || address,
    containers: s.availableContainers ?? [],
  };
}

/** A template: when it applies, and the checks it adds. */
export type RoleTemplate = { id: string; label: string; kind: "role" | "security"; description: string; detect: (h: HostFacts) => boolean; checks: (h: HostFacts) => Omit<Suggestion, "key">[] };

/** Whether any of the names is a running service, process or installed package. */
const has = (h: HostFacts, ...names: string[]) => names.some((n) => h.services.has(n.toLowerCase()) || h.processes.has(n.toLowerCase()) || h.packages.has(n.toLowerCase()));

/** A service check for each of the names that runs here. */
function services(h: HostFacts, ...names: string[]): Omit<Suggestion, "key">[] {
  return names
    .filter((n) => h.services.has(n.toLowerCase()))
    .map((n) => ({ name: `${h.name}: service ${n}`, type: "agent_service", config: { serviceName: n }, reason: `${n} runs on this endpoint.` }));
}

/** Shorthand for one suggested check. */
const check = (h: HostFacts, name: string, type: string, config: Record<string, unknown>, reason: string, intervalSeconds?: number): Omit<Suggestion, "key"> => ({ name: `${h.name}: ${name}`, type, config, reason, intervalSeconds });

export const ROLE_TEMPLATES: RoleTemplate[] = [
  {
    id: "web",
    label: "Web server",
    kind: "role",
    description: "The web server process, its pages answering over HTTP(S), certificate expiry, and its error log.",
    detect: (h) => has(h, "nginx", "apache2", "httpd", "caddy", "W3SVC", "traefik", "haproxy", "lighttpd") || h.ports.has(80) || h.ports.has(443),
    checks: (h) => [
      ...services(h, "nginx", "apache2", "httpd", "caddy", "W3SVC", "traefik", "haproxy", "lighttpd"),
      ...(h.address && (h.ports.has(80) || !h.ports.has(443)) ? [check(h, "website (HTTP)", "http", { url: `http://${h.address}/`, method: "GET" }, "The site answers on port 80.")] : []),
      ...(h.address && h.ports.has(443)
        ? [check(h, "website (HTTPS)", "http", { url: `https://${h.address}/`, method: "GET", insecureSkipVerify: true }, "The site answers on port 443."), check(h, "TLS certificate", "ssl_cert", { host: h.address, port: 443, warnDays: 14, criticalDays: 3, checkHostname: false }, "Warns two weeks before the certificate expires.", 3600)]
        : []),
      ...(h.isLinux && has(h, "nginx") ? [check(h, "nginx errors", "agent_log", { path: "/var/log/nginx/error.log", pattern: "\\[(crit|alert|emerg)\\]", severity: "warn" }, "Critical errors in nginx's error log.")] : []),
      ...(h.isLinux && has(h, "apache2", "httpd") ? [check(h, "Apache errors", "agent_log", { path: h.services.has("httpd") ? "/var/log/httpd/error_log" : "/var/log/apache2/error.log", pattern: "\\[(\\w+:)?(crit|alert|emerg)\\]", severity: "warn" }, "Critical errors in Apache's error log.")] : []),
    ],
  },
  {
    id: "database",
    label: "Database server",
    kind: "role",
    description: "The database service, its port answering, its memory use and the disk it lives on filling up.",
    detect: (h) => has(h, "postgresql", "postgres", "mysql", "mysqld", "mariadb", "mariadbd", "mongod", "redis-server", "MSSQLSERVER", "sqlservr") || [5432, 3306, 1433, 27017, 6379].some((p) => h.ports.has(p)),
    checks: (h) => {
      const out = services(h, "postgresql", "mysql", "mariadb", "mongod", "redis-server", "MSSQLSERVER", "SQLSERVERAGENT");
      const ports: [number, string][] = [
        [5432, "PostgreSQL"],
        [3306, "MySQL/MariaDB"],
        [1433, "SQL Server"],
        [27017, "MongoDB"],
        [6379, "Redis"],
      ];
      for (const [p, label] of ports) if (h.address && h.ports.has(p)) out.push(check(h, `${label} port`, "tcp", { host: h.address, port: p }, `${label} accepts connections from the network.`));
      if (h.isWindows && has(h, "MSSQLSERVER")) out.push(check(h, "SQL Server errors", "agent_eventlog", { logName: "Application", provider: "MSSQLSERVER", levels: "critical,error", severity: "warn" }, "Errors SQL Server logs to the Application log."));
      return out;
    },
  },
  {
    id: "dns",
    label: "DNS server",
    kind: "role",
    description: "The DNS service, and that it answers queries from the network.",
    detect: (h) => has(h, "named", "bind9", "unbound", "pihole-FTL", "AdGuardHome", "dnsmasq", "DNS", "coredns") || h.ports.has(53),
    checks: (h) => [
      ...services(h, "named", "bind9", "unbound", "pihole-FTL", "AdGuardHome", "dnsmasq", "DNS"),
      ...(h.address ? [check(h, "answers DNS", "dns", { hostname: "example.com", recordType: "A", server: h.address }, "Resolves a public name through this server, proving it answers and can reach upstream.")] : []),
    ],
  },
  {
    id: "mail",
    label: "Mail server",
    kind: "role",
    description: "The mail services and their SMTP / IMAP ports answering.",
    detect: (h) => has(h, "postfix", "exim4", "exim", "dovecot", "MSExchangeTransport", "MSExchangeIS", "sendmail") || h.ports.has(25),
    checks: (h) => [
      ...services(h, "postfix", "exim4", "dovecot", "MSExchangeTransport", "MSExchangeIS", "MSExchangeFrontEndTransport"),
      ...(h.address && h.ports.has(25) ? [check(h, "SMTP", "protocol", { host: h.address, protocol: "smtp", port: 25 }, "Accepts mail on port 25.")] : []),
      ...(h.address && h.ports.has(993) ? [check(h, "IMAPS", "protocol", { host: h.address, protocol: "imaps", port: 993 }, "Mailboxes reachable over IMAPS.")] : []),
      ...(h.address && h.ports.has(587) ? [check(h, "SMTP submission", "protocol", { host: h.address, protocol: "submission", port: 587 }, "Clients can send mail on 587.")] : []),
    ],
  },
  {
    id: "file",
    label: "File server",
    kind: "role",
    description: "File-sharing services and their ports (SMB, NFS).",
    detect: (h) => has(h, "smbd", "nfs-server", "nfsd") || (h.isWindows && h.isServer && h.services.has("lanmanserver") && h.ports.has(445)),
    checks: (h) => [
      ...services(h, "smbd", "nmbd", "nfs-server", "LanmanServer"),
      ...(h.address && h.ports.has(445) ? [check(h, "file sharing (SMB)", "tcp", { host: h.address, port: 445 }, "SMB shares reachable.")] : []),
      ...(h.address && h.ports.has(2049) ? [check(h, "NFS", "tcp", { host: h.address, port: 2049 }, "NFS exports reachable.")] : []),
    ],
  },
  {
    id: "dc",
    label: "Domain controller",
    kind: "role",
    description: "Active Directory services, LDAP and Kerberos answering, replication and directory errors, and the clock (Kerberos fails beyond 5 minutes of drift).",
    detect: (h) => h.isWindows && has(h, "NTDS"),
    checks: (h) => [
      ...services(h, "NTDS", "DNS", "Netlogon", "Kdc", "W32Time", "DFSR", "ADWS"),
      ...(h.address ? [check(h, "LDAP", "tcp", { host: h.address, port: 389 }, "Directory answers LDAP."), check(h, "Kerberos", "tcp", { host: h.address, port: 88 }, "Kerberos authentication reachable.")] : []),
      check(h, "directory service errors", "agent_eventlog", { logName: "Directory Service", levels: "critical,error", severity: "warn" }, "Errors in the Directory Service log (replication, database)."),
      check(h, "DFS replication errors", "agent_eventlog", { logName: "DFS Replication", levels: "critical,error", severity: "warn" }, "SYSVOL replication problems."),
      check(h, "clock offset", "host_metric", { metric: "time.offset_ms", warnAbove: 1000, criticalAbove: 120000 }, "Kerberos breaks when clocks drift more than 5 minutes."),
    ],
  },
  {
    id: "hypervisor",
    label: "Hypervisor",
    kind: "role",
    description: "Hypervisor services and every VM's state (Hyper-V), or the Proxmox web interface.",
    detect: (h) => has(h, "vmms", "pveproxy", "pvedaemon", "libvirtd"),
    checks: (h) => [
      ...services(h, "vmms", "pveproxy", "pvedaemon", "pve-cluster", "libvirtd"),
      ...(has(h, "vmms") ? [check(h, "Hyper-V VMs", "agent_hyperv", { vmName: "*" }, "Any VM that isn't running.")] : []),
      ...(h.address && has(h, "pveproxy") ? [check(h, "Proxmox web UI", "http", { url: `https://${h.address}:8006/`, method: "GET", insecureSkipVerify: true }, "The Proxmox interface answers.")] : []),
    ],
  },
  {
    id: "docker",
    label: "Docker host",
    kind: "role",
    description: "The Docker engine, every container's state and health, and crash-looping containers.",
    detect: (h) => has(h, "docker", "dockerd", "containerd") || h.containers.length > 0,
    checks: (h) => [
      ...services(h, "docker", "containerd"),
      check(h, "Docker containers", "agent_docker", { container: "*", measure: "status" }, "Any container stopped, restarting or unhealthy."),
      check(h, "container restarts", "agent_docker", { container: "*", measure: "restart_count", warnAbove: 0, criticalAbove: 3 }, "Crash-looping containers."),
    ],
  },
  {
    id: "backup",
    label: "Backup server",
    kind: "role",
    description: "Backup software running and its last job succeeding recently.",
    detect: (h) => has(h, "VeeamBackupSvc", "Veeam.Backup.Service", "borg", "borgbackup", "restic", "urbackupsrv", "bareos-dir", "bacula-dir"),
    checks: (h) => [
      ...services(h, "VeeamBackupSvc", "urbackupsrv", "bareos-dir", "bacula-dir"),
      ...(has(h, "VeeamBackupSvc", "Veeam.Backup.Service") ? [check(h, "Veeam jobs", "agent_backup", { tool: "veeam", maxAgeHours: 26 }, "Last Veeam job succeeded within a day.", 3600)] : []),
    ],
  },
  {
    id: "print",
    label: "Print server",
    kind: "role",
    description: "The print spooler and print-service errors.",
    detect: (h) => h.isWindows && h.isServer && h.services.has("spooler") && has(h, "PrintServer", "LPDSVC", "Spooler"),
    checks: (h) => [
      ...services(h, "Spooler", "LPDSVC"),
      check(h, "print service errors", "agent_eventlog", { logName: "Microsoft-Windows-PrintService/Admin", levels: "critical,error", severity: "warn" }, "Driver and queue errors."),
    ],
  },

  // ---- Security baselines ----
  {
    id: "security-windows",
    label: "Windows security baseline",
    kind: "security",
    description: "Antivirus, firewall and disk encryption on; updates installed; vulnerable software; new logins; audit-log clearing and new admin accounts.",
    detect: (h) => h.isWindows,
    checks: (h) => [
      check(h, "Defender real-time", "host_metric", { metric: "defender.realtime", severity: "down" }, "Real-time antivirus protection is on."),
      check(h, "Defender signatures", "host_metric", { metric: "defender.signature_age_days", warnAbove: 3, criticalAbove: 7 }, "Antivirus definitions are current.", 3600),
      check(h, "firewall", "host_metric", { metric: "firewall.enabled", severity: "down" }, "Windows Firewall is on for every profile.", 3600),
      check(h, "BitLocker", "host_metric", { metric: "encryption.enabled", severity: "warn" }, "The system drive is encrypted.", 3600),
      check(h, "security updates", "host_packages", { failOn: "security", severity: "warn" }, "Security updates waiting to be installed.", 3600),
      check(h, "vulnerable software", "host_vulnerable", {}, "Known vulnerabilities and unsupported software.", 21600),
      check(h, "failed logins", "host_metric", { metric: "logins.failed", warnAbove: 10, criticalAbove: 50 }, "Password-guessing against this machine."),
      check(h, "new logins", "host_change", { what: "sessions", holdMinutes: 15, severity: "warn" }, "Someone signed in — expected or not."),
      check(h, "audit log cleared", "agent_eventlog", { logName: "Security", eventIds: "1102", severity: "down" }, "Clearing the Security log is a classic attacker step."),
      check(h, "admin group changes", "agent_eventlog", { logName: "Security", eventIds: "4732,4728,4756", severity: "warn" }, "Someone was added to a security-enabled group (e.g. Administrators)."),
      check(h, "new user accounts", "agent_eventlog", { logName: "Security", eventIds: "4720", severity: "warn" }, "A user account was created."),
      check(h, "software changed", "host_software", { holdMinutes: 60, severity: "warn", sources: "windows" }, "Programs installed or removed."),
    ],
  },
  {
    id: "security-linux",
    label: "Linux security baseline",
    kind: "security",
    description: "Firewall on; security updates; vulnerable or end-of-life software; SSH brute force; new logins and listening ports; software changes; clock sync.",
    detect: (h) => h.isLinux && !h.isWindows,
    checks: (h) => [
      check(h, "firewall", "host_metric", { metric: "firewall.enabled", severity: "warn" }, "ufw / firewalld / nftables is active.", 3600),
      check(h, "security updates", "host_packages", { failOn: "security", severity: "warn" }, "Security updates waiting (Ubuntu phased updates left out).", 3600),
      check(h, "vulnerable software", "host_vulnerable", {}, "Known vulnerabilities and end-of-life software.", 21600),
      check(h, "failed SSH logins", "host_metric", { metric: "logins.failed", warnAbove: 20, criticalAbove: 100 }, "SSH password guessing."),
      check(h, "new logins", "host_change", { what: "sessions", holdMinutes: 15, severity: "warn" }, "Someone signed in — expected or not."),
      check(h, "new listening ports", "host_change", { what: "listening_ports", holdMinutes: 60, severity: "warn" }, "A new service started listening on the network."),
      check(h, "software changed", "host_software", { holdMinutes: 60, severity: "warn" }, "Packages installed, removed or upgraded."),
      check(h, "clock sync", "host_metric", { metric: "time.synced", severity: "warn" }, "Unsynchronised clocks break TLS and log correlation."),
      check(h, "reboot pending", "host_metric", { metric: "reboot.pending", severity: "warn" }, "Kernel or library updates waiting for a reboot.", 3600),
    ],
  },
  {
    id: "security-macos",
    label: "macOS security baseline",
    kind: "security",
    description: "FileVault and the firewall on, updates installed, vulnerable software, new logins and software changes.",
    detect: (h) => h.isMac,
    checks: (h) => [
      check(h, "FileVault", "host_metric", { metric: "encryption.enabled", severity: "warn" }, "The startup disk is encrypted.", 3600),
      check(h, "firewall", "host_metric", { metric: "firewall.enabled", severity: "warn" }, "The application firewall is on.", 3600),
      check(h, "updates", "host_packages", { failOn: "any", severity: "warn" }, "macOS updates waiting.", 3600),
      check(h, "vulnerable software", "host_vulnerable", {}, "Known vulnerabilities and unsupported software.", 21600),
      check(h, "new logins", "host_change", { what: "sessions", holdMinutes: 15, severity: "warn" }, "Someone signed in."),
      check(h, "software changed", "host_software", { holdMinutes: 60, severity: "warn" }, "Apps installed or removed."),
    ],
  },
];

/**
 * Every template for an endpoint: whether its role was detected, and the
 * checks it would add that the endpoint doesn't already have.
 *
 * @param facts the endpoint's facts (hostFacts)
 * @param existing its current checks (type + config), to skip duplicates
 */
export function templatesFor(facts: HostFacts, existing: { type: string; config: unknown }[]) {
  const have = new Set(existing.map((e) => suggestionKey({ type: e.type, config: (e.config ?? {}) as Record<string, unknown> })));
  return ROLE_TEMPLATES.map((t) => {
    const all = t.checks(facts).map((c) => ({ ...c, key: suggestionKey(c), group: t.label }));
    const missing = all.filter((c, i) => !have.has(c.key) && all.findIndex((x) => x.key === c.key) === i);
    return { id: t.id, label: t.label, kind: t.kind, description: t.description, detected: t.detect(facts), checks: missing, alreadyHave: all.length - missing.length };
  });
}
