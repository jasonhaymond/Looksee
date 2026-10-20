-- Looksee 5.0: groups — named sets of locations, sites, endpoints and checks,
-- either listed by hand (group_members) or selected by saved filter rules
-- (groups.rules). Additive only: two new tables and an enum; nothing existing
-- changes.
CREATE TYPE "public"."group_kind" AS ENUM('manual', 'filter');--> statement-breakpoint
CREATE TABLE "group_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"member_type" text NOT NULL,
	"member_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" "group_kind" DEFAULT 'manual' NOT NULL,
	"target" text,
	"rules" jsonb DEFAULT '{"match":"all","conditions":[]}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "group_members_unique_idx" ON "group_members" USING btree ("group_id","member_type","member_id");--> statement-breakpoint
CREATE INDEX "group_members_member_idx" ON "group_members" USING btree ("member_type","member_id");