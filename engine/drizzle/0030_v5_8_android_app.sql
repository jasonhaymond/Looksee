-- Looksee 5.8: the Android app. Adds the phones registered to receive
-- notifications (app_devices: only a SHA-256 hash of each phone's notification
-- token is stored) and the per-phone queue of notifications (app_notifications),
-- so a phone that was offline gets what it missed when it reconnects. Phones
-- receive the existing "Notifications" channel type (web_push), so no new
-- channel type is needed. Additive: two new tables and one security rule;
-- nothing existing changes, so older engine code runs unchanged against it.
CREATE TABLE "app_devices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"token_hash" text NOT NULL,
	"app_version" text,
	"platform" text,
	"last_connected_at" timestamp with time zone,
	"last_ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "app_devices_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "app_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"device_id" uuid NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"status" text,
	"event" text,
	"check_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "app_devices" ADD CONSTRAINT "app_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app_notifications" ADD CONSTRAINT "app_notifications_device_id_app_devices_id_fk" FOREIGN KEY ("device_id") REFERENCES "public"."app_devices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "app_notifications_device_idx" ON "app_notifications" USING btree ("device_id","created_at");--> statement-breakpoint
-- A security rule for the new stream, for servers whose default rules were
-- created by an earlier version (new servers get it from DEFAULT_RULES in
-- services/security.ts): 10 connections with a wrong phone token from one
-- address in 10 minutes notifies and blocks that address for an hour.
INSERT INTO "security_rules" ("name", "kinds", "threshold", "window_minutes", "per_ip", "notify", "block_minutes", "cooldown_minutes")
SELECT 'App token guessing', '["bad_app_token"]'::jsonb, 10, 10, true, true, 60, 60
WHERE EXISTS (SELECT 1 FROM "security_rules") AND NOT EXISTS (SELECT 1 FROM "security_rules" WHERE "name" = 'App token guessing');
