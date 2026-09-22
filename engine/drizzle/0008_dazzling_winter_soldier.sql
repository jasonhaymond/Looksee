ALTER TYPE "public"."check_type" ADD VALUE 'host_cpu';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'host_memory';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'host_disk';--> statement-breakpoint
ALTER TYPE "public"."check_type" ADD VALUE 'snmp';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'alert_history';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'network_bandwidth';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'all_hosts';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'backup_status';--> statement-breakpoint
ALTER TYPE "public"."widget_type" ADD VALUE 'clock';