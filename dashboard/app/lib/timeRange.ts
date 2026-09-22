// Shared time-range options for every history-backed widget (host metrics,
// uptime history, alert history). The chosen range is persisted per-widget
// as config.rangeHours, not globally, so two widgets on the same dashboard
// can show different windows.
export const RANGE_OPTIONS: { label: string; hours: number }[] = [
  { label: "1 hour", hours: 1 },
  { label: "6 hours", hours: 6 },
  { label: "24 hours", hours: 24 },
  { label: "3 days", hours: 72 },
  { label: "7 days", hours: 168 },
  { label: "30 days", hours: 720 },
];

export const DEFAULT_RANGE_HOURS = 24;

export function rangeToSince(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}
