-- Hand-written, not drizzle-kit generated: drizzle-kit's rename detection is
-- an interactive prompt with no non-interactive answer available in this
-- environment, and answering it wrong would silently emit DROP TABLE
-- "sites"; CREATE TABLE "endpoints" (...) instead of a real rename,
-- destroying every existing site/host/check relationship. Real RENAME
-- statements are non-destructive and preserve every row and FK — verified
-- against the local dev DB before this was trusted as safe to ship.
ALTER TABLE "sites" RENAME TO "endpoints";--> statement-breakpoint
ALTER TABLE "hosts" RENAME COLUMN "site_id" TO "endpoint_id";--> statement-breakpoint
ALTER TABLE "checks" RENAME COLUMN "site_id" TO "endpoint_id";--> statement-breakpoint
ALTER TABLE "hosts" RENAME CONSTRAINT "hosts_site_id_sites_id_fk" TO "hosts_endpoint_id_endpoints_id_fk";--> statement-breakpoint
ALTER TABLE "checks" RENAME CONSTRAINT "checks_site_id_sites_id_fk" TO "checks_endpoint_id_endpoints_id_fk";
