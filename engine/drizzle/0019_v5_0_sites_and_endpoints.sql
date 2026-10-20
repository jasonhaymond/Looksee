-- Looksee 5.0: Location → Site → Endpoint.
--
-- What changes: the network-level object called "endpoint" since 2.1 becomes
-- a "site", and the device-level object called "host" becomes an "endpoint".
-- Tables, columns, constraints, indexes, enum values and the few JSON keys
-- that store these names are all renamed to match.
--
-- Safety: every statement is a rename or an in-place value rewrite — no
-- column, row or table is dropped, so no data is lost. But it is not
-- backward compatible: 4.x code expects the old names, so rolling back to
-- 4.x after this migration requires restoring the database snapshot that
-- scripts/update.sh takes before every update (it discards data recorded
-- since). Drizzle runs the whole file in one transaction: it either applies
-- completely or not at all.
--
-- Order matters: the old "endpoints" table and every *_endpoint_id column are
-- renamed to site names FIRST, which frees the "endpoint" names for the old
-- host table and *_host_id columns.

-- 1. Tables.
ALTER TABLE "endpoints" RENAME TO "sites";--> statement-breakpoint
ALTER TABLE "hosts" RENAME TO "endpoints";--> statement-breakpoint
ALTER TABLE "host_metrics" RENAME TO "endpoint_metrics";--> statement-breakpoint

-- 2. Columns that point at the network level become site_id ...
ALTER TABLE "checks" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint
ALTER TABLE "endpoints" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint
ALTER TABLE "mac_ip_history" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint
ALTER TABLE "events" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint
ALTER TABLE "flow_records" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint
ALTER TABLE "discovery_scans" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint
ALTER TABLE "collector_jobs" RENAME COLUMN "endpoint_id" TO "site_id";--> statement-breakpoint

-- ... and columns that point at a device become endpoint ids.
ALTER TABLE "checks" RENAME COLUMN "host_id" TO "endpoint_id";--> statement-breakpoint
ALTER TABLE "checks" RENAME COLUMN "probe_host_id" TO "probe_endpoint_id";--> statement-breakpoint
ALTER TABLE "sites" RENAME COLUMN "collector_host_id" TO "collector_endpoint_id";--> statement-breakpoint
ALTER TABLE "endpoint_metrics" RENAME COLUMN "host_id" TO "endpoint_id";--> statement-breakpoint
ALTER TABLE "mac_ip_history" RENAME COLUMN "host_id" TO "endpoint_id";--> statement-breakpoint

-- 3. Constraint names, so they match what the Drizzle schema expects
-- (<table>_<column>_<referenced table>_<referenced column>_fk). A rename is
-- skipped if the old name isn't there, so a database whose names differ
-- slightly can't make the migration fail; site renames come before endpoint
-- renames for the same reason as above. ($$ ... $$ is a block of PL/pgSQL,
-- Postgres's procedural language.)
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    -- table,             old name,                                   new name
    ('checks',            'checks_endpoint_id_endpoints_id_fk',        'checks_site_id_sites_id_fk'),
    ('collector_jobs',    'collector_jobs_endpoint_id_endpoints_id_fk', 'collector_jobs_site_id_sites_id_fk'),
    ('discovery_scans',   'discovery_scans_endpoint_id_endpoints_id_fk', 'discovery_scans_site_id_sites_id_fk'),
    ('events',            'events_endpoint_id_endpoints_id_fk',        'events_site_id_sites_id_fk'),
    ('flow_records',      'flow_records_endpoint_id_endpoints_id_fk',  'flow_records_site_id_sites_id_fk'),
    ('mac_ip_history',    'mac_ip_history_endpoint_id_endpoints_id_fk', 'mac_ip_history_site_id_sites_id_fk'),
    ('sites',             'endpoints_location_id_locations_id_fk',     'sites_location_id_locations_id_fk'),
    ('sites',             'endpoints_pkey',                            'sites_pkey'),
    ('endpoints',         'hosts_endpoint_id_endpoints_id_fk',         'endpoints_site_id_sites_id_fk'),
    ('checks',            'checks_host_id_hosts_id_fk',                'checks_endpoint_id_endpoints_id_fk'),
    ('checks',            'checks_probe_host_id_hosts_id_fk',          'checks_probe_endpoint_id_endpoints_id_fk'),
    ('sites',             'endpoints_collector_host_id_hosts_id_fk',   'sites_collector_endpoint_id_endpoints_id_fk'),
    ('endpoint_metrics',  'host_metrics_host_id_hosts_id_fk',          'endpoint_metrics_endpoint_id_endpoints_id_fk'),
    ('mac_ip_history',    'mac_ip_history_host_id_hosts_id_fk',        'mac_ip_history_endpoint_id_endpoints_id_fk'),
    ('endpoints',         'hosts_pkey',                                'endpoints_pkey'),
    ('endpoints',         'hosts_agent_api_key_unique',                'endpoints_agent_api_key_unique'),
    ('endpoint_metrics',  'host_metrics_pkey',                         'endpoint_metrics_pkey')
  ) AS t(tbl, old_name, new_name)
  LOOP
    IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = r.old_name AND conrelid = r.tbl::regclass) THEN
      EXECUTE format('ALTER TABLE %I RENAME CONSTRAINT %I TO %I', r.tbl, r.old_name, r.new_name);
    END IF;
  END LOOP;
END $$;--> statement-breakpoint

-- 4. Plain indexes.
ALTER INDEX IF EXISTS "host_metrics_host_time_idx" RENAME TO "endpoint_metrics_endpoint_time_idx";--> statement-breakpoint
ALTER INDEX IF EXISTS "mac_ip_history_host_idx" RENAME TO "mac_ip_history_endpoint_idx";--> statement-breakpoint

-- 5. Dashboard widget types (an enum: a column type that only accepts
-- listed words). Existing widgets keep working; only the word changes.
ALTER TYPE "public"."widget_type" RENAME VALUE 'host_metrics' TO 'endpoint_metrics';--> statement-breakpoint
ALTER TYPE "public"."widget_type" RENAME VALUE 'all_hosts' TO 'all_endpoints';--> statement-breakpoint

-- 6. Stored values that name the levels.
-- Maintenance windows limited to "endpoint" (old network level) now say
-- "site"; ones limited to "host" now say "endpoint". One CASE does both, so
-- a value is never renamed twice.
UPDATE "maintenance_windows"
SET "scope" = CASE "scope" WHEN 'endpoint' THEN 'site' WHEN 'host' THEN 'endpoint' END
WHERE "scope" IN ('endpoint', 'host');--> statement-breakpoint

-- Widget settings: { "endpointId": … } → { "siteId": … } and
-- { "hostId": … } → { "endpointId": … }. `-` removes a key from a JSON
-- object, `||` merges two objects, and jsonb_strip_nulls drops whichever
-- new key had no old value.
UPDATE "dashboard_widgets"
SET "config" = ("config" - 'endpointId' - 'hostId')
  || jsonb_strip_nulls(jsonb_build_object('siteId', "config" -> 'endpointId', 'endpointId', "config" -> 'hostId'))
WHERE "config" ? 'endpointId' OR "config" ? 'hostId';--> statement-breakpoint

-- Discovery results: each found device's "knownHostId" (the endpoint it
-- matched) becomes "knownEndpointId". jsonb_array_elements walks the list and
-- jsonb_agg rebuilds it in the same order (WITH ORDINALITY keeps the order).
UPDATE "discovery_scans"
SET "results" = (
  SELECT jsonb_agg(("item" - 'knownHostId') || jsonb_build_object('knownEndpointId', "item" -> 'knownHostId') ORDER BY "pos")
  FROM jsonb_array_elements("results") WITH ORDINALITY AS e("item", "pos")
)
WHERE jsonb_typeof("results") = 'array' AND jsonb_array_length("results") > 0;
--> statement-breakpoint

-- Notification message templates written by the admin use {{endpoint}} for
-- the network and {{host}} for the device. Rewrite them to the 5.0 names —
-- {{site}} and {{endpoint}} — in that order (sites first), so a template's
-- {{endpoint}} isn't turned into a site after already being renamed. The
-- labels around them (e.g. "Host: ") are the admin's own text and are left
-- as written.
UPDATE "notification_channels"
SET "templates" = replace(replace("templates"::text, '{{endpoint}}', '{{site}}'), '{{host}}', '{{endpoint}}')::jsonb
WHERE "templates"::text LIKE '%{{endpoint}}%' OR "templates"::text LIKE '%{{host}}%';
