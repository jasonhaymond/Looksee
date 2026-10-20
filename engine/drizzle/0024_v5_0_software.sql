-- Looksee 5.0: software reports from the agent (installed and upgradable
-- packages), four new check types (upgradable packages, software changed,
-- vulnerable/unsupported software, calculated value), and a cache for answers
-- from OSV.dev and endoflife.date. Additive: new enum values, two nullable
-- columns and a new table.
ALTER TYPE "public"."check_type" ADD VALUE 'calculated' BEFORE 'agent_service';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'host_vulnerable' BEFORE 'agent_service';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'host_packages';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'host_software';--> statement-breakpoint
CREATE TABLE "external_cache" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "software" jsonb;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "software_updated_at" timestamp with time zone;