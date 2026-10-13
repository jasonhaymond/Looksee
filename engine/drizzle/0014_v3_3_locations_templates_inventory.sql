ALTER TYPE "public"."channel_type" ADD VALUE 'telegram';--> statement-breakpoint
ALTER TYPE "public"."channel_type" ADD VALUE 'slack';--> statement-breakpoint
ALTER TYPE "public"."channel_type" ADD VALUE 'teams';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'ip_change' BEFORE 'agent_service';--> statement-breakpoint
CREATE TABLE "locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mac_ip_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mac" text NOT NULL,
	"ip" text NOT NULL,
	"host_id" uuid,
	"endpoint_id" uuid,
	"source" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "endpoints" ADD COLUMN "location_id" uuid;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "process_inventory" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "service_inventory" jsonb;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "inventory_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "hosts" ADD COLUMN "available_scripts" jsonb;--> statement-breakpoint
ALTER TABLE "notification_channels" ADD COLUMN "templates" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "mac_ip_history" ADD CONSTRAINT "mac_ip_history_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mac_ip_history" ADD CONSTRAINT "mac_ip_history_endpoint_id_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."endpoints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "mac_ip_history_mac_ip_idx" ON "mac_ip_history" USING btree ("mac","ip");--> statement-breakpoint
CREATE INDEX "mac_ip_history_host_idx" ON "mac_ip_history" USING btree ("host_id");--> statement-breakpoint
ALTER TABLE "endpoints" ADD CONSTRAINT "endpoints_location_id_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."locations"("id") ON DELETE set null ON UPDATE no action;