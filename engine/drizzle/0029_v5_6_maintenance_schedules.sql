-- Looksee 5.6: more ways to schedule a maintenance window. Adds a repeat type
-- (daily, weekly, monthly on a day, or monthly on a weekday such as "2nd Tuesday"),
-- "every N" days/weeks/months, and an optional date range a repeating window is
-- limited to. Additive: new nullable columns, plus repeat_every with a default of 1.
-- The last statement only labels existing weekly windows as "weekly" (the engine
-- already reads an unlabeled window with days of the week as weekly), so no
-- window's schedule changes.
ALTER TABLE "maintenance_windows" ADD COLUMN "recurrence" text;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "repeat_every" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "day_of_month" integer;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "week_of_month" integer;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "start_date" text;--> statement-breakpoint
ALTER TABLE "maintenance_windows" ADD COLUMN "end_date" text;--> statement-breakpoint
-- Label existing weekly windows (one-off windows have starts_at and are left alone).
UPDATE "maintenance_windows" SET "recurrence" = 'weekly' WHERE "recurrence" IS NULL AND "starts_at" IS NULL AND "days_of_week" IS NOT NULL;
