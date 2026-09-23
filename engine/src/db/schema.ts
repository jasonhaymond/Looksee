import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  boolean,
  integer,
  doublePrecision,
  bigint,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

// "agent_service" queries the real OS service manager (systemctl/Windows
// service manager) via the agent; "agent_process" is a raw process-list
// name match. They used to be one type ("agent_service" doing what
// "agent_process" does now) — see the 0004 migration pair for the backfill
// that moved existing rows onto the name that actually describes them.
export const checkType = pgEnum("check_type", [
  "ping",
  "tcp",
  "http",
  "dns",
  "ssl_cert",
  "agent_service",
  "agent_process",
  "host_cpu",
  "host_memory",
  "host_disk",
  "snmp",
]);

// The two types the Go agent actively reports results for (as opposed to
// the agentless prober) — both require a hostId, and both are what
// GET /api/agent/config filters on. Shared between routes/checks.ts and
// routes/agent.ts so the two stay in sync.
export const AGENT_CHECK_TYPES = ["agent_service", "agent_process"] as const;

// Also require a hostId, but unlike AGENT_CHECK_TYPES these are never sent
// to the agent to actively check — the engine evaluates them itself
// against the metrics payload already included in every agent report (see
// routes/agent.ts's POST /report), since the agent has collected
// cpu/mem/disk on every cycle since v1.0.0 but nothing alerted on it until
// now.
export const HOST_METRIC_CHECK_TYPES = ["host_cpu", "host_memory", "host_disk"] as const;

// Every check type that requires a hostId, for the shared gate in
// routes/checks.ts — the union of the two sets above.
export const HOST_SCOPED_CHECK_TYPES = [...AGENT_CHECK_TYPES, ...HOST_METRIC_CHECK_TYPES] as const;

// Everything the engine itself actively probes on a timer (services/scheduler.ts) —
// derived from checkType's own value list rather than hand-duplicated, so a
// new agentless check type (like snmp) is picked up automatically instead of
// silently never running until someone remembers to also update the
// scheduler's own copy of this list (a real bug caught during 2.0 testing:
// snmp checks got created fine but the scheduler never ran them).
export const AGENTLESS_CHECK_TYPES = checkType.enumValues.filter(
  (t) => !(HOST_SCOPED_CHECK_TYPES as readonly string[]).includes(t)
) as string[];

export const checkStatus = pgEnum("check_status", ["up", "down", "warn", "unknown"]);

export const channelType = pgEnum("channel_type", [
  "email",
  "webhook",
  "web_push",
  "sms",
]);

export const alertEventStatus = pgEnum("alert_event_status", ["triggered", "resolved"]);

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// An Endpoint exists from v1 even with only one row configured (the personal
// homelab) so a second network later (e.g. the church/AV network) is a row,
// not a schema migration — see spec.md. Named "endpoints" (renamed from
// "sites" in 2.1.0) since "site" read as web-hosting terminology to some
// users; the concept itself — a logical group/network — is unchanged.
export const endpoints = pgTable("endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A monitored host/device. Not every check needs a host row (a plain URL
// uptime check doesn't correspond to a device you manage) — checks.hostId is
// nullable for that reason.
export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id")
    .notNull()
    .references(() => endpoints.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hostname: text("hostname"),
  os: text("os"),
  // Bearer token the Go agent presents when reporting in. Null until an
  // agent is actually provisioned for this host (agentless-only hosts never
  // get one).
  agentApiKey: text("agent_api_key").unique(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  // Snapshot of what the agent actually found on its last report cycle —
  // string arrays, refreshed every report, null until the agent has
  // reported at least once. Feeds the check form's name suggestions
  // (dashboard/app/components/CheckConfigFields.tsx) rather than making
  // someone type an exact service/process name blind.
  availableProcesses: jsonb("available_processes"),
  availableServices: jsonb("available_services"),
  // Push-to-update: agentVersion is set from whatever the agent itself
  // reports (main.go's -ldflags-injected version), so it reflects what's
  // actually running, not what was last deployed. updateRequested is a
  // one-shot flag — set by POST /:id/request-update, consumed (flipped
  // back to false) the next time GET /api/agent/config is read for this
  // host, whether or not the update actually succeeds; the agentVersion
  // changing on a later report is the real confirmation signal.
  agentVersion: text("agent_version"),
  updateRequested: boolean("update_requested").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// One monitored thing: a reachability probe run by the engine, or a metric/
// service check reported in by an agent. `config` is a small per-type jsonb
// blob (e.g. { url, expectedStatus } for http, { port } for tcp,
// { serviceName } for agent_service) — deliberately not a generic template
// system; each check type's config shape is fixed and validated in the
// route handler, not user-defined.
export const checks = pgTable("checks", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id")
    .notNull()
    .references(() => endpoints.id, { onDelete: "cascade" }),
  hostId: uuid("host_id").references(() => hosts.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: checkType("type").notNull(),
  config: jsonb("config").notNull().default({}),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  enabled: boolean("enabled").notNull().default(true),
  // Bookkeeping for the scheduler loop (services/scheduler.ts) so "is this
  // check due" is a cheap column comparison instead of a subquery against
  // check_results on every tick. Only meaningful for agentless check types;
  // agent-reported checks (agent_service) are updated by the ingest route
  // as reports arrive, not polled.
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Time-series result for every check, agentless and agent-reported alike —
// one shared table keeps "uptime % over the last 7 days" a single query
// regardless of check type.
export const checkResults = pgTable("check_results", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  status: checkStatus("status").notNull(),
  latencyMs: integer("latency_ms"),
  message: text("message"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
});

// Host-level resource metrics reported by the Go agent on its own interval —
// separate from check_results because this is always-on telemetry for a
// host, not the pass/fail result of one configured check.
export const hostMetrics = pgTable("host_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  cpuPercent: doublePrecision("cpu_percent"),
  memPercent: doublePrecision("mem_percent"),
  diskPercent: doublePrecision("disk_percent"),
  netRxBytes: bigint("net_rx_bytes", { mode: "number" }),
  netTxBytes: bigint("net_tx_bytes", { mode: "number" }),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
});

// A destination alert rules can notify. `config` shape depends on `type`
// (e.g. { to } for email, { url } for webhook, { subscription } for
// web_push) — write-only from the admin UI once saved, per the security
// baseline in the global dev standards.
export const notificationChannels = pgTable("notification_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  type: channelType("type").notNull(),
  config: jsonb("config").notNull().default({}),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A rule with zero linked channels is valid — the check just shows on the
// dashboard with no alerting, per spec.md's "alerting is opt-in per rule."
export const alertRules = pgTable("alert_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  // Consecutive failing results required before this rule fires, to avoid
  // alerting on a single flaky/blip result.
  consecutiveFailures: integer("consecutive_failures").notNull().default(2),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const alertRuleChannels = pgTable("alert_rule_channels", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertRuleId: uuid("alert_rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  channelId: uuid("channel_id")
    .notNull()
    .references(() => notificationChannels.id, { onDelete: "cascade" }),
});

// One row per triggered incident, closed out with resolvedAt once the check
// recovers — this is what an "incident history" list on the dashboard reads
// from, distinct from the raw check_results firehose.
export const alertEvents = pgTable("alert_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertRuleId: uuid("alert_rule_id")
    .notNull()
    .references(() => alertRules.id, { onDelete: "cascade" }),
  status: alertEventStatus("status").notNull().default("triggered"),
  triggeredAt: timestamp("triggered_at", { withTimezone: true }).notNull().defaultNow(),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

// Singleton row (id always 1) — SMTP server config for the "email" alert
// channel type. Was env-var-only (SMTP_HOST/PORT/USER/PASSWORD/FROM,
// engine/.env) with no discoverable way to set it short of editing that
// file directly on the server; this is the actual admin-UI path, following
// the same write-only-password pattern as backupSettings below. The env
// vars still work as a fallback per-field (see services/notifications/
// email.ts) so an existing .env-based setup doesn't silently break.
export const smtpSettings = pgTable("smtp_settings", {
  id: integer("id").primaryKey(),
  host: text("host"),
  port: integer("port"),
  user: text("user"),
  password: text("password"),
  from: text("from"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const backupRunKind = pgEnum("backup_run_kind", ["backup", "restore"]);
export const backupRunStatus = pgEnum("backup_run_status", ["running", "success", "error"]);

// Singleton row (id always 1) — Borg repository + schedule config. The
// passphrase is write-only from the admin UI once saved (never redisplayed),
// per the security baseline.
export const backupSettings = pgTable("backup_settings", {
  id: integer("id").primaryKey(),
  repoUrl: text("repo_url"),
  passphrase: text("passphrase"),
  // 5-field cron expression, or null to disable automatic backups.
  schedule: text("schedule"),
  retentionCount: integer("retention_count"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Audit trail of backup/restore attempts, independent of what's currently
// in the Borg repo (an archive can be pruned; this row still shows it ran).
export const backupRuns = pgTable("backup_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: backupRunKind("kind").notNull(),
  archiveName: text("archive_name").notNull(),
  status: backupRunStatus("status").notNull().default("running"),
  message: text("message"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

export const widgetType = pgEnum("widget_type", [
  "status_tile",
  "group_summary",
  "host_metrics",
  "uptime_history",
  "note",
  "alert_history",
  "network_bandwidth",
  "all_hosts",
  "backup_status",
  "clock",
  "section_header",
]);

export const dashboards = pgTable("dashboards", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // How often the dashboard page polls for fresh status/metrics while this
  // dashboard is active — was a hardcoded 15s constant, now per-dashboard.
  refreshSeconds: integer("refresh_seconds").notNull().default(15),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A widget's `config` shape depends on `type` — { checkId } for status_tile,
// { endpointId } for group_summary — same "fixed shape per type, not a generic
// template" posture as checks.config. x/y/w/h are react-grid-layout's own
// grid units, persisted as-is so the canvas restores exactly where it was
// left; there's no separate "layout" concept beyond these four columns.
export const dashboardWidgets = pgTable("dashboard_widgets", {
  id: uuid("id").primaryKey().defaultRandom(),
  dashboardId: uuid("dashboard_id")
    .notNull()
    .references(() => dashboards.id, { onDelete: "cascade" }),
  type: widgetType("type").notNull(),
  config: jsonb("config").notNull().default({}),
  x: integer("x").notNull().default(0),
  y: integer("y").notNull().default(0),
  w: integer("w").notNull().default(4),
  h: integer("h").notNull().default(3),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const webPushSubscriptions = pgTable("web_push_subscriptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  endpoint: text("endpoint").notNull().unique(),
  p256dh: text("p256dh").notNull(),
  auth: text("auth").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const logLevel = pgEnum("log_level", ["debug", "info", "warn", "error"]);

// Server-side structured logging — separate from pm2's stdout capture, this
// is what the in-app /logs viewer reads. humanMessage is required by the
// logger's own types for every level except debug (see lib/logger.ts); it's
// nullable here only because debug rows never populate it.
export const logs = pgTable("logs", {
  id: uuid("id").primaryKey().defaultRandom(),
  level: logLevel("level").notNull(),
  source: text("source").notNull(),
  message: text("message").notNull(),
  humanMessage: text("human_message"),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Singleton row (id always 1), upserted on every successful boot — not just
// deploys — so it reflects what's actually been running rather than what a
// deploy script assumed. This is what backup filenames stamp themselves
// with (see services/backup.ts), so a snapshot's origin version is
// answerable by its filename, not by cross-referencing timestamps.
export const appMeta = pgTable("app_meta", {
  id: integer("id").primaryKey(),
  version: text("version").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
