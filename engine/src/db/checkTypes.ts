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
// hostRequired: the check is meaningless without a hostId.
// remoteProbe: an engine-executed type the Go agent can also run, so it can
//   be pinned to a host's agent instead (checks.probeHostId) — for targets
//   only reachable from inside another network.
// minAgentVersion: agents older than this never receive the check; the
//   engine records a warn result explaining why instead of sending it.
export type CheckExecutor = "engine" | "agent" | "report";
// local: an engine-run type that reads the engine's own database (event
// matching, anomaly baselines, heartbeat staleness, forecasts) — always run by
// the engine, never handed to a site collector.
export type CheckTypeMeta = { executor: CheckExecutor; hostRequired?: boolean; remoteProbe?: boolean; minAgentVersion?: string; local?: boolean };

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
  agent_heartbeat: { executor: "engine", hostRequired: true, local: true },
  disk_forecast: { executor: "engine", hostRequired: true, local: true },

  agent_service: { executor: "agent", hostRequired: true },
  agent_process: { executor: "agent", hostRequired: true },
  agent_file: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_log: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_eventlog: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_journal: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_script: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_scheduled_task: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_services_overview: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_docker: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_hyperv: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_perfcounter: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_vpn: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_ups: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },
  agent_backup: { executor: "agent", hostRequired: true, minAgentVersion: "3.0.0" },

  host_cpu: { executor: "report", hostRequired: true },
  host_memory: { executor: "report", hostRequired: true },
  host_disk: { executor: "report", hostRequired: true },
  host_metric: { executor: "report", hostRequired: true, minAgentVersion: "3.0.0" },
  host_reboot: { executor: "report", hostRequired: true, minAgentVersion: "3.0.0" },
  host_change: { executor: "report", hostRequired: true, minAgentVersion: "3.0.0" },
} as const satisfies Record<string, CheckTypeMeta>;

export type CheckType = keyof typeof CHECK_TYPE_META;
export const CHECK_TYPES = Object.keys(CHECK_TYPE_META) as [CheckType, ...CheckType[]];

const meta = (t: string): CheckTypeMeta | undefined => (CHECK_TYPE_META as Record<string, CheckTypeMeta>)[t];
export const isCheckType = (t: unknown): t is CheckType => typeof t === "string" && meta(t) !== undefined;
export const typesWhere = (pred: (m: CheckTypeMeta) => boolean) => CHECK_TYPES.filter((t) => pred(CHECK_TYPE_META[t]));

export const ENGINE_CHECK_TYPES = typesWhere((m) => m.executor === "engine");
export const AGENT_CHECK_TYPES = typesWhere((m) => m.executor === "agent");
export const REPORT_CHECK_TYPES = typesWhere((m) => m.executor === "report");
export const HOST_SCOPED_CHECK_TYPES = typesWhere((m) => Boolean(m.hostRequired));
export const REMOTE_PROBE_CHECK_TYPES = typesWhere((m) => Boolean(m.remoteProbe));
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
    if ((a[i] ?? 0) !== (r[i] ?? 0)) return (a[i] ?? 0) > (r[i] ?? 0);
  }
  return true;
}
