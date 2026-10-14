-- Weekly maintenance windows remember the time zone of the browser that saved
-- them, so "Sunday 02:00" means 02:00 where the admin is rather than wherever
-- the server's clock is set. Additive and nullable: existing windows keep
-- NULL, which means "the server's zone" (what they always used).
ALTER TABLE "maintenance_windows" ADD COLUMN "time_zone" text;
