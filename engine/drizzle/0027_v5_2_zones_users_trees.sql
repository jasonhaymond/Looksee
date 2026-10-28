-- Looksee 5.2: three new check types — a DNS zone history check (dns_zone),
-- local user accounts (agent_users) and the largest folders/files on a disk
-- (agent_disk_tree) — and each site's own address ranges (sites.networks),
-- used to file events from a collector that serves several sites under the
-- right one. Additive: new enum values and one column with a default (an
-- empty list), nothing existing changes, safe on a live database.
ALTER TYPE "public"."check_type" ADD VALUE 'dns_zone' BEFORE 'trap_match';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'agent_users' BEFORE 'host_cpu';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'agent_disk_tree' BEFORE 'host_cpu';--> statement-breakpoint
ALTER TABLE "sites" ADD COLUMN "networks" jsonb DEFAULT '[]'::jsonb NOT NULL;