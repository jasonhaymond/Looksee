CREATE TABLE "collector_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "discovery_scans" ADD COLUMN "endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "discovery_scans" ADD COLUMN "community" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "collector_host_id" uuid;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "public_ips" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "events" ADD COLUMN "endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "flow_records" ADD COLUMN "endpoint_id" uuid;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "collector_version" text;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "collector_last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "collector_error" text;--> statement-breakpoint
ALTER TABLE "collector_jobs" ADD CONSTRAINT "collector_jobs_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "discovery_scans" ADD CONSTRAINT "discovery_scans_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_collector_host_id_hosts_id_fk" FOREIGN KEY ("collector_host_id") REFERENCES "public"."hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "events" ADD CONSTRAINT "events_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_records" ADD CONSTRAINT "flow_records_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;