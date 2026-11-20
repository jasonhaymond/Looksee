// Small text formatters used across screens: relative times ("5 min ago"),
// durations, byte sizes and status labels.

/** "just now", "5 min ago", "3 h ago", "2 d ago", or "never" for no time. */
export function relativeTime(iso: string | number | null | undefined): string {
  if (iso == null) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return "—";
  const future = ms < 0;
  const s = Math.abs(ms) / 1000;
  const text = s < 45 ? "moments" : s < 3600 ? `${Math.round(s / 60)} min` : s < 86_400 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86_400)} d`;
  if (text === "moments") return future ? "in a moment" : "just now";
  return future ? `in ${text}` : `${text} ago`;
}

/** A date and time in the phone's own format and time zone. */
export const dateTime = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : "—");

/** Minutes as "45 min" or "2.5 h" or "3.1 d". */
export function minutes(m: number | null | undefined): string {
  if (m == null) return "—";
  if (m < 120) return `${Math.round(m)} min`;
  if (m < 2880) return `${(m / 60).toFixed(1)} h`;
  return `${(m / 1440).toFixed(1)} d`;
}

/** Bytes as KB/MB/GB/TB (1024-based, like the dashboard). */
export function bytes(n: number | null | undefined): string {
  if (n == null) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units.at(i)}`;
}

/** UP / WARN / DOWN / UNKNOWN for a status (never colour alone: the text says it). */
export const statusLabel = (s: string | null | undefined) => (s ? s.toUpperCase() : "NOT RUN");

/** Turns an error from a request into a sentence for the screen. */
export const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));
