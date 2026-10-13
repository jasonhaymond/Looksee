// "What should I look at?" hints for a failing check, shown on the check's
// page and in alert messages. Rules match the result message first (it says
// what actually went wrong), then the check type; the first few distinct
// hints win. These are starting points, not diagnoses.

type Input = { type: string; status: string | null; message: string | null; config?: unknown };
type Rule = { test: RegExp; hints: string[] };

const MESSAGE_RULES: Rule[] = [
  { test: /ECONNREFUSED|connection refused/i, hints: ["Nothing is listening on that port — is the service running? (systemctl status / Get-Service)", "Check the port number, and that the service binds to the right interface (not only 127.0.0.1)."] },
  { test: /ETIMEDOUT|timed? ?out|timeout/i, hints: ["A firewall may be silently dropping the traffic — check host and network firewall rules for this port.", "Confirm the target is reachable from where the check runs (engine, agent or site collector).", "If the target is just slow, raise the check's timeout."] },
  { test: /ENOTFOUND|EAI_AGAIN|getaddrinfo|NXDOMAIN|could not resolve/i, hints: ["The name doesn't resolve — check spelling and DNS (nslookup <name>) from where the check runs.", "For a LAN-only name, make sure the engine/collector uses your internal DNS server."] },
  { test: /EHOSTUNREACH|ENETUNREACH|no route|unreachable/i, hints: ["No network path to the target — check routing/VLANs, VPN tunnels and the device's gateway.", "Is the device on the subnet you expect? Its IP may have changed (see the host's IP history)."] },
  { test: /ECONNRESET|socket hang up/i, hints: ["The service accepted then dropped the connection — check its logs, TLS settings, or a proxy in between."] },
  { test: /certificate has expired|CERT_HAS_EXPIRED|expired/i, hints: ["Renew the certificate (certbot renew / your CA) and reload the web server.", "If renewal is automatic, check its timer/cron job and the ACME challenge path."] },
  { test: /self[- ]signed|unable to verify|UNABLE_TO_GET_ISSUER|hostname.*mismatch|altnames/i, hints: ["The certificate isn't trusted or doesn't match the name — install the full chain, or tick \"Skip TLS verification\" for internal-only services."] },
  { test: /\b401\b|\b403\b|unauthori[sz]ed|forbidden|authentication failed|access denied/i, hints: ["Credentials or permissions were rejected — re-enter the password/token on the check, and check the account isn't locked or expired."] },
  { test: /\b404\b|not found/i, hints: ["The URL/path/name doesn't exist (any more) — check for typos, a moved endpoint, or a renamed service/container/file."] },
  { test: /\b5\d\d\b|bad gateway|service unavailable|internal server error/i, hints: ["The server answered with an error — check the application's logs and its upstream (database, app server behind the proxy)."] },
  { test: /packet loss|100%|no reply|didn't answer|not respond/i, hints: ["Is the device powered on and its link up?", "Some devices and Windows hosts block ICMP by default — allow ping, or use a TCP check instead."] },
  { test: /isn't in the ARP table/i, hints: ["The device isn't on this LAN segment right now — powered off, asleep, or moved to another VLAN.", "ARP checks only see the same Layer-2 network as the engine/collector."] },
  { test: /Needs agent/i, hints: ["Update the agent from the Hosts page (Update agent), or reinstall it with the host's install command."] },
  { test: /script not found|script checks are disabled|plain file name/i, hints: ["Put the script directly in the agent's script_dir and set script_dir in looksee-agent.yaml (agent README → Custom scripts)."] },
  { test: /permission denied|EACCES|not permitted|requires? (root|admin)/i, hints: ["The agent's service account can't read this — grant access (group membership / ACL) or see the agent README's privileged-checks section."] },
  { test: /No response|request timed out/i, hints: ["SNMP: check the community/v3 credentials, that SNMP is enabled on the device, and that its ACL allows the engine/collector's IP."] },
  { test: /doesn't expose|not supported|unsupported/i, hints: ["The device or OS doesn't provide this data — pick a different template/metric, or check the device's SNMP views."] },
  { test: /flapping/i, hints: ["The check keeps changing state — look for an intermittent link, an overloaded target, or a threshold set right at the normal value."] },
  { test: /jam|paper|toner|door open|offline|service requested/i, hints: ["Check the printer's front panel for the exact error, clear it, then cancel and resend stuck jobs."] },
  { test: /changed from .* to |IP changed/i, hints: ["The device got a new IP — give it a DHCP reservation, or update checks that target the old address."] },
];

const TYPE_HINTS: Record<string, string[]> = {
  ping: ["Ping it yourself from the engine/collector: ping <host>.", "Check power, cabling/Wi-Fi, and the switch port."],
  tcp: ["Test the port from where the check runs: Test-NetConnection <host> -Port <port> (Windows) or nc -vz <host> <port>."],
  udp: ["UDP needs a reply to prove anything — confirm the service answers the configured payload."],
  http: ["Open the URL in a browser or curl -v <url> from the engine host.", "Check the web server and app logs around the failure time."],
  browser: ["Load the page in a normal browser and watch the developer console for JavaScript errors."],
  dns: ["Query the server directly: nslookup <name> <server> / dig @<server> <name>.", "Check the zone for the record and its TTL."],
  ssl_cert: ["Check the served certificate: openssl s_client -connect <host>:443 -servername <host>."],
  domain_expiry: ["Renew the domain with your registrar and confirm auto-renew and the payment method."],
  snmp: ["Walk the device yourself: snmpwalk -v2c -c <community> <host> <oid> — or use Walk in the check form."],
  snmp_interfaces: ["Look at the down ports on the device itself (link lights, cable, the device on the other end)."],
  database: ["Connect with the database's own client using the same credentials from the engine host.", "Check max connections and the database log."],
  agent_service: ["Look at why it stopped: journalctl -u <service> -n 50 (Linux) or the System event log (Windows), then start it."],
  agent_process: ["Start the program or its service; check whether it crashed (logs, Windows Application event log)."],
  agent_services_overview: ["List the stopped/failed services in the result details, then systemctl status <unit> / Get-Service <name>."],
  agent_heartbeat: ["The agent stopped reporting: is the host up? Is the looksee-agent service running (systemctl status looksee-agent / Get-ScheduledTask LookseeAgent)?", "Can the host still reach the Looksee URL (proxy, firewall, DNS)?"],
  host_metric: ["Open the host on the Hosts page to see which disk/interface/sensor tripped, and its processes tab for what's using resources."],
  host_reboot: ["Check why it rebooted: last -x reboot (Linux) or Event Viewer → System, events 41/1074/6008 (Windows)."],
  disk_forecast: ["Find what's growing (du -sh /* / WinDirStat) and clean up, rotate logs, or add space before it fills."],
  agent_file: ["Check the job that should produce this file (backup/export) and its logs."],
  agent_log: ["Open the log around the matched lines (shown in the result details)."],
  agent_docker: ["docker ps -a and docker logs <container> on the host; check its restart policy and health check."],
  agent_backup: ["Run the backup tool's list command by hand on the host, and check the job's schedule and last log."],
  agent_scheduled_task: ["Check the task's history (Task Scheduler → History) or systemctl status <timer>/journalctl -u <service>."],
  agent_script: ["Run the script by hand on the host as the agent's user to see its full output and exit code."],
  heartbeat: ["The job didn't check in — did it run (cron log / scheduler), and did it fail before calling the URL?"],
  push_value: ["The sender stopped pushing — check the script/cron job that calls the URL."],
  bmc: ["Log in to the BMC (iDRAC/iLO/IPMI) web UI and check its health/event log."],
  proxmox: ["Check the Proxmox web UI's Tasks and Syslog for the node/guest."],
  ups_battery: ["Check the UPS input power and battery age; schedule a battery test."],
  arp_presence: ["Is the device powered on and connected to this LAN?"],
  ip_change: ["Give the device a DHCP reservation, or update checks that target the old IP."],
};

export function remediationFor(input: Input): string[] {
  if (!input.status || input.status === "up") return [];
  const out: string[] = [];
  const add = (h: string[]) => {
    for (const x of h) if (!out.includes(x)) out.push(x);
  };
  const msg = input.message ?? "";
  for (const rule of MESSAGE_RULES) if (rule.test.test(msg)) add(rule.hints);
  const cfg = (input.config ?? {}) as Record<string, unknown>;
  if (input.type === "host_metric") {
    const metric = String(cfg.metric ?? "");
    if (metric.startsWith("disk")) add(["Free space: find large files (du -xh --max-depth=1 / | sort -h, or WinDirStat), clear old logs/backups, or grow the volume."]);
    if (metric.startsWith("cpu") || metric.startsWith("load")) add(["Find the busy process: top / htop (Linux) or Task Manager → Details (Windows) — or the host's Processes tab."]);
    if (metric.startsWith("mem") || metric.startsWith("swap")) add(["Find what's using memory (the host's Processes tab, sorted by memory); restart a leaking service or add RAM."]);
    if (metric.startsWith("smart") || metric.startsWith("raid")) add(["Back up now and plan to replace the failing drive; check smartctl -a <device> or the RAID controller's status."]);
    if (metric.startsWith("updates") || metric.startsWith("reboot")) add(["Install updates (apt upgrade / Windows Update) and reboot in a maintenance window."]);
    if (metric.startsWith("time")) add(["Check the time service: timedatectl / w32tm /query /status, and that NTP (UDP 123) is reachable."]);
  }
  if (input.type === "snmp" && String(cfg.preset ?? "").startsWith("printer")) add(["Check the printer's front panel or web page for the exact error."]);
  add(TYPE_HINTS[input.type] ?? []);
  if (!out.length) add(["Run the check again (Run now) and compare with its history to see when it started failing."]);
  return out.slice(0, 5);
}
