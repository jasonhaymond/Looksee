// The dashboard's only way of talking to the Looksee engine: one typed
// function per engine API route, plus the TypeScript types describing what
// each route sends back.
//
// Where this sits: every page and component imports `api` from here (e.g.
// `api.checks()` → GET /api/checks) instead of calling fetch() itself, so the
// engine's address, cookies, error handling and response clean-up live in one
// place. The routes themselves are in engine/src/routes/.
//
// Security: requests carry the session cookie (`credentials: "include"`); the
// engine decides what each request may do — nothing here is a security
// boundary. Secrets the engine never returns (channel tokens, passwords)
// simply don't appear in these types.
//
// Time zones: every response passes through localizeResponse (lib/localTime.ts),
// which rewrites UTC timestamps embedded in message text into the viewer's
// own time zone. Plain timestamp fields (createdAt, lastCheckedAt, ...) stay
// ISO strings; pages format those with `new Date(x).toLocaleString()`, which
// is already local.

import type { AuthenticationResponseJSON, PublicKeyCredentialCreationOptionsJSON, PublicKeyCredentialRequestOptionsJSON, RegistrationResponseJSON } from "@simplewebauthn/browser";
import { browserTimeZone, localizeResponse } from "./localTime";

// The engine's base URL. NEXT_PUBLIC_ variables are baked into the dashboard
// when it's built (`next build`), not read at runtime, so changing it needs a
// rebuild. In production it's the same origin as the dashboard (Caddy routes
// /api/* to the engine).
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4100";

/** An error response from the engine: its HTTP status and its error message. */
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

/**
 * Calls one engine route and returns its parsed JSON body.
 *
 * @param path the route, e.g. "/api/checks?siteId=..."
 * @param options fetch options (method, body, extra headers)
 * @returns the response body (with embedded times localized), or undefined
 *          for a 204 No Content
 * @throws ApiError with the engine's own error message on any non-2xx status
 */
async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  // `await` waits for the network request to finish before continuing.
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
  return localizeResponse((await res.json()) as T);
}

// ---- Response and request shapes -------------------------------------------
// TypeScript `type`s describe the JSON the engine sends; they have no effect
// at runtime. Timestamps are ISO-8601 strings in UTC (e.g.
// "2026-10-13T14:05:00.000Z"); `| null` means the field can be empty.

// A check's latest result.
export type Status = "up" | "down" | "warn" | "unknown";

export type Site = {
  id: string;
  name: string;
  description: string | null;
  // The agent host that runs this site's network checks/receivers/discovery
  // (a remote site); null = the Looksee server does it.
  collectorEndpointId: string | null;
  // For devices pushing syslog/traps/flows straight to the server.
  publicIps: string[];
  locationId: string | null;
};
export type SiteInput = { name?: string; description?: string | null; collectorEndpointId?: string | null; publicIps?: string[]; locationId?: string | null };
export type Location = { id: string; name: string; description: string | null; address: string | null; createdAt: string };
export type Endpoint = {
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
  // Set from whatever the agent itself reports — reflects what's actually
  // running, not what was last pushed.
  agentVersion: string | null;
  macAddress: string | null;
  tags: string[];
  inventory: Record<string, unknown> | null;
  hasAgentKey: boolean;
  hasSnapshot: boolean;
  updateRequested: boolean;
  // Reported by the site collector this host's agent runs, when it is one.
  collectorVersion: string | null;
  collectorLastSeenAt: string | null;
  collectorError: string | null;
  processCount?: number | null;
  serviceCount?: number | null;
  inventoryUpdatedAt?: string | null;
  availableScripts?: string[] | null;
};
export type ProcessInfo = { pid: number; name: string; user?: string; cpuPercent?: number; memoryMb?: number; command?: string; started?: number };
export type ServiceInfo = { name: string; displayName?: string; state: string; startType?: string };
export type EndpointInventory = { processes: ProcessInfo[] | null; services: ServiceInfo[] | null; scripts: string[] | null; containers: string[] | null; updatedAt: string | null; processNames: string[] | null; serviceNames: string[] | null };
export type AddressRow = { id: string; mac: string; ip: string; source: string; firstSeenAt: string; lastSeenAt: string };
export type EndpointSnapshot = {
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
export type EndpointDetail = Endpoint & { lastSnapshot: EndpointSnapshot | null };

export type Check = {
  id: string;
  siteId: string;
  endpointId: string | null;
  probeEndpointId: string | null;
  // Set when the site's site collector runs this check.
  collectorEndpointId?: string | null;
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
  locationId?: string | null;
  // Things to look at while it's failing (engine/src/services/remediation.ts).
  remediation?: string[];
};
export type CheckStats = {
  hours: number;
  bucketSeconds: number;
  results: number;
  up: number;
  warn: number;
  down: number;
  uptimePercent: number | null;
  latencyAvg: number | null;
  latencyMin: number | null;
  latencyMax: number | null;
  latencyP95: number | null;
  valueAvg: number | null;
  valueMin: number | null;
  valueMax: number | null;
  stateChanges: number;
  series: { t: string; latency: number | null; value: number | null; valueMin: number | null; valueMax: number | null; status: string; n: number }[];
  incidents: { id: string; status: string; severity: string; message: string | null; triggeredAt: string; resolvedAt: string | null }[];
};
export type AlertRulePayload = { channelIds: string[]; escalationChannelIds: string[]; consecutiveFailures: number; triggerOn: "down" | "warn"; renotifyMinutes: number | null; escalateAfterMinutes: number | null };
export type WalkRow = { oid: string; type: string; value: string };
export type CheckInput = {
  name: string;
  siteId: string;
  endpointId: string | null;
  probeEndpointId: string | null;
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
  // Excluded from statistics by the admin afterwards, and why.
  excluded?: boolean;
  excludedReason?: string | null;
  checkedAt: string;
};
export type BulkResult = { affected: number; errors: { id: string; error: string }[] };
export type ChannelTemplate = { title?: string; body?: string };
export type Channel = { id: string; name: string; type: string; enabled: boolean; templates?: Record<string, ChannelTemplate> };
export type TemplateInfo = { events: string[]; defaults: Record<string, Required<ChannelTemplate>>; variables: { name: string; help: string }[] };

export type MetricDef = { key: string; label: string; group: string; kind: "number" | "boolean"; unit?: string; instance?: string; instanceRequired?: boolean; agg?: string; expect?: boolean; platforms?: string; help?: string };
export type Suggestion = { key: string; name: string; type: string; config: Record<string, unknown>; reason: string; intervalSeconds?: number; group?: string };

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
  | "endpoint_metrics"
  | "uptime_history"
  | "note"
  | "alert_history"
  | "network_bandwidth"
  | "all_endpoints"
  | "backup_status"
  | "clock"
  | "section_header"
  | "top_talkers"
  | "status_summary";
export type Widget = {
  id: string;
  dashboardId: string;
  type: WidgetType;
  config: { checkId?: string; siteId?: string; endpointId?: string; text?: string; rangeHours?: number; rangeMinutes?: number; groupBy?: string };
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
  siteId?: string | null;
  endpointId?: string | null;
  checkType?: string | null;
  durationMinutes?: number;
};
export type AlertEventQuery = { siteId?: string; locationId?: string; checkId?: string; endpointId?: string; status?: "open" | "resolved"; since?: string; until?: string; q?: string; limit?: number };
export type EndpointMetric = {
  id: string;
  endpointId: string;
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
  // What the window covers; targetIds lists IDs of that kind (group IDs for "group").
  scope: "all" | "site" | "endpoint" | "check" | "group";
  targetIds: string[];
  startsAt: string | null;
  endsAt: string | null;
  daysOfWeek: number[] | null;
  startTime: string | null;
  durationMinutes: number | null;
  // The zone a weekly window's startTime is read in (the browser that saved
  // it); null = the server's zone, for windows saved before this existed.
  timeZone?: string | null;
  enabled: boolean;
  active: boolean;
};
export type StatusPage = { id: string; slug: string; title: string; description: string | null; checkIds: string[]; published: boolean };

// ---- Groups and the navigation tree (routes/groups.ts, routes/tree.ts) ----
// The kinds of object a group can hold or a filter can select.
export type MemberType = "location" | "site" | "endpoint" | "check";
export type GroupRules = { match: "all" | "any"; conditions: { field: string; op: string; value: string }[] };
// A group as listed: its definition plus what it currently contains.
export type Group = {
  id: string;
  name: string;
  description: string | null;
  kind: "manual" | "filter";
  target: MemberType | null;
  rules: GroupRules;
  createdAt: string;
  counts: { locations: number; sites: number; endpoints: number; checks: number; coveredChecks: number };
  status: Status | null;
  problems: number;
};
// One group opened: its direct members, and every check/endpoint it covers
// through the hierarchy (what bulk actions on the group act on).
export type GroupDetail = Omit<Group, "id" | "name" | "description" | "kind" | "target" | "rules" | "createdAt"> & {
  group: Pick<Group, "id" | "name" | "description" | "kind" | "target" | "rules" | "createdAt">;
  members: {
    locations: { id: string; name: string }[];
    sites: { id: string; name: string; status: Status | null }[];
    endpoints: { id: string; name: string; os: string | null; site: string | null; status: Status | null }[];
    checks: { id: string; name: string; type: string; status: Status | null; enabled: boolean; endpoint: string | null; site: string | null }[];
  };
  coveredCheckIds: string[];
  coveredEndpointIds: string[];
};
export type GroupFields = { fields: Record<MemberType, { field: string; label: string; hint?: string }[]>; ops: string[] };
// Navigation tree nodes. status = worst status of the node's enabled checks;
// problems = how many of them are warn or down; checkCount = enabled checks.
export type TreeSummary = { status: Status | null; problems: number; checkCount: number };
export type TreeCheck = { id: string; name: string; type: string; status: Status | null; enabled: boolean };
export type TreeEndpoint = TreeSummary & { id: string; name: string; os: string | null; agent: boolean; collector: boolean; children: TreeCheck[] };
export type TreeSite = TreeSummary & { id: string; name: string; endpoints: TreeEndpoint[]; checks: TreeCheck[] };
export type TreeLocation = TreeSummary & { id: string; name: string; sites: TreeSite[] };
export type TreeGroup = TreeSummary & { id: string; name: string; kind: "manual" | "filter" };
export type Tree = { locations: TreeLocation[]; unassignedSites: TreeSite[]; groups: TreeGroup[] };
export type PublicStatus = {
  title: string;
  description: string | null;
  overall: "operational" | "degraded" | "down";
  // The zone the daily bars were cut in — the visitor's, or "UTC" if theirs
  // wasn't usable.
  timeZone?: string;
  generatedAt: string;
  checks: { name: string; status: Status; lastCheckedAt: string | null; uptime90: number | null; days: { day: string; uptime: number | null }[] }[];
};
export type SlaRow = {
  checkId: string;
  name: string;
  type: string;
  siteId: string;
  uptimePercent: number | null;
  downtimeMinutes: number;
  degradedMinutes: number;
  maintenanceMinutes: number;
  incidents: number;
  avgLatencyMs: number | null;
  results: number;
};
export type EventRow = { id: string; source: "snmp_trap" | "syslog"; siteId: string | null; sourceIp: string; severity: number | null; facility: number | null; message: string; data: Record<string, unknown> | null; receivedAt: string };
export type FlowRow = { label: string; bytes: number; packets: number; avgMbps: number };
export type SuggestedCheck = { type: string; name: string; config: Record<string, unknown> };
export type DiscoveredDevice = {
  ip: string;
  hostname: string | null;
  mac: string | null;
  pingable: boolean;
  openPorts: { port: number; service: string }[];
  snmp: { sysName?: string; sysDescr?: string } | null;
  knownEndpointId: string | null;
  suggestedChecks: SuggestedCheck[];
};
export type LoginStep = { challengeId: string; step: "enroll" | "totp"; emailCode: boolean; enroll?: { secret: string; uri: string }; passkey?: PublicKeyCredentialRequestOptionsJSON | null };
export type WatchdogView = { enabled: boolean; urlSet: boolean; url: string | null; failUrlSet: boolean; failUrl: string | null; intervalSeconds: number; lastPingAt: string | null; lastResult: string | null; lastError: string | null; selfCheck: { ok: boolean; reason: string } };
export type Passkey = { id: string; name: string; deviceType: string | null; backedUp: boolean; createdAt: string; lastUsedAt: string | null; transports: string[] };
export type SecuritySettings = {
  allowlistEnabled: boolean;
  allowlist: string[];
  allowlistAgents: boolean;
  newIpConfirmation: boolean;
  lockoutThreshold: number;
  lockoutMinutes: number;
  sessionHours: number;
  idleTimeoutMinutes: number | null;
  minPasswordLength: number;
  notifyEmail: string | null;
  notifyChannelIds: string[];
  detectScans: boolean;
  updatedAt: string;
};
export type SecurityOverview = { settings: SecuritySettings; yourIp: string; totpEnabled: boolean; recoveryCodesLeft: number; passwordChangedAt: string | null; kinds: { kind: string; label: string; severity: string }[]; trustProxy: string };
export type SecurityEvent = { id: string; kind: string; severity: string; ip: string | null; userAgent: string | null; path: string | null; detail: string | null; createdAt: string };
export type SecurityRule = { id: string; name: string; enabled: boolean; kinds: string[]; threshold: number; windowMinutes: number; perIp: boolean; notify: boolean; blockMinutes: number | null; cooldownMinutes: number; lastFiredAt: string | null };
export type IpBlock = { id: string; ip: string; reason: string | null; until: string | null; createdAt: string };
export type TrustedIp = { id: string; ip: string; firstSeenAt: string; lastSeenAt: string };
export type SessionRow = { id: string; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string | null; expiresAt: string; current: boolean };
export type DiscoveryScan = { id: string; cidr: string; siteId: string | null; status: "queued" | "running" | "done" | "error"; results: DiscoveredDevice[]; error: string | null; startedAt: string; finishedAt: string | null };

// ---- Request helpers -------------------------------------------------------

/** fetch options for a POST with a JSON body. */
const json = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
/** fetch options for a PATCH (partial update) with a JSON body. */
const patch = (body: unknown) => ({ method: "PATCH", body: JSON.stringify(body) });
/** fetch options for a DELETE. */
const del = { method: "DELETE" };
/**
 * Builds a query string from an object, skipping empty values:
 * qs({ limit: 50, q: "" }) → "?limit=50". URLSearchParams handles escaping,
 * so user-typed search text can't break the URL.
 */
const qs = (params: Record<string, unknown>) => {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `?${s}` : "";
};

// ---- The API ---------------------------------------------------------------
// One function per engine route. Each takes the route's inputs and returns a
// promise of its response type; the route path in each line says which engine
// file handles it (/api/checks → engine/src/routes/checks.ts, and so on).

export const api = {
  // Sign-in, two-factor, passkeys and password (routes/auth.ts), and the
  // outbound watchdog (routes/watchdog.ts).
  login: (email: string, password: string) => request<LoginStep>("/api/auth/login", json({ email, password })),
  verifyLogin: (input: { challengeId: string; code?: string; emailCode?: string; recoveryCode?: string; passkey?: AuthenticationResponseJSON }) => request<{ id: string; email: string; recoveryCodes?: string[] }>("/api/auth/login/verify", json(input)),
  watchdog: () => request<WatchdogView>("/api/watchdog"),
  updateWatchdog: (input: { enabled?: boolean; url?: string | null; failUrl?: string | null; intervalSeconds?: number }) => request<WatchdogView>("/api/watchdog", patch(input)),
  testWatchdog: () => request<{ sent: boolean; healthy: boolean; detail: string }>("/api/watchdog/test", { method: "POST" }),
  passkeys: () => request<Passkey[]>("/api/auth/passkeys"),
  passkeyOptions: (code: string) => request<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>("/api/auth/passkeys/options", json({ code })),
  addPasskey: (input: { challengeId: string; name: string; response: RegistrationResponseJSON }) => request<{ id: string; name: string }>("/api/auth/passkeys", json(input)),
  removePasskey: (id: string) => request<void>(`/api/auth/passkeys/${id}`, del),
  changePassword: (input: { currentPassword: string; newPassword: string; code: string }) => request<{ ok: true }>("/api/auth/password", json(input)),
  regenerateRecoveryCodes: (code: string) => request<{ recoveryCodes: string[] }>("/api/auth/recovery-codes", json({ code })),
  rotateTotp: (code: string) => request<{ challengeId: string; secret: string; uri: string }>("/api/auth/totp/rotate", json({ code })),
  confirmRotateTotp: (challengeId: string, code: string) => request<{ ok: true }>("/api/auth/totp/rotate/confirm", json({ challengeId, code })),

  // System → Security: settings, the security log, rules, blocked and
  // trusted IPs, sessions (routes/security.ts).
  securityOverview: () => request<SecurityOverview>("/api/security/overview"),
  updateSecuritySettings: (input: Partial<SecuritySettings>) => request<SecuritySettings>("/api/security/settings", patch(input)),
  testSecurityNotification: () => request<{ sent: true }>("/api/security/test-notification", { method: "POST" }),
  securityEvents: (params: { kind?: string; ip?: string; severity?: string; q?: string; hours?: number; limit?: number }) => request<SecurityEvent[]>(`/api/security/events${qs(params)}`),
  securityRules: () => request<SecurityRule[]>("/api/security/rules"),
  createSecurityRule: (input: Partial<SecurityRule>) => request<SecurityRule>("/api/security/rules", json(input)),
  updateSecurityRule: (id: string, input: Partial<SecurityRule>) => request<SecurityRule>(`/api/security/rules/${id}`, patch(input)),
  deleteSecurityRule: (id: string) => request<void>(`/api/security/rules/${id}`, del),
  ipBlocks: () => request<IpBlock[]>("/api/security/blocks"),
  blockIp: (input: { ip: string; minutes?: number | null; reason?: string }) => request<{ ok: true }>("/api/security/blocks", json(input)),
  unblockIp: (id: string) => request<void>(`/api/security/blocks/${id}`, del),
  trustedIps: () => request<TrustedIp[]>("/api/security/trusted-ips"),
  forgetTrustedIp: (id: string) => request<void>(`/api/security/trusted-ips/${id}`, del),
  sessions: () => request<SessionRow[]>("/api/security/sessions"),
  revokeSession: (id: string) => request<{ revoked: number }>(`/api/security/sessions/${id}`, del),

  // Locations (routes/locations.ts), sign-out/current user, and the health check.
  locations: () => request<Location[]>("/api/locations"),
  createLocation: (input: { name: string; description?: string | null; address?: string | null; siteIds?: string[] }) => request<Location>("/api/locations", json(input)),
  updateLocation: (id: string, input: { name?: string; description?: string | null; address?: string | null; siteIds?: string[] }) => request<Location>(`/api/locations/${id}`, patch(input)),
  deleteLocation: (id: string) => request<void>(`/api/locations/${id}`, del),
  locationMaintenance: (id: string, minutes: number) => request<{ sites: number; checks: number }>(`/api/locations/${id}/maintenance`, json({ minutes })),
  logout: () => request<{ ok: true }>("/api/auth/logout", { method: "POST" }),
  me: () => request<{ id: string; email: string }>("/api/auth/me"),
  health: () => request<{ status: string; db: string; version: string; agentVersion: string | null }>("/api/health"),

  // Sites = networks/sites (routes/sites.ts).
  sites: () => request<Site[]>("/api/sites"),
  createSite: (input: SiteInput & { name: string }) => request<Site>("/api/sites", json(input)),
  updateSite: (id: string, input: SiteInput) => request<Site>(`/api/sites/${id}`, patch(input)),
  deleteSite: (id: string) => request<void>(`/api/sites/${id}`, del),
  bulkSites: (ids: string[], action: string, params: Record<string, unknown> = {}) => request<BulkResult>("/api/sites/bulk", json({ ids, action, ...params })),

  // Endpoints, agent keys, inventory, suggested checks, Wake-on-LAN and host
  // metrics (routes/endpoints.ts).
  endpoints: (siteId?: string) => request<Endpoint[]>(`/api/endpoints${qs({ siteId })}`),
  endpoint: (id: string) => request<EndpointDetail>(`/api/endpoints/${id}`),
  createEndpoint: (input: { siteId: string; name: string; hostname?: string; os?: string; macAddress?: string; tags?: string[] }) => request<Endpoint>("/api/endpoints", json(input)),
  updateEndpoint: (id: string, input: { name?: string; hostname?: string | null; os?: string | null; macAddress?: string | null; siteId?: string; tags?: string[] }) =>
    request<Endpoint>(`/api/endpoints/${id}`, patch(input)),
  deleteEndpoint: (endpointId: string) => request<void>(`/api/endpoints/${endpointId}`, del),
  issueAgentKey: (endpointId: string) => request<{ agentApiKey: string; installCommands: { unix: string; windows: string } }>(`/api/endpoints/${endpointId}/agent-key`, { method: "POST" }),
  requestEndpointUpdate: (endpointId: string) => request<{ requested: boolean }>(`/api/endpoints/${endpointId}/request-update`, { method: "POST" }),
  endpointMetricCatalog: () => request<MetricDef[]>("/api/endpoints/metric-catalog"),
  endpointSuggestions: (id: string) => request<Suggestion[]>(`/api/endpoints/${id}/suggestions`),
  applySuggestions: (id: string, keys: string[], opts: { alertRule?: AlertRulePayload | null; overrides?: Record<string, { name?: string; intervalSeconds?: number }> } = {}) => request<{ created: number }>(`/api/endpoints/${id}/suggestions/apply`, json({ keys, ...opts })),
  endpointInventory: (id: string) => request<EndpointInventory>(`/api/endpoints/${id}/inventory`),
  endpointAddresses: (id: string) => request<AddressRow[]>(`/api/endpoints/${id}/addresses`),
  wakeEndpoint: (id: string) => request<{ sent: boolean; viaCollector?: boolean }>(`/api/endpoints/${id}/wake`, { method: "POST" }),
  bulkEndpoints: (ids: string[], action: string, params: Record<string, unknown> = {}) => request<BulkResult>("/api/endpoints/bulk", json({ ids, action, ...params })),
  endpointMetrics: (endpointId: string, limit = 30, since?: string) => request<EndpointMetric[]>(`/api/endpoints/${endpointId}/metrics${qs({ limit, since })}`),

  // Checks: create (one or many targets), edit, run now, results, statistics,
  // SNMP walks and bulk actions (routes/checks.ts).
  checks: (siteId?: string) => request<Check[]>(`/api/checks${qs({ siteId })}`),
  createCheck: (input: Partial<CheckInput> & { siteId: string; type: string; name: string; alertRule?: AlertRulePayload | null }) => request<Check>("/api/checks", json(input)),
  createChecksBatch: (input: Partial<CheckInput> & { type: string; name: string; alertRule?: AlertRulePayload | null; targets: { siteId?: string; endpointId?: string }[] }) =>
    request<{ created: Check[]; errors: { target: string; error: string }[] }>("/api/checks/batch", json(input)),
  check: (id: string) => request<Check>(`/api/checks/${id}`),
  checkStats: (id: string, hours: number) => request<CheckStats>(`/api/checks/${id}/stats${qs({ hours })}`),
  snmpWalk: (input: { config: Record<string, unknown>; siteId?: string; checkId?: string }) => request<{ rows: WalkRow[]; truncated: boolean } | { jobId: string }>("/api/checks/snmp-walk", json(input)),
  snmpWalkJob: (jobId: string) => request<{ rows: WalkRow[]; truncated: boolean } | { pending: true }>(`/api/checks/snmp-walk/${jobId}`),
  updateCheck: (id: string, input: Partial<CheckInput>) => request<Check>(`/api/checks/${id}`, patch(input)),
  deleteCheck: (id: string) => request<void>(`/api/checks/${id}`, del),
  // A check run by a site collector comes back { queued, message } instead.
  runCheck: (id: string) => request<CheckResult | { queued: true; message: string }>(`/api/checks/${id}/run`, { method: "POST" }),
  // A new secret URL: for heartbeat/push checks where results are pushed; for
  // any other check a "recovery URL" that marks it recovered when called.
  regeneratePushToken: (id: string) => request<Check>(`/api/checks/${id}/regenerate-token`, { method: "POST" }),
  removeCheckToken: (id: string) => request<Check>(`/api/checks/${id}/remove-token`, { method: "POST" }),
  // Marks a failing check recovered by hand (with an optional note).
  // Excludes results from statistics (or counts them again): specific ones, or a time range.
  excludeResults: (id: string, input: { resultIds?: string[]; from?: string; to?: string; exclude?: boolean; reason?: string }) => request<{ changed: number }>(`/api/checks/${id}/results/exclude`, json(input)),
  resolveCheck: (id: string, note?: string) => request<{ resolved: true }>(`/api/checks/${id}/resolve`, json({ note })),
  bulkChecks: (ids: string[], action: string, params: Record<string, unknown> = {}) => request<BulkResult>("/api/checks/bulk", json({ ids, action, ...params })),
  checkResults: (checkId: string, limit = 50, since?: string) => request<CheckResult[]>(`/api/checks/${checkId}/results${qs({ limit, since })}`),

  // Notification channels and their message templates (routes/channels.ts).
  channels: () => request<Channel[]>("/api/channels"),
  createChannel: (input: { name: string; type: string; config: Record<string, unknown>; templates?: Record<string, ChannelTemplate> }) => request<Channel>("/api/channels", json(input)),
  updateChannel: (id: string, input: { name?: string; config?: Record<string, unknown>; enabled?: boolean; templates?: Record<string, ChannelTemplate> }) => request<Channel>(`/api/channels/${id}`, patch(input)),
  channelTemplates: () => request<TemplateInfo>("/api/channels/templates"),
  previewTemplates: (templates: Record<string, ChannelTemplate>) => request<Record<string, { title: string; body: string }>>("/api/channels/preview", json({ templates })),
  testChannel: (id: string) => request<{ sent: true }>(`/api/channels/${id}/test`, { method: "POST" }),
  deleteChannel: (id: string) => request<void>(`/api/channels/${id}`, del),

  // Outgoing email server settings (routes/smtp.ts).
  smtpSettings: () => request<{ settings: SmtpSettings }>("/api/smtp/settings"),
  updateSmtpSettings: (input: { host?: string | null; port?: number | null; user?: string | null; password?: string; from?: string | null }) =>
    request<{ settings: SmtpSettings }>("/api/smtp/settings", patch(input)),
  sendTestEmail: (to: string) => request<{ sent: boolean }>("/api/smtp/test", json({ to })),

  // Alert rules per check and the alert history (routes/alertRules.ts).
  alertRules: (checkId: string) => request<AlertRule[]>(`/api/alert-rules${qs({ checkId })}`),
  createAlertRule: (input: AlertRuleInput & { checkId: string }) => request<AlertRule>("/api/alert-rules", json(input)),
  updateAlertRule: (id: string, input: AlertRuleInput) => request<AlertRule>(`/api/alert-rules/${id}`, patch(input)),
  deleteAlertRule: (id: string) => request<void>(`/api/alert-rules/${id}`, del),
  alertEvents: (params?: AlertEventQuery) => request<AlertEvent[]>(`/api/alert-rules/events${qs(params ?? {})}`),

  // Browser push notifications (routes/push.ts).
  vapidPublicKey: () => request<{ publicKey: string }>("/api/push/vapid-public-key"),
  subscribePush: (subscription: PushSubscriptionJSON) => request<{ ok: true }>("/api/push/subscribe", json(subscription)),

  // Borg backups and restore (routes/backups.ts), and the engine log viewer (routes/logs.ts).
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

  // Dashboards and their widgets (routes/dashboards.ts).
  dashboards: () => request<Dashboard[]>("/api/dashboards"),
  createDashboard: (name: string) => request<Dashboard>("/api/dashboards", json({ name })),
  renameDashboard: (id: string, name: string) => request<Dashboard>(`/api/dashboards/${id}`, patch({ name })),
  updateDashboardRefresh: (id: string, refreshSeconds: number) => request<Dashboard>(`/api/dashboards/${id}`, patch({ refreshSeconds })),
  deleteDashboard: (id: string) => request<void>(`/api/dashboards/${id}`, del),
  widgets: (dashboardId: string) => request<Widget[]>(`/api/dashboards/${dashboardId}/widgets`),
  createWidget: (dashboardId: string, input: { type: WidgetType; config: Widget["config"]; x: number; y: number; w: number; h: number }) => request<Widget>(`/api/dashboards/${dashboardId}/widgets`, json(input)),
  updateWidget: (widgetId: string, input: Partial<Pick<Widget, "x" | "y" | "w" | "h" | "config">>) => request<Widget>(`/api/dashboards/widgets/${widgetId}`, patch(input)),
  deleteWidget: (widgetId: string) => request<void>(`/api/dashboards/widgets/${widgetId}`, del),

  // Groups and the navigation tree (routes/groups.ts, routes/tree.ts).
  tree: () => request<Tree>("/api/tree"),
  groups: () => request<Group[]>("/api/groups"),
  group: (id: string) => request<GroupDetail>(`/api/groups/${id}`),
  groupFields: () => request<GroupFields>("/api/groups/fields"),
  groupPreview: (target: MemberType, rules: GroupRules) => request<{ total: number; matches: { id: string; name: string }[] }>("/api/groups/preview", json({ target, rules })),
  groupsOf: (type: MemberType, id: string) => request<{ id: string; name: string; kind: "manual" | "filter" }[]>(`/api/groups/of/${type}/${id}`),
  createGroup: (input: { name: string; description?: string | null; kind: "manual" | "filter"; target?: MemberType; rules?: GroupRules; members?: { type: MemberType; id: string }[] }) => request<Group>("/api/groups", json(input)),
  updateGroup: (id: string, input: { name?: string; description?: string | null; target?: MemberType; rules?: GroupRules }) => request<Group>(`/api/groups/${id}`, patch(input)),
  deleteGroup: (id: string) => request<void>(`/api/groups/${id}`, del),
  groupMembers: (id: string, change: { add?: { type: MemberType; id: string }[]; remove?: { type: MemberType; id: string }[] }) =>
    request<{ added: number; removed: number; members: number }>(`/api/groups/${id}/members`, json(change)),

  // Maintenance windows (routes/maintenance.ts).
  maintenance: () => request<MaintenanceWindow[]>("/api/maintenance"),
  createMaintenance: (input: Partial<MaintenanceWindow>) => request<MaintenanceWindow>("/api/maintenance", json(input)),
  updateMaintenance: (id: string, input: Partial<MaintenanceWindow>) => request<MaintenanceWindow>(`/api/maintenance/${id}`, patch(input)),
  endMaintenance: (id: string) => request<MaintenanceWindow>(`/api/maintenance/${id}/end`, { method: "POST" }),
  deleteMaintenance: (id: string) => request<void>(`/api/maintenance/${id}`, del),

  // Status pages: managing them (routes/statusPages.ts) and the public view
  // (routes/public.ts). The public view sends the visitor's time zone so each
  // daily uptime bar covers the visitor's own calendar day.
  statusPages: () => request<StatusPage[]>("/api/status-pages"),
  createStatusPage: (input: Partial<StatusPage>) => request<StatusPage>("/api/status-pages", json(input)),
  updateStatusPage: (id: string, input: Partial<StatusPage>) => request<StatusPage>(`/api/status-pages/${id}`, patch(input)),
  deleteStatusPage: (id: string) => request<void>(`/api/status-pages/${id}`, del),
  publicStatus: (slug: string) => request<PublicStatus>(`/api/public/status/${encodeURIComponent(slug)}${qs({ tz: browserTimeZone() })}`),

  // Reports, received events (syslog/traps), top talkers and discovery (routes/insights.ts).

  slaReport: (days: number, siteId?: string) => request<{ days: number; checks: SlaRow[] }>(`/api/insights/reports/sla${qs({ days, siteId })}`),
  // Fetched as a blob (not a plain link) so the session cookie travels with
  // it in the dev setup, where the API is on a different origin.
  slaCsv: async (days: number, siteId?: string) => {
    const res = await fetch(`${API_URL}/api/insights/reports/sla${qs({ days, siteId, format: "csv" })}`, { credentials: "include" });
    if (!res.ok) throw new ApiError(res.status, "CSV export failed");
    return res.blob();
  },
  events: (params: { source?: string; sourceIp?: string; q?: string; maxSeverity?: string; site?: string; limit?: number }) => request<EventRow[]>(`/api/insights/events${qs(params)}`),
  topFlows: (params: { minutes: number; by: string; exporter?: string; site?: string; limit?: number }) => request<FlowRow[]>(`/api/insights/flows/top${qs(params)}`),
  flowExporters: () => request<{ exporter: string; last: string }[]>("/api/insights/flows/exporters"),
  discoveryScans: () => request<DiscoveryScan[]>("/api/insights/discovery/scans"),
  discoveryScan: (id: string) => request<DiscoveryScan>(`/api/insights/discovery/scans/${id}`),
  startDiscovery: (cidr: string, community?: string, siteId?: string) => request<DiscoveryScan>("/api/insights/discovery/scans", json({ cidr, community, siteId })),
  addDiscovered: (scanId: string, input: { siteId: string; alertRule?: AlertRulePayload | null; devices: { ip: string; name?: string; mac?: string | null; createEndpoint: boolean; checks: SuggestedCheck[] }[] }) =>
    request<{ endpointsCreated: number; checksCreated: number }>(`/api/insights/discovery/scans/${scanId}/add`, json(input)),
};
