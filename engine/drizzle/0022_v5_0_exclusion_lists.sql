-- Looksee 5.0: reusable exclusion lists (mount points, interfaces, message
-- texts, services, … that checks should ignore), applied to every check of a
-- matching type or to the checks of chosen groups. Additive: a new table only.
CREATE TABLE "exclusion_lists" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"items" text[] DEFAULT '{}' NOT NULL,
	"apply_to_all" boolean DEFAULT false NOT NULL,
	"group_ids" uuid[] DEFAULT '{}' NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
