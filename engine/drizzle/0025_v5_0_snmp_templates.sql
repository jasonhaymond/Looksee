-- Looksee 5.0: custom SNMP templates (named sets of SNMP checks applied to
-- devices in one step). Additive: a new table only.
CREATE TABLE "snmp_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"match_sys_object_id" text,
	"items" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
