-- Hand-adjusted from what drizzle-kit generated: it saw "agent_process"
-- appended to the enum and wanted a plain ADD VALUE, but that would leave
-- every existing "agent_service" row (a process-list check, today's only
-- actual behavior) stuck under a name that no longer describes it. RENAME
-- VALUE instead retargets every existing row in one atomic step (no UPDATE
-- needed — enum values are stored by OID, not text, so this is instant),
-- then ADD VALUE re-establishes "agent_service" fresh for its new meaning
-- (a real OS-service-manager check). Unlike ADD VALUE, RENAME VALUE isn't
-- subject to Postgres's "new value can't be used in the same transaction"
-- rule, so both statements are safe together here.
ALTER TYPE "public"."check_type" RENAME VALUE 'agent_service' TO 'agent_process';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'agent_service';--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "available_processes" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "available_services" jsonb;