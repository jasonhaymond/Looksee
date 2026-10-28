// Single registry of every check type and who executes it. The dashboard
// mirrors this list in dashboard/app/lib/checkTypes.ts (labels, help text,
// form fields); test/check-types.test.ts asserts the two agree.
//
// executor:
//   engine — the scheduler runs it on its interval (services/probes)
//   agent  — sent to the host's agent via GET /api/agent/config; the agent
//            measures and reports back, the engine applies thresholds
//   report — evaluated by the engine against the metrics snapshot every
//            agent report already carries (no separate agent work)
// endpointRequired: the check is meaningless without a endpointId.
// remoteProbe: an engine-executed type the Go agent can also run, so it can
//   be pinned to a host's agent instead (checks.probeEndpointId) — for targets
//   only reachable from inside another network.
// otherAgent: an agent-executed type that may be run by a different
//   endpoint's agent (checks.probeEndpointId) while still belonging to its
//   own endpoint — a custom script that checks a device which can't run the
//   agent itself, run from a nearby machine that can.
// minAgentVersion: agents older than this never receive the check; the
//   engine records a warn result explaining why instead of sending it.

import { own } from "../lib/own.js";
export type CheckExecutor = "engine" | "agent" | "report";
// local: an engine-run type that reads the engine's own database (event
// matching, anomaly baselines, heartbeat staleness, forecasts) — always run by
// the engine, never handed to a site collector.
export type CheckTypeMeta = { executor: CheckExecutor; endpointRequired?: boolean; remoteProbe?: boolean; otherAgent?: boolean; minAgentVersion?: string; local?: boolean };

export const CHECK_TYPE_META = {
  ping: { executor: "engine", remoteProbe: true },
  tcp: { executor: "engine", remoteProbe: true },
  http: { executor: "engine", remoteProbe: true },
  dns: { executor: "engine", remoteProbe: true },
  ssl_cert: { executor: "engine", remoteProbe: true },
  snmp: { executor: "engine" },
  udp: { executor: "engine" },
  protocol: { executor: "engine" },
  email_roundtrip: { executor: "engine" },
  database: { executor: "engine" },
  traceroute: { executor: "engine" },
  browser: { executor: "engine" },
  ntp: { executor: "engine" },
  dhcp: { executor: "engine" },
  grpc: { executor: "engine" },
  mqtt: { executor: "engine" },
  websocket: { executor: "engine" },
  docker_registry: { executor: "engine" },
  arp_presence: { executor: "engine" },
  domain_expiry: { executor: "engine" },
  public_ip: { executor: "engine" },
  snmp_interfaces: { executor: "engine" },
  // A whole DNS zone, copied by zone transfer (AXFR) or read name by name,
  // compared with its previous copy to keep a history of record changes
  // (services/probes/dnsZone.ts). Runs on the engine or the site collector.
  dns_zone: { executor: "engine" },
  trap_match: { executor: "engine", local: true },
  syslog_match: { executor: "engine", local: true },
  bmc: { executor: "engine" },
  proxmox: { executor: "engine" },
  vmware: { executor: "engine" },
  prometheus: { executor: "engine" },
  webserver_status: { executor: "engine" },
  app_integration: { executor: "engine" },
  anomaly: { executor: "engine", local: true },
  heartbeat: { executor: "engine", local: true },
  push_value: { executor: "engine", local: true },
  agent_heartbeat: { executor: "engine", endpointRequired: true, local: true },
  disk_forecast: { executor: "engine", endpointRequired: true, local: true },
  ip_change: { executor: "engine", local: true },
  // A value worked out from other checks' latest values (services/expression.ts).
  calculated: { executor: "engine", local: true },
  // Vulnerable or unsupported software, looked up online from the
  // endpoint's software report (services/software.ts).
  host_vulnerable: { executor: "engine", endpointRequired: true, local: true },

  agent_service: { executor: "agent", endpointRequired: true },
  agent_process: { executor: "agent", endpointRequired: true },
  agent_file: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_log: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_eventlog: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_journal: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_script: { executor: "agent", endpointRequired: true, otherAgent: true, minAgentVersion: "3.0.0" },
  agent_scheduled_task: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_services_overview: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_docker: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_hyperv: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_perfcounter: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_vpn: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_ups: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  agent_backup: { executor: "agent", endpointRequired: true, minAgentVersion: "3.0.0" },
  // Local user accounts: the agent lists them, the engine compares the list
  // with the previous one and flags new, changed and removed accounts
  // (services/userAccounts.ts).
  agent_users: { executor: "agent", endpointRequired: true, minAgentVersion: "5.2.0" },
  // The largest folders and files on each disk (or under one folder), found
  // by walking the whole tree on the endpoint (agent/internal/checks/tree.go).
  agent_disk_tree: { executor: "agent", endpointRequired: true, minAgentVersion: "5.2.0" },

  host_cpu: { executor: "report", endpointRequired: true },
  host_memory: { executor: "report", endpointRequired: true },
  host_disk: { executor: "report", endpointRequired: true },
  host_metric: { executor: "report", endpointRequired: true, minAgentVersion: "3.0.0" },
  host_reboot: { executor: "report", endpointRequired: true, minAgentVersion: "3.0.0" },
  host_change: { executor: "report", endpointRequired: true, minAgentVersion: "3.0.0" },
  // From the 5.0 agent's software report (services/software.ts).
  host_packages: { executor: "report", endpointRequired: true, minAgentVersion: "5.0.0" },
  host_software: { executor: "report", endpointRequired: true, minAgentVersion: "5.0.0" },
} as const satisfies Record<string, CheckTypeMeta>;

export type CheckType = keyof typeof CHECK_TYPE_META;
export const CHECK_TYPES = Object.keys(CHECK_TYPE_META) as [CheckType, ...CheckType[]];

const meta = (t: string): CheckTypeMeta | undefined => own(CHECK_TYPE_META as Record<string, CheckTypeMeta>, t);
export const isCheckType = (t: unknown): t is CheckType => typeof t === "string" && meta(t) !== undefined;
export const typesWhere = (pred: (m: CheckTypeMeta) => boolean) => CHECK_TYPES.filter((t) => pred(meta(t)!));

export const ENGINE_CHECK_TYPES = typesWhere((m) => m.executor === "engine");
export const AGENT_CHECK_TYPES = typesWhere((m) => m.executor === "agent");
export const REPORT_CHECK_TYPES = typesWhere((m) => m.executor === "report");
export const ENDPOINT_SCOPED_CHECK_TYPES = typesWhere((m) => Boolean(m.endpointRequired));
export const REMOTE_PROBE_CHECK_TYPES = typesWhere((m) => Boolean(m.remoteProbe));
// Agent types another endpoint's agent may run (see otherAgent above).
export const OTHER_AGENT_CHECK_TYPES = typesWhere((m) => Boolean(m.otherAgent));
// Every type whose checks.probeEndpointId names the agent that runs it:
// remote probes (engine types moved to an agent) and otherAgent types.
export const PINNABLE_CHECK_TYPES = typesWhere((m) => Boolean(m.remoteProbe) || Boolean(m.otherAgent));
// Engine-run types a site collector runs for its endpoint.
export const COLLECTOR_CHECK_TYPES = typesWhere((m) => m.executor === "engine" && !m.local);
export const minAgentVersionFor = (t: string) => meta(t)?.minAgentVersion;

// Numeric dotted-version compare; "dev" builds count as newest so a locally
// built agent gets every check type.
export function versionAtLeast(actual: string | null | undefined, required: string): boolean {
  if (!actual) return false;
  if (actual === "dev") return true;
  const a = actual.split(".").map((n) => parseInt(n, 10) || 0);
  const r = required.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, r.length); i++) {
    if ((a.at(i) ?? 0) !== (r.at(i) ?? 0)) return (a.at(i) ?? 0) > (r.at(i) ?? 0);
  }
  return true;
}
