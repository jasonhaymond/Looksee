-- Looksee 5.1: agent diagnostics on each endpoint — when its agent last fetched
-- its config, why its last report could not be stored (and when), and the
-- address its last authenticated request came from. Shown on the endpoint
-- page; see the endpoints table comments in src/db/schema.ts. Additive:
-- four nullable columns, nothing existing changes, safe on a live database.
ALTER TABLE "endpoints" ADD COLUMN "last_config_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "last_report_error" text;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "last_report_error_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "last_agent_ip" text;