ALTER TYPE "public"."widget_type" ADD VALUE 'host_metrics';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'uptime_history';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'note';--> statement-breakpoint
ALTER TABLE "dashboards" ADD COLUMN "refresh_seconds" integer DEFAULT 15 NOT NULL;