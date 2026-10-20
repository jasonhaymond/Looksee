-- Looksee 5.0: watchdog agents. An endpoint's agent can alert by email and/or
-- chat on its own when it can't reach Looksee. Additive: two nullable columns.
ALTER TABLE "endpoints" ADD COLUMN "watchdog" jsonb;--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "watchdog_status" jsonb;