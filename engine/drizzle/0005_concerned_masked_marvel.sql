ALTER TABLE "hosts" ADD COLUMN "agent_version" text;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "update_requested" boolean DEFAULT false NOT NULL;