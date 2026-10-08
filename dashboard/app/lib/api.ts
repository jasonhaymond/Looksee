const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_URL}${path}`, {
    ...options,
    credentials: "include",
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new ApiError(res.status, body.error ?? `Request to ${path} failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

export type Status = "up" | "down" | "warn" | "unknown";

export type Endpoint = { id: string; name: string; description: string | null };
export type Host = {
  id: string;
  endpointId: string;
  name: string;
  hostname: string | null;
  os: string | null;
  lastSeenAt: string | null;
  // Snapshot from the agent's last report cycle, null until it's reported
  // at least once — feeds the check form's name suggestions.
  availableProcesses: string[] | null;
  availableServices: string[] | null;
  // Set from whatever the agent itself reports — reflects what's actually
  // running, not what was last pushed.
  agentVersion: string | null;
  macAddress: string | null;
  tags: string[];
  inventory: Record<string, unknown> | null;
  hasAgentKey: boolean;
  hasSnapshot: boolean;
  updateRequested: boolean;
};
export type HostSnapshot = {
  cpu?: { percent?: number; iowait?: number; steal?: number; perCore?: number[] };
  load?: { l1: number; l5: number; l15: number; cores: number };
  mem?: { total: number; available: number; percent: number; swapTotal: number; swapPercent: number };
  uptimeSeconds?: number;
  disks?: { mount: string; fstype?: string; total: number; free: number; percent: number; readOnly?: boolean; stale?: boolean; inodesPercent?: number }[];
  net?: { name: string; up: boolean; speedMbps?: number; rxBytesPerSec: number; txBytesPerSec: number; addrs?: string[]; mac?: string }[];
  temps?: { sensor: string; celsius: number }[];
  smart?: { device: string; model?: string; passed?: boolean; wearPercent?: number; tempC?: number }[];
  raid?: { name: string; kind: string; healthy: boolean; state?: string }[];
  updates?: { total: number; security: number } | null;
  pendingReboot?: boolean;
  firewall?: { enabled: boolean; detail?: string } | null;
  encryption?: { enabled: boolean; detail?: string } | null;
  defender?: { enabled: boolean; realtime: boolean; signatureAgeDays: number } | null;
  time?: { offsetMs?: number; synced?: boolean } | null;
  users?: { count: number; sessions: { user: string; terminal?: string; host?: string }[] };
  listening?: { port: number; proto: string; process?: string }[];
  availableContainers?: string[];
};
export type HostDetail = Host & { lastSnapshot: HostSnapshot | null };

export type Check = {
  id: string;
  endpointId: string;
  hostId: string | null;
  probeHostId: string | null;
  name: string;
  type: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  retryIntervalSeconds: number | null;
  enabled: boolean;
  tags: string[];
  lastStatus: Status | null;
  lastMessage: string | null;
  lastValue: number | null;
  lastLatencyMs: number | null;
  lastCheckedAt: string | null;
  lastStatusChangeAt: string | null;
  flapping: boolean;
  dependsOn: string[];
  inMaintenance: boolean;
  blockedBy: string | null;
  pushToken: string | null;
  pushUrl: string | null;
};
export type CheckInput = {
  name: string;
  endpointId: string;
  hostId: string | null;
  probeHostId: string | null;
  config: Record<string, unknown>;
  intervalSeconds: number;
  retryIntervalSeconds: number | null;
  enabled: boolean;
  tags: string[];
  dependsOn: string[];
};
export type CheckResult = {
  id: string;
  status: Status;
  latencyMs: number | null;
  message?: string | null;
  value?: number | null;
  details?: unknown;
  inMaintenance?: boolean;
  checkedAt: string;
};
export type BulkResult = { affected: number; errors: { id: string; error: string }[] };
export type Channel = { id: string; name: string; type: string; enabled: boolean };

export type MetricDef = { key: string; label: string; group: string; kind: "number" | "boolean"; unit?: string; instance?: string; instanceRequired?: boolean; agg?: string; expect?: boolean; platforms?: string; help?: string };
export type Suggestion = { key: string; name: string; type: string; config: Record<string, unknown>; reason: string; intervalSeconds?: number };

export type SmtpSettings = {
  id: number;
  host: string | null;
  port: number | null;
  user: string | null;
  from: string | null;
  passwordSet: boolean;
  updatedAt: string;
};
export type BackupSettings = {
  id: number;
  repoUrl: string | null;
  schedule: string | null;
  retentionCount: number | null;
  passphraseSet: boolean;
  updatedAt: string;
};
export type BackupRun = {
  id: string;
  kind: "backup" | "restore";
  archiveName: string;
  status: "running" | "success" | "error";
  message: string | null;
  startedAt: string;
  finishedAt: string | null;
};
export type Archive = { name: string; time: string };
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogEntry = {
  id: string;
  level: LogLevel;
  source: string;
  message: string;
  humanMessage: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: string;
};
export type CurrentOperation = { kind: "backup" | "restore"; startedAt: string } | null;
export type AlertRule = {
  id: string;
  checkId: string;
  consecutiveFailures: number;
  triggerOn: "down" | "warn";
  renotifyMinutes: number | null;
  escalateAfterMinutes: number | null;
  enabled: boolean;
  channelIds: string[];
  escalationChannelIds: string[];
};
export type AlertRuleInput = {
  consecutiveFailures?: number;
  triggerOn?: "down" | "warn";
  renotifyMinutes?: number | null;
  escalateAfterMinutes?: number | null;
  enabled?: boolean;
  channelIds?: string[];
  escalationChannelIds?: string[];
};

export type Dashboard = { id: string; name: string; refreshSeconds: number; createdAt: string };
export type WidgetType =
  | "status_tile"
  | "group_summary"
  | "host_metrics"
  | "uptime_history"
  | "note"
  | "alert_history"
  | "network_bandwidth"
  | "all_hosts"
  | "backup_status"
  | "clock"
  | "section_header"
  | "top_talkers"
  | "status_summary";
export type Widget = {
  id: string;
  dashboardId: string;
  type: WidgetType;
  config: { checkId?: string; endpointId?: string; hostId?: string; text?: string; rangeHours?: number; rangeMinutes?: number; groupBy?: string };
  x: number;
  y: number;
  w: number;
  h: number;
};
export type AlertEvent = {
  id: string;
  alertRuleId: string;
  checkId: string | null;
  checkName: string;
  status: "triggered" | "resolved";
  severity?: string;
  message?: string | null;
  triggeredAt: string;
  resolvedAt: string | null;
};
export type HostMetric = {
  id: string;
  hostId: string;
  cpuPercent: number | null;
  memPercent: number | null;
  diskPercent: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  recordedAt: string;
};

export type MaintenanceWindow = {
  id: string;
  name: string;
  scope: "all" | "endpoint" | "host" | "check";
  targetIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  daysOfWeek: number[] | null;
  startTime: string | null;
  durationMinutes: number | null;
  enabled: boolean;
  active: boolean;
};
export type StatusPage = { id: string; slug: string; title: string; description: string | null; checkIds: string[]; published: boolean };
export type PublicStatus = {
  title: string;
  description: string | null;
  overall: "operational" | "degraded" | "down";
  generatedAt: string;
  checks: { name: string; status: Status; lastCheckedAt: string | null; uptime90: number | null; days: { day: string; uptime: number | null }[] }[];
};
export type SlaRow = {
  checkId: string;
  name: string;
  type: string;
  endpointId: string;
  uptimePercent: number | null;
  downtimeMinutes: number;
  degradedMinutes: number;
  maintenanceMinutes: number;
  incidents: number;
  avgLatencyMs: number | null;
  results: number;
};
export type EventRow = { id: string; source: "snmp_trap" | "syslog"; sourceIp: string; severity: number | null; facility: number | null; message: string; data: Record<string, unknown> | null; receivedAt: string };
export type FlowRow = { label: string; bytes: number; packets: number; avgMbps: number };
export type SuggestedCheck = { type: string; name: string; config: Record<string, unknown> };
export type DiscoveredDevice = {
  ip: string;
  hostname: string | null;
  mac: string | null;
  pingable: boolean;
  openPorts: { port: number; service: string }[];
  snmp: { sysName?: string; sysDescr?: string } | null;
  knownHostId: string | null;
  suggestedChecks: SuggestedCheck[];
};
export type DiscoveryScan = { id: string; cidr: string; status: "running" | "done" | "error"; results: DiscoveredDevice[]; error: string | null; startedAt: string; finishedAt: string | null };

const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
const del = { method: "DELETE" };
const qs = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

export const api = {
  login: (email: string, password: string) => request<{ id: string; email: string }>("/api/auth/login", json({ email, password })),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ id: string; email: string }>("/api/auth/me"),
  health: () => request<{ status: string; db: string; version: string; agentVersion: string | null }>("/api/health"),

  endpoints: () => request<Endpoint[]>("/api/endpoints"),
  createEndpoint: (name: string, description?: string) => request<Endpoint>("/api/endpoints", json({ name, description })),
  updateEndpoint: (id: string, input: { name?: string; description?: string | null }) => request<Endpoint>(`/api/endpoints/${id}`, patch(input)),
  deleteEndpoint: (id: string) => request<void>(`/api/endpoints/${id}`, del),
  bulkEndpoints: (ids: string[], action: string, params: Record<string, unknown> = {}) => request<BulkResult>("/api/endpoints/bulk", json({ ids, action, ...params })),

  hosts: (endpointId?: string) => request<Host[]>(`/api/hosts${qs({ endpointId })}`),
  host: (id: string) => request<HostDetail>(`/api/hosts/${id}`),
  createHost: (input: { endpointId: string; name: string; hostname?: string; os?: string; macAddress?: string; tags?: string[] }) => request<Host>("/api/hosts", json(input)),
  updateHost: (id: string, input: { name?: string; hostname?: string | null; os?: string | null; macAddress?: string | null; endpointId?: string; tags?: string[] }) =>
    request<Host>(`/api/hosts/${id}`, patch(input)),
  deleteHost: (hostId: string) => request<void>(`/api/hosts/${hostId}`, del),
  issueAgentKey: (hostId: string) => request<{ agentApiKey: string; installCommands: { unix: string; windows: string } }>(`/api/hosts/${hostId}/agent-key`, { method: "POST" }),
  requestHostUpdate: (hostId: string) => request<{ requested: boolean }>(`/api/hosts/${hostId}/request-update`, { method: "POST" }),
  hostMetricCatalog: () => request<MetricDef[]>("/api/hosts/metric-catalog"),
  hostSuggestions: (id: string) => request<Suggestion[]>(`/api/hosts/${id}/suggestions`),
  applySuggestions: (id: string, keys: string[]) => request<{ created: number }>(`/api/hosts/${id}/suggestions/apply`, json({ keys })),
  wakeHost: (id: string) => request<{ sent: boolean }>(`/api/hosts/${id}/wake`, { method: "POST" }),
  bulkHosts: (ids: string[], action: string, params: Record<string, unknown> = {}) => request<BulkResult>("/api/hosts/bulk", json({ ids, action, ...params })),
  hostMetrics: (hostId: string, limit = 30, since?: string) => request<HostMetric[]>(`/api/hosts/${hostId}/metrics${qs({ limit, since })}`),

  checks: (endpointId?: string) => request<Check[]>(`/api/checks${qs({ endpointId })}`),
  createCheck: (input: Partial<CheckInput> & { endpointId: string; type: string; name: string }) => request<Check>("/api/checks", json(input)),
  updateCheck: (id: string, input: Partial<CheckInput>) => request<Check>(`/api/checks/${id}`, patch(input)),
  deleteCheck: (id: string) => request<void>(`/api/checks/${id}`, del),
  runCheck: (id: string) => request<CheckResult>(`/api/checks/${id}/run`, { method: "POST" }),
  regeneratePushToken: (id: string) => request<Check>(`/api/checks/${id}/regenerate-token`, { method: "POST" }),
  bulkChecks: (ids: string[], action: string, params: Record<string, unknown> = {}) => request<BulkResult>("/api/checks/bulk", json({ ids, action, ...params })),
  checkResults: (checkId: string, limit = 50, since?: string) => request<CheckResult[]>(`/api/checks/${checkId}/results${qs({ limit, since })}`),

  channels: () => request<Channel[]>("/api/channels"),
  createChannel: (input: { name: string; type: string; config: Record<string, unknown> }) => request<Channel>("/api/channels", json(input)),
  updateChannel: (id: string, input: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) => request<Channel>(`/api/channels/${id}`, patch(input)),
  deleteChannel: (id: string) => request<void>(`/api/channels/${id}`, del),

  smtpSettings: () => request<{ settings: SmtpSettings }>("/api/smtp/settings"),
  updateSmtpSettings: (input: { host?: string | null; port?: number | null; user?: string | null; password?: string; from?: string | null }) =>
    request<{ settings: SmtpSettings }>("/api/smtp/settings", patch(input)),
  sendTestEmail: (to: string) => request<{ sent: boolean }>("/api/smtp/test", json({ to })),

  alertRules: (checkId: string) => request<AlertRule[]>(`/api/alert-rules${qs({ checkId })}`),
  createAlertRule: (input: AlertRuleInput & { checkId: string }) => request<AlertRule>("/api/alert-rules", json(input)),
  updateAlertRule: (id: string, input: AlertRuleInput) => request<AlertRule>(`/api/alert-rules/${id}`, patch(input)),
  deleteAlertRule: (id: string) => request<void>(`/api/alert-rules/${id}`, del),
  alertEvents: (params?: { endpointId?: string; since?: string; limit?: number }) => request<AlertEvent[]>(`/api/alert-rules/events${qs(params ?? {})}`),

  vapidPublicKey: () => request<{ publicKey: string }>("/api/push/vapid-public-key"),
  subscribePush: (subscription: PushSubscriptionJSON) => request<{ ok: true }>("/api/push/subscribe", json(subscription)),

  backupSettings: () => request<{ settings: BackupSettings; borgAvailable: boolean; borgVersion: string | null }>("/api/backups/settings"),
  updateBackupSettings: (input: { repoUrl?: string; passphrase?: string; schedule?: string | null; retentionCount?: number | null }) =>
    request<{ settings: BackupSettings }>("/api/backups/settings", patch(input)),
  backupSshPublicKey: () => request<{ publicKey: string }>("/api/backups/ssh-public-key"),
  backupStatus: () => request<{ borgAvailable: boolean; borgVersion: string | null; currentOperation: CurrentOperation }>("/api/backups/status"),
  backupRuns: () => request<{ runs: BackupRun[] }>("/api/backups/runs"),
  backupArchives: () => request<{ archives: Archive[] }>("/api/backups/archives"),
  runBackup: () => request<{ started: true }>("/api/backups/run", { method: "POST" }),
  restoreBackup: (input: { archiveName: string; confirmArchiveName: string; restoreDb: boolean; restoreConfig: boolean }) => request<{ started: true }>("/api/backups/restore", json(input)),
  logs: (params?: { level?: LogLevel; limit?: number }) => request<LogEntry[]>(`/api/logs${qs(params ?? {})}`),

  dashboards: () => request<Dashboard[]>("/api/dashboards"),
  createDashboard: (name: string) => request<Dashboard>("/api/dashboards", json({ name })),
  renameDashboard: (id: string, name: string) => request<Dashboard>(`/api/dashboards/${id}`, patch({ name })),
  updateDashboardRefresh: (id: string, refreshSeconds: number) => request<Dashboard>(`/api/dashboards/${id}`, patch({ refreshSeconds })),
  deleteDashboard: (id: string) => request<void>(`/api/dashboards/${id}`, del),
  widgets: (dashboardId: string) => request<Widget[]>(`/api/dashboards/${dashboardId}/widgets`),
  createWidget: (dashboardId: string, input: { type: WidgetType; config: Widget["config"]; x: number; y: number; w: number; h: number }) => request<Widget>(`/api/dashboards/${dashboardId}/widgets`, json(input)),
  updateWidget: (widgetId: string, input: Partial<Pick<Widget, "x" | "y" | "w" | "h" | "config">>) => request<Widget>(`/api/dashboards/widgets/${widgetId}`, patch(input)),
  deleteWidget: (widgetId: string) => request<void>(`/api/dashboards/widgets/${widgetId}`, del),

  maintenance: () => request<MaintenanceWindow[]>("/api/maintenance"),
  createMaintenance: (input: Partial<MaintenanceWindow>) => request<MaintenanceWindow>("/api/maintenance", json(input)),
  updateMaintenance: (id: string, input: Partial<MaintenanceWindow>) => request<MaintenanceWindow>(`/api/maintenance/${id}`, patch(input)),
  endMaintenance: (id: string) => request<MaintenanceWindow>(`/api/maintenance/${id}/end`, { method: "POST" }),
  deleteMaintenance: (id: string) => request<void>(`/api/maintenance/${id}`, del),

  statusPages: () => request<StatusPage[]>("/api/status-pages"),
  createStatusPage: (input: Partial<StatusPage>) => request<StatusPage>("/api/status-pages", json(input)),
  updateStatusPage: (id: string, input: Partial<StatusPage>) => request<StatusPage>(`/api/status-pages/${id}`, patch(input)),
  deleteStatusPage: (id: string) => request<void>(`/api/status-pages/${id}`, del),
  publicStatus: (slug: string) => request<PublicStatus>(`/api/public/status/${encodeURIComponent(slug)}`),

  slaReport: (days: number, endpointId?: string) => request<{ days: number; checks: SlaRow[] }>(`/api/insights/reports/sla${qs({ days, endpointId })}`),
  // Fetched as a blob (not a plain link) so the session cookie travels with
  // it in the dev setup, where the API is on a different origin.
  slaCsv: async (days: number, endpointId?: string) => {
    const res = await fetch(`${API_URL}/api/insights/reports/sla${qs({ days, endpointId, format: "csv" })}`, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, "CSV export failed");
    return res.blob();
  },
  events: (params: { source?: string; sourceIp?: string; q?: string; maxSeverity?: string; limit?: number }) => request<EventRow[]>(`/api/insights/events${qs(params)}`),
  topFlows: (params: { minutes: number; by: string; exporter?: string; limit?: number }) => request<FlowRow[]>(`/api/insights/flows/top${qs(params)}`),
  flowExporters: () => request<{ exporter: string; last: string }[]>("/api/insights/flows/exporters"),
  discoveryScans: () => request<DiscoveryScan[]>("/api/insights/discovery/scans"),
  discoveryScan: (id: string) => request<DiscoveryScan>(`/api/insights/discovery/scans/${id}`),
  startDiscovery: (cidr: string, community?: string) => request<DiscoveryScan>("/api/insights/discovery/scans", json({ cidr, community })),
  addDiscovered: (scanId: string, input: { endpointId: string; devices: { ip: string; name?: string; mac?: string | null; createHost: boolean; checks: SuggestedCheck[] }[] }) =>
    request<{ hostsCreated: number; checksCreated: number }>(`/api/insights/discovery/scans/${scanId}/add`, json(input)),
};
