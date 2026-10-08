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
  index,
} from "drizzle-orm/pg-core";

import { CHECK_TYPES, ENGINE_CHECK_TYPES } from "./checkTypes.js";

// Who runs each type (engine scheduler, agent, or report-time evaluation)
// lives in checkTypes.ts — this enum is just its key list, so adding a type
// there is the one edit needed for the database side too.
export const checkType = pgEnum("check_type", CHECK_TYPES);

export const checkStatus = pgEnum("check_status", ["up", "down", "warn", "unknown"]);

export {
  AGENT_CHECK_TYPES,
  REPORT_CHECK_TYPES,
  HOST_SCOPED_CHECK_TYPES,
  REMOTE_PROBE_CHECK_TYPES,
  ENGINE_CHECK_TYPES,
} from "./checkTypes.js";

// Kept under its pre-3.0 name: "agentless" here means "the engine's own
// scheduler runs it", which is exactly ENGINE_CHECK_TYPES.
export const AGENTLESS_CHECK_TYPES = ENGINE_CHECK_TYPES as string[];


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
  // For Wake-on-LAN (POST /api/hosts/:id/wake) and ARP presence checks.
  macAddress: text("mac_address"),
  // Hardware/OS inventory the 3.x agent sends when it changes (OS, kernel,
  // model, serial, CPU, RAM) — host_change checks diff against this.
  inventory: jsonb("inventory"),
  // The agent's most recent full metrics snapshot, so "what does this host
  // look like right now" (hosts page detail, suggested checks) is one row
  // read rather than a scan of host_metrics.
  lastSnapshot: jsonb("last_snapshot"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
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
  // While the last result wasn't "up", re-run on this shorter interval
  // instead (Nagios's retry_interval) so recovery and N-consecutive-failure
  // alerts land sooner. Null = always use intervalSeconds.
  retryIntervalSeconds: integer("retry_interval_seconds"),
  // Pins an engine-executed check (ping/tcp/http/dns/ssl_cert) to this
  // host's agent instead, so it runs from inside that host's network.
  probeHostId: uuid("probe_host_id").references(() => hosts.id, { onDelete: "set null" }),
  // Secret path segment for heartbeat/push_value checks: /api/hb/<token>.
  pushToken: text("push_token").unique(),
  // Per-check memory between runs: previous counters for rate math, the
  // last traceroute path, the last-seen public IP, baseline checksums.
  state: jsonb("state").notNull().default({}),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  // Denormalized copy of the newest check_results row, written by
  // recordCheckResult — lets list views show status for hundreds of checks
  // without one results query per check.
  lastStatus: checkStatus("last_status"),
  lastMessage: text("last_message"),
  lastValue: doublePrecision("last_value"),
  lastLatencyMs: integer("last_latency_ms"),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastStatusChangeAt: timestamp("last_status_change_at", { withTimezone: true }),
  flapping: boolean("flapping").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// L2 dependencies: while any parent is down, the child's alerts are
// suppressed (its results are still recorded) — "router down" shouldn't
// page once per device behind it.
export const checkDependencies = pgTable("check_dependencies", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkId: uuid("check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
  dependsOnCheckId: uuid("depends_on_check_id")
    .notNull()
    .references(() => checks.id, { onDelete: "cascade" }),
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
  // The check's measured number (loss %, days left, queue depth, ...) —
  // what thresholds, graphs, and anomaly baselines read.
  value: doublePrecision("value"),
  // Structured extras (hop list, interface table, matched lines). Nulled
  // after a week by the retention job; the row itself is kept for SLA math.
  details: jsonb("details"),
  // Recorded during a maintenance window — excluded from SLA reports and
  // never alerts.
  inMaintenance: boolean("in_maintenance").notNull().default(false),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("check_results_check_time_idx").on(t.checkId, t.checkedAt)]);

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
  // Full 3.x agent snapshot (per-core CPU, every mount, interfaces, SMART,
  // ...). The five columns above stay for pre-3.0 agents and the existing
  // widgets.
  extended: jsonb("extended"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("host_metrics_host_time_idx").on(t.hostId, t.recordedAt)]);

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
  // "down" fires only on down results; "warn" fires on warn or down.
  triggerOn: text("trigger_on").notNull().default("down"),
  // Re-send the alert every N minutes while it stays open (L12).
  renotifyMinutes: integer("renotify_minutes"),
  // After N minutes still open, also notify the escalation channels.
  escalateAfterMinutes: integer("escalate_after_minutes"),
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
  // Escalation-only channel: notified once escalateAfterMinutes passes.
  escalation: boolean("escalation").notNull().default(false),
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
  severity: text("severity").notNull().default("down"),
  message: text("message"),
  lastNotifiedAt: timestamp("last_notified_at", { withTimezone: true }),
  escalatedAt: timestamp("escalated_at", { withTimezone: true }),
}, (t) => [index("alert_events_rule_idx").on(t.alertRuleId, t.triggeredAt)]);

// L1. Either a one-off window (startsAt..endsAt) or a weekly recurrence
// (daysOfWeek + startTime + durationMinutes, in the engine's local time).
// scope "all" ignores targetIds.
export const maintenanceWindows = pgTable("maintenance_windows", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  scope: text("scope").notNull().default("all"),
  targetIds: jsonb("target_ids").$type<string[]>().notNull().default([]),
  startsAt: timestamp("starts_at", { withTimezone: true }),
  endsAt: timestamp("ends_at", { withTimezone: true }),
  daysOfWeek: jsonb("days_of_week").$type<number[]>(),
  startTime: text("start_time"),
  durationMinutes: integer("duration_minutes"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const eventSource = pgEnum("event_source", ["snmp_trap", "syslog"]);

// Inbound SNMP traps and syslog messages (H3/H5). trap_match/syslog_match
// checks count rows matching their filter over a window.
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: eventSource("source").notNull(),
  sourceIp: text("source_ip").notNull(),
  // Syslog severity 0 (emergency) .. 7 (debug); traps are stored as 4.
  severity: integer("severity"),
  facility: integer("facility"),
  message: text("message").notNull(),
  data: jsonb("data"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("events_received_idx").on(t.receivedAt)]);

// NetFlow/IPFIX/sFlow conversations, pre-aggregated per minute per
// exporter so a busy exporter doesn't mean a row per packet.
export const flowRecords = pgTable("flow_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  bucket: timestamp("bucket", { withTimezone: true }).notNull(),
  exporter: text("exporter").notNull(),
  srcAddr: text("src_addr").notNull(),
  dstAddr: text("dst_addr").notNull(),
  protocol: integer("protocol"),
  dstPort: integer("dst_port"),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  packets: bigint("packets", { mode: "number" }).notNull(),
}, (t) => [index("flow_records_bucket_idx").on(t.bucket)]);

export const discoveryScans = pgTable("discovery_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  cidr: text("cidr").notNull(),
  status: text("status").notNull().default("running"),
  results: jsonb("results").notNull().default([]),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// L8. Public (unauthenticated) page at /status/<slug> showing only the
// listed checks' names, current status, and uptime bars.
export const statusPages = pgTable("status_pages", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description"),
  checkIds: jsonb("check_ids").$type<string[]>().notNull().default([]),
  published: boolean("published").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
  "top_talkers",
  "status_summary",
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
