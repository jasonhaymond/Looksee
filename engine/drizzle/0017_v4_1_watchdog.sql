CREATE TABLE "watchdog_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"url" text,
	"fail_url" text,
	"interval_seconds" integer DEFAULT 60 NOT NULL,
	"last_ping_at" timestamp with time zone,
	"last_result" text,
	"last_error" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
