CREATE TYPE "public"."backup_run_kind" AS ENUM('backup', 'restore');--> statement-breakpoint
CREATE TYPE "public"."backup_run_status" AS ENUM('running', 'success', 'error');--> statement-breakpoint
CREATE TABLE "backup_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" "backup_run_kind" NOT NULL,
	"archive_name" text NOT NULL,
	"status" "backup_run_status" DEFAULT 'running' NOT NULL,
	"message" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "backup_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"repo_url" text,
	"passphrase" text,
	"schedule" text,
	"retention_count" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
