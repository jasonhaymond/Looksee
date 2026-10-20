// Converts timestamps that the engine writes *inside text* into the viewer's
// own time zone.
//
// Where this sits: the engine stores and sends every timestamp in UTC. Fields
// that are just a timestamp (createdAt, lastCheckedAt, ...) are already turned
// into local time by the page that shows them (`new Date(x).toLocaleString()`
// runs in the browser, so it uses the browser's time zone). But some check
// messages have a time baked into the sentence — "Endpoint rebooted at
// 2026-10-13 14:05 UTC", "Agent silent for 9 min (last report
// 2026-10-13T14:05:12.000Z)" — and a sentence can't be reformatted by the
// page. lib/api.ts runs every API response through `localizeResponse` below,
// which rewrites those embedded times before any page sees them. That also
// fixes messages stored before this change, since nothing in the database is
// touched.
//
// Security note: this only rewrites display text. It never changes check
// configuration or anything else the dashboard might send back to the engine
// (see DISPLAY_TEXT_KEYS), so it can't corrupt saved settings.

// Matches a full ISO-8601 timestamp with an explicit zone, e.g.
// "2026-10-13T14:05:12.000Z" or "2026-10-13T14:05+02:00". The zone is required:
// a time without one is ambiguous, so it's left alone rather than guessed at.
// Seconds (with or without a fraction) are optional: written as three
// alternatives rather than nested optional groups.
const ISO_WITH_ZONE = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}\.\d+|:\d{2}|)(?:Z|[+-]\d{2}:?\d{2})(?![\w:])/g;

// Matches the engine's human-readable UTC form, e.g. "2026-10-13 14:05 UTC" or
// "2026-10-13 14:05:30 UTC". Captures the date (1) and the time (2) so they can
// be rebuilt into an ISO string the browser can parse.
const SPACED_UTC = /\b(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}|\d{2}:\d{2}) UTC\b/g;

// Matches a string that is *nothing but* an ISO timestamp, e.g. a details
// table cell holding "2026-10-13T14:05:12.000Z".
const BARE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}\.\d+|:\d{2}|)(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * Formats one instant in the viewer's time zone and locale, e.g.
 * "Oct 13, 2026, 7:05 AM". `undefined` as the locale means "the browser's".
 *
 * @param d the instant to show
 * @returns the formatted local date and time
 */
export function formatLocal(d: Date): string {
  return d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/**
 * Rewrites every UTC timestamp found inside a piece of text into local time.
 * Text with no timestamps comes back unchanged. A match that isn't a real
 * date (e.g. month 13) is left as written rather than shown as "Invalid Date".
 *
 * @param text a message such as "Up since 2026-10-13 14:05 UTC"
 * @returns the same text with each timestamp in the viewer's time zone
 */
export function localizeTimes(text: string): string {
  // Turns a parseable timestamp string into local text, or keeps the original.
  const swap = (original: string, iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? original : formatLocal(d);
  };
  return text
    .replace(ISO_WITH_ZONE, (m) => swap(m, m))
    // "2026-10-13 14:05 UTC" → parse as "2026-10-13T14:05Z".
    .replace(SPACED_UTC, (m, date: string, time: string) => swap(m, `${date}T${time}Z`));
}

// Response fields that hold human-readable sentences, which may contain a
// time. Only these are rewritten (plus anything under `details`, below), so
// configuration values and names are never altered.
const DISPLAY_TEXT_KEYS = new Set(["message", "lastMessage", "reason", "lastResult", "lastError", "collectorError", "detail"]);

// Subtrees that are edited in a form and saved back (a check's or channel's
// settings, a check's remembered state) are never walked, even if a future
// setting happens to be called "message" — rewriting one would silently
// change what gets saved.
const EDITABLE_KEYS = new Set(["config", "state"]);

/**
 * Deep-localizes a check result's `details` (interface tables, matched log
 * lines, IP history, ...). Details are only ever displayed, never sent back
 * to the engine, so every string in them is fair game — including strings
 * that are just a timestamp, which the details table would otherwise show raw.
 *
 * @param value any JSON value from a `details` field
 * @returns a copy with every timestamp string shown in local time
 */
function localizeDetails(value: unknown): unknown {
  if (typeof value === "string") return BARE_ISO.test(value) ? formatLocal(new Date(value)) : localizeTimes(value);
  if (Array.isArray(value)) return value.map(localizeDetails);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, localizeDetails(v)]));
  }
  return value;
}

/**
 * Walks a whole API response and localizes the display-only text in it (see
 * the file header). Plain timestamp fields like `createdAt` are deliberately
 * left as ISO strings: pages parse those with `new Date(...)` to sort, chart
 * and format them, which a pre-formatted string would break.
 *
 * @param value the parsed JSON body of an API response
 * @returns a copy with embedded times converted; other values are untouched
 */
export function localizeResponse<T>(value: T): T {
  // Recursive helper; `key` is the property name the value was found under.
  const walk = (v: unknown, key: string | null): unknown => {
    if (key && EDITABLE_KEYS.has(key)) return v;
    if (key === "details") return localizeDetails(v);
    if (typeof v === "string") return key && DISPLAY_TEXT_KEYS.has(key) ? localizeTimes(v) : v;
    if (Array.isArray(v)) return v.map((item) => walk(item, null));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, child]) => [k, walk(child, k)]));
    return v;
  };
  return walk(value, null) as T;
}

/**
 * The viewer's IANA time zone name, e.g. "America/Los_Angeles". The engine
 * uses it for anything it has to work out on a calendar — which day a status
 * page result belongs to, or when a weekly maintenance window starts.
 *
 * @returns the browser's time zone, or "UTC" if the browser won't say
 */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
