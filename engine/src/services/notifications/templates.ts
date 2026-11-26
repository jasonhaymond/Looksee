// Alert message templates. Every channel renders the same context through
// a per-event template (title + body); a channel can override any event's
// template from the Channels page, and anything it leaves blank falls back
// to the defaults below. Also formats the timestamp every alert carries
// (alertTime / withTime). Used by services/alerting.ts and security.ts.

import { own } from "../../lib/own.js";
import { isValidTimeZone, serverTimeZone } from "../../lib/timeZone.js";

/**
 * When something happened, as alerts show it: date, time and the zone's
 * abbreviation, e.g. "Tue, Nov 25, 2026, 1:42:44 AM CST". The zone is
 * ALERT_TIME_ZONE from the engine's .env (an IANA name such as
 * "America/Chicago") when it's set and valid, otherwise the server's own zone
 * — production servers often run on UTC, which is why the zone is always
 * printed: a time without one is ambiguous.
 *
 * @param at the moment to show (defaults to now)
 * @returns the formatted timestamp
 */
export function alertTime(at: Date = new Date()): string {
  const configured = process.env.ALERT_TIME_ZONE?.trim();
  const timeZone = configured && isValidTimeZone(configured) ? configured : serverTimeZone();
  return at.toLocaleString("en-US", { timeZone, weekday: "short", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short" });
}

/**
 * Makes sure an alert's text says when it happened. A template that already
 * shows the time (the defaults all do, via {{time}}) is left alone; a custom
 * template without it, or a message not built from a template (security
 * notifications), gets a "Time: …" line at the end. This is what guarantees
 * every alert, on every channel, carries a timestamp.
 *
 * @param body the rendered alert text
 * @param time the formatted time from alertTime()
 * @returns the body, with the time added if it was missing
 */
export function withTime(body: string, time: string): string {
  return body.includes(time) ? body : `${body.trimEnd()}\n\nTime: ${time}`;
}
export const ALERT_EVENTS = ["triggered", "resolved", "reminder", "escalated"] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number] | "test";
export type Template = { title?: string; body?: string };
export type Templates = Partial<Record<(typeof ALERT_EVENTS)[number], Template>>;

export type AlertContext = {
  event: AlertEvent;
  check: string;
  checkId: string;
  type: string;
  status: string;
  message: string;
  // The device the check belongs to (blank if none). `host` is the same
  // value under its pre-5.0 name, so older templates keep working.
  endpoint: string;
  host: string;
  // The network (site) the check belongs to.
  site: string;
  location: string;
  time: string;
  duration: string;
  remediation: string;
  url: string;
};

// What the template editor lists, in order, with what each one holds.
export const TEMPLATE_VARIABLES: { name: keyof AlertContext; help: string }[] = [
  { name: "check", help: "Check name" },
  { name: "status", help: "UP, DOWN, WARN or UNKNOWN" },
  { name: "message", help: "The check's latest result message" },
  { name: "event", help: "triggered, resolved, reminder, escalated or test" },
  { name: "endpoint", help: "Endpoint (device) the check belongs to (blank if none)" },
  { name: "site", help: "Site (network) the check belongs to" },
  { name: "location", help: "Location name (blank if none)" },
  { name: "type", help: "Check type, e.g. HTTP(S)" },
  { name: "time", help: "When it happened, with its time zone (ALERT_TIME_ZONE, or the server's zone). Added at the end if a template leaves it out" },
  { name: "duration", help: "How long the incident has been open" },
  { name: "remediation", help: "Suggested things to check, one per line" },
  { name: "url", help: "Link to the check in Looksee" },
];

export const DEFAULT_TEMPLATES: Required<Record<(typeof ALERT_EVENTS)[number], Required<Template>>> = {
  triggered: {
    title: "{{check}} is {{status}}",
    body: "{{check}} is {{status}}: {{message}}\nEndpoint: {{endpoint}} · Site: {{site}} · {{location}}\nTime: {{time}}\n\nThings to check:\n{{remediation}}\n\n{{url}}",
  },
  resolved: {
    title: "{{check}} recovered",
    body: "{{check}} has recovered (now {{status}}) after {{duration}}.\nEndpoint: {{endpoint}} · Site: {{site}}\nTime: {{time}}\n{{url}}",
  },
  reminder: {
    title: "Still failing: {{check}}",
    body: "{{check}} is still {{status}} ({{duration}}): {{message}}\nTime: {{time}}\n{{url}}",
  },
  escalated: {
    title: "ESCALATED: {{check}}",
    body: "{{check}} has been {{status}} for {{duration}} and was escalated: {{message}}\nTime: {{time}}\n\nThings to check:\n{{remediation}}\n\n{{url}}",
  },
};

/**
 * Fills a template's {{name}} placeholders from the alert's context. The
 * regex matches "{{", optional spaces, a word (letters, digits, _), optional
 * spaces and "}}" — e.g. "{{ check }}". Unknown names become empty text;
 * `own` reads only the context's own fields, so a template can't reach
 * JavaScript's built-in object properties (e.g. "{{constructor}}").
 *
 * @param template the title or body template
 * @param ctx the values to fill in
 * @returns the finished text, tidied (see below)
 */
export function render(template: string, ctx: Partial<AlertContext>): string {
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => String(own(ctx as Record<string, unknown>, name) ?? ""));
  // Tidy what an empty variable leaves behind: an "Endpoint: " with nothing after
  // it, and the " · " separators around it. A line that ends up empty this
  // way is dropped; deliberate blank lines are kept.
  const lines: string[] = [];
  // The regex /^[^:]{1,30}: +$/ matches a short label followed only by
  // spaces, e.g. "Endpoint: " — a label whose value came out empty.
  for (const line of out.split("\n")) {
    if (!line.includes(" · ") && !/^[^:]{1,30}: +$/.test(line)) {
      lines.push(line.trimEnd());
      continue;
    }
    const kept = line.split(" · ").filter((seg) => seg.trim() && !/^[^:]{1,30}: +$/.test(seg));
    if (kept.length) lines.push(kept.join(" · ").trimEnd());
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Renders one alert for one channel: the channel's own template for this
 * event where it has one, the default otherwise (a test send uses the
 * "triggered" template). The body always ends up with the alert's time in it
 * (withTime), even when a custom template leaves {{time}} out.
 *
 * @param templates the channel's saved overrides (may be empty)
 * @param ctx the alert's values
 * @returns the title and body to send
 */
export function renderFor(templates: Templates | null | undefined, ctx: AlertContext): { title: string; body: string } {
  const key = ctx.event === "test" ? "triggered" : ctx.event;
  const custom = own(templates, key) ?? {};
  const def = own(DEFAULT_TEMPLATES, key)!;
  return { title: render(custom.title || def.title, ctx), body: withTime(render(custom.body || def.body, ctx), ctx.time) };
}

/**
 * A length of time as alerts say it: "12 min", "5 h 3 min", "2 days 4 h".
 *
 * @param ms milliseconds (negative counts as zero)
 */
export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

/** Made-up alert values for the template editor's preview and test sends. */
export function sampleContext(): AlertContext {
  return {
    event: "test",
    check: "Example — office router ping",
    checkId: "00000000-0000-0000-0000-000000000000",
    type: "Ping",
    status: "DOWN",
    message: "100% packet loss (3 sent)",
    endpoint: "router",
    host: "router",
    site: "Home LAN",
    location: "Home",
    time: alertTime(),
    duration: "4 min",
    remediation: "• Is the device powered on and its network cable/link up?\n• Is ICMP (ping) allowed by its firewall?",
    url: `${dashboardUrl()}/manage`,
  };
}

/** The dashboard's public address for links in alerts (DASHBOARD_URL, then PUBLIC_URL), without a trailing slash. */
export function dashboardUrl(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_URL || "http://localhost:3100").replace(/\/+$/, "");
}
