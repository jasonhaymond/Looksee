-- dashboard_widgets.config is an app-managed jsonb blob, not a typed schema
-- column — migration 0010's table/column RENAME statements never touched
-- it, so any existing group_summary/alert_history widget's stored config
-- still had the key "siteId" after that migration, while the app (post-
-- rename) only ever reads "endpointId". Caught during real verification: an
-- existing dashboard widget showed "Endpoint not found" after the rename
-- even though its target endpoint still existed — the config key itself was
-- stale. This rewrites the key in place, preserving the value.
UPDATE "dashboard_widgets"
SET "config" = jsonb_set("config" - 'siteId', '{endpointId}', "config"->'siteId')
WHERE "config" ? 'siteId';
