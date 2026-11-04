-- Looksee 5.4: the RDP sessions check type, the Data retention page's settings, and
-- each endpoint's history of installed software. Also indexes the time column of
-- check results, endpoint metrics and logs, so that cleanups and early rollover
-- find the oldest rows without sorting a whole table when the disk is already low.
-- Additive: new tables, a nullable column and indexes; nothing existing changes. The
-- index builds briefly hold up writes to those tables on a large database.
ALTER TYPE "public"."check_type" ADD VALUE 'host_rdp_sessions';--> statement-breakpoint
CREATE TABLE "retention_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"days" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"rollover_enabled" boolean DEFAULT true NOT NULL,
	"min_free_mode" text DEFAULT 'gb' NOT NULL,
	"min_free_gb" double precision DEFAULT 3 NOT NULL,
	"min_free_percent" double precision DEFAULT 10 NOT NULL,
	"min_keep_hours" integer DEFAULT 24 NOT NULL,
	"storage_path" text,
	"last_rollover_at" timestamp with time zone,
	"last_rollover_message" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "software_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"endpoint_id" uuid NOT NULL,
	"action" text NOT NULL,
	"name" text NOT NULL,
	"source" text NOT NULL,
	"from_version" text,
	"to_version" text,
	"detected_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "software_held" jsonb;--> statement-breakpoint
ALTER TABLE "software_history" ADD CONSTRAINT "software_history_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "software_history_endpoint_time_idx" ON "software_history" USING btree ("endpoint_id","detected_at");--> statement-breakpoint
CREATE INDEX "software_history_time_idx" ON "software_history" USING btree ("detected_at");--> statement-breakpoint
CREATE INDEX "check_results_time_idx" ON "check_results" USING btree ("checked_at");--> statement-breakpoint
CREATE INDEX "endpoint_metrics_time_idx" ON "endpoint_metrics" USING btree ("recorded_at");--> statement-breakpoint
CREATE INDEX "logs_time_idx" ON "logs" USING btree ("created_at");