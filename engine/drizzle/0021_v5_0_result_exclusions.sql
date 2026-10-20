-- Looksee 5.0: results can be excluded from statistics after the fact (a false
-- alarm, an unplanned-but-expected outage). Additive: two new columns with
-- defaults; existing results stay counted.
ALTER TABLE "check_results" ADD COLUMN "excluded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "check_results" ADD COLUMN "excluded_reason" text;