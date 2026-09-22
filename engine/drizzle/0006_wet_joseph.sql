CREATE TABLE "smtp_settings" (
	"id" integer PRIMARY KEY NOT NULL,
	"host" text,
	"port" integer,
	"user" text,
	"password" text,
	"from" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
