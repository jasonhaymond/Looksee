// The database layout: every Postgres table and enum Looksee uses.
//
// Where this sits: this file is the single source of truth for the schema.
// Drizzle (the database library the engine uses, an "ORM" — it turns these
// TypeScript definitions into SQL) reads it two ways: at runtime, so queries
// elsewhere in the engine are type-checked against real column names; and at
// development time, when `npx drizzle-kit generate` compares it with the last
// migration and writes the next SQL migration into engine/drizzle/. Servers
// only ever apply those committed migrations (`npm run db:migrate`), never
// this file directly.
//
// Reading the definitions: `pgTable("name", { field: type("column") })` is one
// table; the TypeScript field name (camelCase) maps to the column name in
// quotes (snake_case). `jsonb` is a Postgres column holding structured JSON.
// `.references(() => other.id, { onDelete: "cascade" })` is a foreign key:
// deleting the referenced row also deletes this one ("set null" clears the
// link instead). `pgEnum` is a Postgres type that only accepts the listed
// words. Every timestamp is stored `withTimezone`, i.e. as an absolute
// instant (shown as UTC), never as a local wall-clock time.
//
// Security-relevant columns (password hashes, TOTP secrets, agent keys,
// channel/backup/SMTP secrets) are noted where they're defined; the routes
// that expose these tables are responsible for never returning them.

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
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";

import { CHECK_TYPES, ENGINE_CHECK_TYPES } from "./checkTypes.js";

// Who runs each type (engine scheduler, agent, or report-time evaluation)
// lives in checkTypes.ts — this enum is just its key list, so adding a type
// there is the one edit needed for the database side too.
export const checkType = pgEnum("check_type", CHECK_TYPES);

// A check's result: "warn" is degraded-but-working; "unknown" means the
// check couldn't tell (agent silent, collector offline, misconfigured).
export const checkStatus = pgEnum("check_status", ["up", "down", "warn", "unknown"]);

// Re-exported so the rest of the engine can import check-type groupings from
// the schema module alongside the tables.

export {
  AGENT_CHECK_TYPES,
  REPORT_CHECK_TYPES,
  ENDPOINT_SCOPED_CHECK_TYPES,
  REMOTE_PROBE_CHECK_TYPES,
  ENGINE_CHECK_TYPES,
} from "./checkTypes.js";

// Kept under its pre-3.0 name: "agentless" here means "the engine's own
// scheduler runs it", which is exactly ENGINE_CHECK_TYPES.
export const AGENTLESS_CHECK_TYPES = ENGINE_CHECK_TYPES as string[];

// The kinds of notification destination an alert can be sent to.
export const channelType = pgEnum("channel_type", [
  "email",
  "webhook",
  "web_push",
  "sms",
  "telegram",
  "slack",
  "teams",
]);

// An alert incident is open ("triggered") until its check recovers.
export const alertEventStatus = pgEnum("alert_event_status", ["triggered", "resolved"]);

// The admin account(s). Looksee is single-admin by design (see CLAUDE.md).
// Passwords are stored only as bcrypt hashes, never in plain text.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // TOTP two-factor: the base32 secret is set at enrollment and only counts
  // once totpEnabled is true (after the first code is verified). Recovery
  // codes are stored bcrypt-hashed and removed as they're used.
  totpSecret: text("totp_secret"),
  totpEnabled: boolean("totp_enabled").notNull().default(false),
  recoveryCodes: jsonb("recovery_codes").$type<string[]>().notNull().default([]),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Signed-in browser sessions. The token is the random value in the
// httpOnly session cookie; deleting the row signs that browser out.
export const sessions = pgTable("sessions", {
  token: text("token").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  // Where the session was created and last used, for the Security page's
  // session list and the idle timeout.
  ip: text("ip"),
  userAgent: text("user_agent"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Singleton row (id always 1). Every safeguard is off or permissive by
// default so an upgrade never locks anyone out; scripts/security-reset
// (npm run security:reset) turns the restrictive ones back off from a shell.
export const securitySettings = pgTable("security_settings", {
  id: integer("id").primaryKey(),
  allowlistEnabled: boolean("allowlist_enabled").notNull().default(false),
  // IPs and CIDRs (v4 or v6) allowed to reach the sign-in and admin API.
  allowlist: jsonb("allowlist").$type<string[]>().notNull().default([]),
  // Also apply the allowlist to agent/collector/heartbeat traffic.
  allowlistAgents: boolean("allowlist_agents").notNull().default(false),
  newIpConfirmation: boolean("new_ip_confirmation").notNull().default(false),
  lockoutThreshold: integer("lockout_threshold").notNull().default(5),
  lockoutMinutes: integer("lockout_minutes").notNull().default(15),
  sessionHours: integer("session_hours").notNull().default(720),
  idleTimeoutMinutes: integer("idle_timeout_minutes"),
  minPasswordLength: integer("min_password_length").notNull().default(12),
  // Where security notifications go: an email address (blank = the admin
  // account's) and/or any notification channels.
  notifyEmail: text("notify_email"),
  notifyChannelIds: jsonb("notify_channel_ids").$type<string[]>().notNull().default([]),
  detectScans: boolean("detect_scans").notNull().default(true),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Singleton row (id always 1): the outbound "dead man's switch". While the
// engine is healthy it pings `url` every intervalSeconds; an outside service
// (Healthchecks.io, Uptime Kuma push, …) alerts when the pings stop — the one
// failure Looksee can't report itself. The URLs carry the service's token, so
// they're write-only like other secrets.
export const watchdogSettings = pgTable("watchdog_settings", {
  id: integer("id").primaryKey(),
  enabled: boolean("enabled").notNull().default(false),
  url: text("url"),
  // Optional: called instead of `url` when the self-check fails (e.g. a
  // Healthchecks.io ".../fail" URL), so a stuck-but-alive engine alerts too.
  failUrl: text("fail_url"),
  intervalSeconds: integer("interval_seconds").notNull().default(60),
  lastPingAt: timestamp("last_ping_at", { withTimezone: true }),
  lastResult: text("last_result"),
  lastError: text("last_error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Everything security-relevant that happened: sign-ins, failures, blocks,
// scanner probes, bad agent keys. Security rules count these.
export const securityEvents = pgTable("security_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  kind: text("kind").notNull(),
  severity: text("severity").notNull().default("info"),
  ip: text("ip"),
  userAgent: text("user_agent"),
  path: text("path"),
  detail: text("detail"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("security_events_time_idx").on(t.createdAt), index("security_events_ip_idx").on(t.ip, t.createdAt)]);

// "When N events of these kinds happen within M minutes (per IP or in
// total), notify and/or block the IP." Defaults are seeded; any can be
// edited, disabled or added to.
export const securityRules = pgTable("security_rules", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  kinds: jsonb("kinds").$type<string[]>().notNull().default([]),
  threshold: integer("threshold").notNull().default(5),
  windowMinutes: integer("window_minutes").notNull().default(10),
  perIp: boolean("per_ip").notNull().default(true),
  notify: boolean("notify").notNull().default(true),
  blockMinutes: integer("block_minutes"),
  cooldownMinutes: integer("cooldown_minutes").notNull().default(60),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Addresses refused before any route runs (middleware/securityGate.ts), added
// by hand or automatically by a security rule.
export const ipBlocks = pgTable("ip_blocks", {
  id: uuid("id").primaryKey().defaultRandom(),
  // An IP or CIDR.
  ip: text("ip").notNull(),
  reason: text("reason"),
  // Null = until removed by hand.
  until: timestamp("until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// IPs a user has signed in from (and confirmed, when new-IP confirmation
// is on).
export const trustedIps = pgTable("trusted_ips", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ip: text("ip").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("trusted_ips_user_ip_idx").on(t.userId, t.ip)]);

// Passkeys / security keys (WebAuthn) — an alternative second step to the
// authenticator code. TOTP stays enrolled as the fallback, so two-factor is
// never weaker than before.
export const webauthnCredentials = pgTable("webauthn_credentials", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // base64url credential ID and COSE public key, as the authenticator sent them.
  credentialId: text("credential_id").notNull().unique(),
  publicKey: text("public_key").notNull(),
  counter: integer("counter").notNull().default(0),
  transports: jsonb("transports").$type<string[]>().notNull().default([]),
  name: text("name").notNull(),
  // "multiDevice" = a synced passkey (phone/password manager); "singleDevice"
  // = bound to one authenticator (a YubiKey).
  deviceType: text("device_type"),
  backedUp: boolean("backed_up").notNull().default(false),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A password that was right but still needs a second step (TOTP code and/or
// an emailed new-IP code) before a session is issued.
export const loginChallenges = pgTable("login_challenges", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  ip: text("ip"),
  needsTotp: boolean("needs_totp").notNull().default(false),
  // Set while a user without 2FA is enrolling (2FA is mandatory): the
  // secret becomes theirs once a code from it verifies.
  enrollSecret: text("enroll_secret"),
  // A WebAuthn challenge issued for this sign-in (passkey as the second
  // step) or for adding a passkey while signed in.
  webauthnChallenge: text("webauthn_challenge"),
  emailCodeHash: text("email_code_hash"),
  attempts: integer("attempts").notNull().default(0),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A physical place (home, office, church) that groups one or more sites
// (networks). Endpoints and checks inherit their site's location, so a
// location never needs to be set twice.
export const locations = pgTable("locations", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  address: text("address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A site: one network (a homelab LAN, a church/AV network, a branch office).
// It exists from v1 even with only one row configured, so a second network
// later is a row, not a schema migration — see spec.md. (Named "endpoints"
// from 2.1 to 4.x; renamed back to "sites" in 5.0, when "endpoint" took over
// the meaning of a single device.)
export const sites = pgTable("sites", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  // The endpoint (running the agent) that collects for this site: it runs
  // the site's network checks (SNMP, ping, …), receives its syslog/traps/
  // flows, and runs its discovery and Wake-on-LAN — all posted back over
  // outbound HTTPS, so a remote site needs no inbound ports. Null = the
  // engine itself does it (the engine's own LAN). AnyPgColumn lets this
  // reference a table defined further down the file.
  collectorEndpointId: uuid("collector_endpoint_id").references((): AnyPgColumn => endpoints.id, { onDelete: "set null" }),
  // The site's public IPs, for devices that push syslog/traps/flows straight
  // to the engine over the internet instead of via a collector: accepted by
  // the receivers and attributed to this site.
  publicIps: jsonb("public_ips").$type<string[]>().notNull().default([]),
  locationId: uuid("location_id").references(() => locations.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// An endpoint: one monitored device (server, PC, switch, printer…), in one
// site. It may run the Looksee agent (agentApiKey set) and may be its site's
// collector. Not every check needs an endpoint (a plain URL uptime check
// doesn't correspond to a device you manage) — checks.endpointId is nullable
// for that reason. (Called "hosts" before 5.0.)
export const endpoints = pgTable("endpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hostname: text("hostname"),
  os: text("os"),
  // Bearer token the Go agent presents when reporting in. Null until an
  // agent is actually provisioned for this endpoint (agentless endpoints
  // never get one). Secret: never returned by the API.
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
  // endpoint, whether or not the update actually succeeds; the agentVersion
  // changing on a later report is the real confirmation signal.
  agentVersion: text("agent_version"),
  updateRequested: boolean("update_requested").notNull().default(false),
  // Set by the site collector this endpoint's agent runs, when it is one.
  collectorVersion: text("collector_version"),
  collectorLastSeenAt: timestamp("collector_last_seen_at", { withTimezone: true }),
  collectorError: text("collector_error"),
  // For Wake-on-LAN (POST /api/endpoints/:id/wake) and ARP presence checks.
  macAddress: text("mac_address"),
  // Hardware/OS inventory the 3.x agent sends when it changes (OS, kernel,
  // model, serial, CPU, RAM) — host_change checks diff against this.
  inventory: jsonb("inventory"),
  // The agent's most recent full metrics snapshot, so "what does this
  // endpoint look like right now" (endpoint page, suggested checks) is one
  // row read rather than a scan of endpoint_metrics.
  lastSnapshot: jsonb("last_snapshot"),
  // Full process and service inventory (pid/user/CPU/memory, service state
  // and start type), refreshed every few agent cycles — the endpoint page's
  // Processes/Services tabs and the check form's pickers read these.
  processInventory: jsonb("process_inventory"),
  serviceInventory: jsonb("service_inventory"),
  inventoryUpdatedAt: timestamp("inventory_updated_at", { withTimezone: true }),
  // File names in the agent's script_dir — the only scripts a custom
  // script check may run.
  availableScripts: jsonb("available_scripts").$type<string[]>(),
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
  // The site the check belongs to (always set) and, for device checks, the
  // endpoint it's about (null for site-level checks such as a URL).
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "cascade" }),
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
  // endpoint's agent instead, so it runs from inside that endpoint's network.
  probeEndpointId: uuid("probe_endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
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
  // Excluded from statistics by the admin afterwards (a false alarm, a
  // planned outage nobody put in maintenance): treated like a maintenance
  // result by uptime, SLA reports, status pages and charts. The result itself
  // is kept, with the reason.
  excluded: boolean("excluded").notNull().default(false),
  excludedReason: text("excluded_reason"),
  checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index("check_results_check_time_idx").on(t.checkId, t.checkedAt)]);

// Endpoint resource metrics reported by the Go agent on its own interval —
// separate from check_results because this is always-on telemetry for a
// host, not the pass/fail result of one configured check.
export const endpointMetrics = pgTable("endpoint_metrics", {
  id: uuid("id").primaryKey().defaultRandom(),
  endpointId: uuid("endpoint_id")
    .notNull()
    .references(() => endpoints.id, { onDelete: "cascade" }),
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
}, (t) => [index("endpoint_metrics_endpoint_time_idx").on(t.endpointId, t.recordedAt)]);

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
  // Per-event message templates ({ triggered: { title, body }, resolved,
  // reminder, escalated }); a missing event uses the channel type's default.
  // Not secret, so readable unlike config.
  templates: jsonb("templates").$type<Record<string, { title?: string; body?: string }>>().notNull().default({}),
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

// Which channels each alert rule notifies (a rule can notify many channels,
// and a channel can serve many rules).
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

// L1. Either a one-off window (startsAt..endsAt, two absolute instants) or a
// weekly recurrence (daysOfWeek + startTime + durationMinutes, read on the
// wall clock of timeZone — see services/maintenance.ts). scope "all" ignores
// targetIds; otherwise targetIds lists site, endpoint or check IDs (or group IDs).
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
  // IANA zone of the browser that saved a weekly window (e.g.
  // "America/Los_Angeles"), so "Sunday 02:00" means 02:00 there. Null for
  // windows saved before zones were recorded: they use the server's zone,
  // as they always did.
  timeZone: text("time_zone"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Where an inbound event came from.
export const eventSource = pgEnum("event_source", ["snmp_trap", "syslog"]);

// Inbound SNMP traps and syslog messages (H3/H5). trap_match/syslog_match
// checks count rows matching their filter over a window.
export const events = pgTable("events", {
  id: uuid("id").primaryKey().defaultRandom(),
  source: eventSource("source").notNull(),
  // The site the event came from: via its collector, or matched by public
  // IP for direct push. Null = received on the engine's own LAN.
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
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
  // The site the flow was exported from (null = the engine's own LAN).
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  exporter: text("exporter").notNull(),
  srcAddr: text("src_addr").notNull(),
  dstAddr: text("dst_addr").notNull(),
  protocol: integer("protocol"),
  dstPort: integer("dst_port"),
  bytes: bigint("bytes", { mode: "number" }).notNull(),
  packets: bigint("packets", { mode: "number" }).notNull(),
}, (t) => [index("flow_records_bucket_idx").on(t.bucket)]);

// Every IP a MAC address has been seen with, from agent reports, discovery
// scans and ARP checks — what ip_change checks and the endpoint page's address
// history read. One row per (mac, ip) pair, lastSeenAt bumped on each sighting.
export const macIpHistory = pgTable("mac_ip_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  mac: text("mac").notNull(),
  ip: text("ip").notNull(),
  endpointId: uuid("endpoint_id").references(() => endpoints.id, { onDelete: "set null" }),
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  source: text("source").notNull(),
  firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex("mac_ip_history_mac_ip_idx").on(t.mac, t.ip), index("mac_ip_history_endpoint_idx").on(t.endpointId)]);

// On-demand network discovery runs (Discovery page): which range was swept
// and what answered.
export const discoveryScans = pgTable("discovery_scans", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Scans of a site with a collector run there (status "queued" until the
  // collector picks them up); otherwise the engine runs them.
  siteId: uuid("site_id").references(() => sites.id, { onDelete: "cascade" }),
  cidr: text("cidr").notNull(),
  community: text("community"),
  status: text("status").notNull().default("running"),
  results: jsonb("results").notNull().default([]),
  error: text("error"),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
});

// One-off work for a site collector that isn't a recurring check: Wake-on-
// LAN packets (must be sent from the target's own LAN). Picked up on the
// collector's next config poll and marked done when it reports back.
export const collectorJobs = pgTable("collector_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => sites.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: jsonb("payload").notNull().default({}),
  status: text("status").notNull().default("queued"),
  result: text("result"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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

// Whether a backup_runs row records a backup or a restore, and how it ended.
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

// The kinds of widget a dashboard canvas can hold.
export const widgetType = pgEnum("widget_type", [
  "status_tile",
  "group_summary",
  "endpoint_metrics",
  "uptime_history",
  "note",
  "alert_history",
  "network_bandwidth",
  "all_endpoints",
  "backup_status",
  "clock",
  "section_header",
  "top_talkers",
  "status_summary",
]);

// Named dashboard canvases (the tabs on the home page).
export const dashboards = pgTable("dashboards", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // How often the dashboard page polls for fresh status/metrics while this
  // dashboard is active — was a hardcoded 15s constant, now per-dashboard.
  refreshSeconds: integer("refresh_seconds").notNull().default(15),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// A widget's `config` shape depends on `type` — { checkId } for status_tile,
// { siteId } for group_summary — same "fixed shape per type, not a generic
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

// Browsers/phones that asked for push notifications. endpoint is the push
// service URL for that device; p256dh and auth are the keys alerts are
// encrypted with, so only that device can read them.
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

// Severity of an engine log entry, lowest to highest.
// A group is a named set of locations, sites, endpoints and/or checks that
// cuts across the Location → Site → Endpoint hierarchy ("all printers",
// "Windows servers", "customer X"). "manual" groups list their members in
// group_members; "filter" groups are saved rules, evaluated live (see
// services/groups.ts), so new matching objects join automatically. Groups are
// targets for bulk actions, maintenance windows and exclusion lists.
export const groupKind = pgEnum("group_kind", ["manual", "filter"]);

// The rules of a filter group: every condition (match "all") or any of them
// (match "any") must hold. `field` and `op` are checked against the allowed
// lists in services/groups.ts before a group is saved.
export type GroupRules = {
  match: "all" | "any";
  conditions: { field: string; op: string; value: string }[];
};

export const groups = pgTable("groups", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  kind: groupKind("kind").notNull().default("manual"),
  // Filter groups only: which kind of object the rules select — "location",
  // "site", "endpoint" or "check". Null for manual groups (which can mix).
  target: text("target"),
  rules: jsonb("rules").$type<GroupRules>().notNull().default({ match: "all", conditions: [] }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Members of manual groups. One table for every kind of member, so
// memberId can't be a database foreign key; a member whose object was
// deleted is simply skipped when the group is resolved, and cleaned up then.
export const groupMembers = pgTable("group_members", {
  id: uuid("id").primaryKey().defaultRandom(),
  groupId: uuid("group_id")
    .notNull()
    .references(() => groups.id, { onDelete: "cascade" }),
  // "location", "site", "endpoint" or "check".
  memberType: text("member_type").notNull(),
  memberId: uuid("member_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // An object can be in a given group only once.
  uniqueIndex("group_members_unique_idx").on(t.groupId, t.memberType, t.memberId),
  // "Which groups is this endpoint in?" lookups.
  index("group_members_member_idx").on(t.memberType, t.memberId),
]);

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
