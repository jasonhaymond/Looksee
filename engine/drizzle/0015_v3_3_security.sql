CREATE TABLE "ip_blocks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ip" text NOT NULL,
	"reason" text,
	"until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "login_challenges" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" text,
	"needs_totp" boolean DEFAULT false NOT NULL,
	"enroll_secret" text,
	"email_code_hash" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"severity" text DEFAULT 'info' NOT NULL,
	"ip" text,
	"user_agent" text,
	"path" text,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"kinds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"threshold" integer DEFAULT 5 NOT NULL,
	"window_minutes" integer DEFAULT 10 NOT NULL,
	"per_ip" boolean DEFAULT true NOT NULL,
	"notify" boolean DEFAULT true NOT NULL,
	"block_minutes" integer,
	"cooldown_minutes" integer DEFAULT 60 NOT NULL,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"allowlist_enabled" boolean DEFAULT false NOT NULL,
	"allowlist" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allowlist_agents" boolean DEFAULT false NOT NULL,
	"new_ip_confirmation" boolean DEFAULT false NOT NULL,
	"lockout_threshold" integer DEFAULT 5 NOT NULL,
	"lockout_minutes" integer DEFAULT 15 NOT NULL,
	"session_hours" integer DEFAULT 720 NOT NULL,
	"idle_timeout_minutes" integer,
	"min_password_length" integer DEFAULT 12 NOT NULL,
	"notify_email" text,
	"notify_channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"detect_scans" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trusted_ips" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ip" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "user_agent" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "last_seen_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_secret" text;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "totp_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "recovery_codes" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "password_changed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "login_challenges" ADD CONSTRAINT "login_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trusted_ips" ADD CONSTRAINT "trusted_ips_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_events_time_idx" ON "security_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "security_events_ip_idx" ON "security_events" USING btree ("ip","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "trusted_ips_user_ip_idx" ON "trusted_ips" USING btree ("user_id","ip");