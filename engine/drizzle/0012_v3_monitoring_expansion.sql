CREATE TYPE "public"."event_source" AS ENUM('snmp_trap', 'syslog');--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'top_talkers';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'status_summary';--> statement-breakpoint
CREATE TABLE "check_dependencies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"check_id" uuid NOT NULL,
	"depends_on_check_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discovery_scans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cidr" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source" "event_source" NOT NULL,
	"source_ip" text NOT NULL,
	"severity" integer,
	"facility" integer,
	"message" text NOT NULL,
	"data" jsonb,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "flow_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"exporter" text NOT NULL,
	"src_addr" text NOT NULL,
	"dst_addr" text NOT NULL,
	"protocol" integer,
	"dst_port" integer,
	"bytes" bigint NOT NULL,
	"packets" bigint NOT NULL
);
--> statement-breakpoint
CREATE TABLE "maintenance_windows" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scope" text DEFAULT 'all' NOT NULL,
	"target_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"days_of_week" jsonb,
	"start_time" text,
	"duration_minutes" integer,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "status_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"check_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"published" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "status_pages_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'udp';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'protocol';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'email_roundtrip';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'database';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'traceroute';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'browser';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'ntp';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'dhcp';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'grpc';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'mqtt';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'websocket';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'docker_registry';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'arp_presence';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'domain_expiry';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'public_ip';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'snmp_interfaces';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'trap_match';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'syslog_match';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'bmc';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'proxmox';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'vmware';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'prometheus';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'webserver_status';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'app_integration';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'anomaly';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'heartbeat';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'push_value';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_heartbeat';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'disk_forecast';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_file';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_log';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_eventlog';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_journal';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_script';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_scheduled_task';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_services_overview';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_docker';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_hyperv';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_perfcounter';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_vpn';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_ups';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'agent_backup';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'host_metric';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'host_reboot';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE IF NOT EXISTS 'host_change';--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "severity" text DEFAULT 'down' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "message" text;--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "last_notified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_events" ADD COLUMN "escalated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "alert_rule_channels" ADD COLUMN "escalation" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "trigger_on" text DEFAULT 'down' NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "renotify_minutes" integer;--> statement-breakpoint
ALTER TABLE "alert_rules" ADD COLUMN "escalate_after_minutes" integer;--> statement-breakpoint
ALTER TABLE "check_results" ADD COLUMN "value" double precision;--> statement-breakpoint
ALTER TABLE "check_results" ADD COLUMN "details" jsonb;--> statement-breakpoint
ALTER TABLE "check_results" ADD COLUMN "in_maintenance" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "retry_interval_seconds" integer;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "probe_host_id" uuid;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "push_token" text;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "state" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_status" "check_status";--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_message" text;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_value" double precision;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_latency_ms" integer;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "last_status_change_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checks" ADD COLUMN "flapping" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "host_metrics" ADD COLUMN "extended" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "mac_address" text;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "inventory" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "last_snapshot" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "check_dependencies" ADD CONSTRAINT "check_dependencies_check_id_checks_id_fk" FOREIGN KEY ("check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "check_dependencies" ADD CONSTRAINT "check_dependencies_depends_on_check_id_checks_id_fk" FOREIGN KEY ("depends_on_check_id") REFERENCES "public"."checks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "events_received_idx" ON "events" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "flow_records_bucket_idx" ON "flow_records" USING btree ("bucket");--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_probe_host_id_hosts_id_fk" FOREIGN KEY ("probe_host_id") REFERENCES "public"."hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_events_rule_idx" ON "alert_events" USING btree ("alert_rule_id","triggered_at");--> statement-breakpoint
CREATE INDEX "check_results_check_time_idx" ON "check_results" USING btree ("check_id","checked_at");--> statement-breakpoint
CREATE INDEX "host_metrics_host_time_idx" ON "host_metrics" USING btree ("host_id","recorded_at");--> statement-breakpoint
ALTER TABLE "checks" ADD CONSTRAINT "checks_push_token_unique" UNIQUE("push_token");--> statement-breakpoint
-- Hand-written: the check_type change above was generated as a drop-and-
-- recreate of the enum (the value order in checkTypes.ts differs from the
-- old enum); plain ADD VALUEs keep every existing row's type untouched.
-- Backfill the denormalized last-result columns from each check's newest
-- result so list views show real status straight after the upgrade.
UPDATE "checks" c SET
  "last_status" = r."status",
  "last_message" = r."message",
  "last_latency_ms" = r."latency_ms",
  "last_checked_at" = r."checked_at"
FROM (
  SELECT DISTINCT ON ("check_id") "check_id", "status", "message", "latency_ms", "checked_at"
  FROM "check_results" ORDER BY "check_id", "checked_at" DESC
) r WHERE r."check_id" = c."id";
