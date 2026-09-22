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

export type Site = { id: string; name: string; description: string | null };
export type Host = {
  id: string;
  siteId: string;
  name: string;
  hostname: string | null;
  os: string | null;
  lastSeenAt: string | null;
  // Snapshot from the agent's last report cycle, null until it's reported
  // at least once — feeds the check form's name suggestions.
  availableProcesses: string[] | null;
  availableServices: string[] | null;
};
export type Check = {
  id: string;
  siteId: string;
  hostId: string | null;
  name: string;
  type: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  enabled: boolean;
};
export type CheckResult = { id: string; status: "up" | "down" | "warn" | "unknown"; latencyMs: number | null; checkedAt: string };
export type Channel = { id: string; name: string; type: string; enabled: boolean };

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
  enabled: boolean;
  channelIds: string[];
};

export type Dashboard = { id: string; name: string; createdAt: string };
export type WidgetType = "status_tile" | "group_summary";
export type Widget = {
  id: string;
  dashboardId: string;
  type: WidgetType;
  config: { checkId?: string; siteId?: string };
  x: number;
  y: number;
  w: number;
  h: number;
};

export const api = {
  login: (email: string, password: string) => request<{ id: string; email: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ id: string; email: string }>("/api/auth/me"),

  sites: () => request<Site[]>("/api/sites"),
  createSite: (name: string) => request<Site>("/api/sites", { method: "POST", body: JSON.stringify({ name }) }),
  updateSite: (id: string, input: { name?: string; description?: string | null }) =>
    request<Site>(`/api/sites/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteSite: (id: string) => request<void>(`/api/sites/${id}`, { method: "DELETE" }),

  hosts: (siteId?: string) => request<Host[]>(`/api/hosts${siteId ? `?siteId=${siteId}` : ""}`),
  createHost: (input: { siteId: string; name: string; hostname?: string; os?: string }) =>
    request<Host>("/api/hosts", { method: "POST", body: JSON.stringify(input) }),
  updateHost: (id: string, input: { name?: string; hostname?: string | null; os?: string | null }) =>
    request<Host>(`/api/hosts/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteHost: (hostId: string) => request<void>(`/api/hosts/${hostId}`, { method: "DELETE" }),
  issueAgentKey: (hostId: string) => request<{ agentApiKey: string; installCommand: string }>(`/api/hosts/${hostId}/agent-key`, { method: "POST" }),

  checks: (siteId?: string) => request<Check[]>(`/api/checks${siteId ? `?siteId=${siteId}` : ""}`),
  createCheck: (input: { siteId: string; hostId?: string | null; name: string; type: string; config: Record<string, unknown>; intervalSeconds?: number }) =>
    request<Check>("/api/checks", { method: "POST", body: JSON.stringify(input) }),
  updateCheck: (id: string, input: { name?: string; hostId?: string | null; config?: Record<string, unknown>; intervalSeconds?: number; enabled?: boolean }) =>
    request<Check>(`/api/checks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteCheck: (id: string) => request<void>(`/api/checks/${id}`, { method: "DELETE" }),
  checkResults: (checkId: string, limit = 50) => request<CheckResult[]>(`/api/checks/${checkId}/results?limit=${limit}`),

  channels: () => request<Channel[]>("/api/channels"),
  createChannel: (input: { name: string; type: string; config: Record<string, unknown> }) =>
    request<Channel>("/api/channels", { method: "POST", body: JSON.stringify(input) }),
  updateChannel: (id: string, input: { name?: string; config?: Record<string, unknown>; enabled?: boolean }) =>
    request<Channel>(`/api/channels/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteChannel: (id: string) => request<void>(`/api/channels/${id}`, { method: "DELETE" }),

  alertRules: (checkId: string) => request<AlertRule[]>(`/api/alert-rules?checkId=${checkId}`),
  createAlertRule: (input: { checkId: string; consecutiveFailures: number; channelIds: string[] }) =>
    request<AlertRule>("/api/alert-rules", { method: "POST", body: JSON.stringify(input) }),
  updateAlertRule: (id: string, input: { consecutiveFailures?: number; enabled?: boolean; channelIds?: string[] }) =>
    request<AlertRule>(`/api/alert-rules/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteAlertRule: (id: string) => request<void>(`/api/alert-rules/${id}`, { method: "DELETE" }),

  vapidPublicKey: () => request<{ publicKey: string }>("/api/push/vapid-public-key"),
  subscribePush: (subscription: PushSubscriptionJSON) => request<{ ok: true }>("/api/push/subscribe", { method: "POST", body: JSON.stringify(subscription) }),

  backupSettings: () => request<{ settings: BackupSettings; borgAvailable: boolean; borgVersion: string | null }>("/api/backups/settings"),
  updateBackupSettings: (input: { repoUrl?: string; passphrase?: string; schedule?: string | null; retentionCount?: number | null }) =>
    request<{ settings: BackupSettings }>("/api/backups/settings", { method: "PATCH", body: JSON.stringify(input) }),
  backupSshPublicKey: () => request<{ publicKey: string }>("/api/backups/ssh-public-key"),
  backupStatus: () => request<{ borgAvailable: boolean; borgVersion: string | null; currentOperation: CurrentOperation }>("/api/backups/status"),
  backupRuns: () => request<{ runs: BackupRun[] }>("/api/backups/runs"),
  logs: (params?: { level?: LogLevel; limit?: number }) => {
    const query = new URLSearchParams();
    if (params?.level) query.set("level", params.level);
    if (params?.limit) query.set("limit", String(params.limit));
    const qs = query.toString();
    return request<LogEntry[]>(`/api/logs${qs ? `?${qs}` : ""}`);
  },
  backupArchives: () => request<{ archives: Archive[] }>("/api/backups/archives"),
  runBackup: () => request<{ started: true }>("/api/backups/run", { method: "POST" }),
  restoreBackup: (input: { archiveName: string; confirmArchiveName: string; restoreDb: boolean; restoreConfig: boolean }) =>
    request<{ started: true }>("/api/backups/restore", { method: "POST", body: JSON.stringify(input) }),

  dashboards: () => request<Dashboard[]>("/api/dashboards"),
  createDashboard: (name: string) => request<Dashboard>("/api/dashboards", { method: "POST", body: JSON.stringify({ name }) }),
  renameDashboard: (id: string, name: string) => request<Dashboard>(`/api/dashboards/${id}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  deleteDashboard: (id: string) => request<void>(`/api/dashboards/${id}`, { method: "DELETE" }),
  widgets: (dashboardId: string) => request<Widget[]>(`/api/dashboards/${dashboardId}/widgets`),
  createWidget: (dashboardId: string, input: { type: WidgetType; config: Widget["config"]; x: number; y: number; w: number; h: number }) =>
    request<Widget>(`/api/dashboards/${dashboardId}/widgets`, { method: "POST", body: JSON.stringify(input) }),
  updateWidget: (widgetId: string, input: Partial<Pick<Widget, "x" | "y" | "w" | "h" | "config">>) =>
    request<Widget>(`/api/dashboards/widgets/${widgetId}`, { method: "PATCH", body: JSON.stringify(input) }),
  deleteWidget: (widgetId: string) => request<void>(`/api/dashboards/widgets/${widgetId}`, { method: "DELETE" }),
};
