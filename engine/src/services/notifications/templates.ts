// Alert message templates. Every channel renders the same context through
// a per-event template (title + body); a channel can override any event's
// template from the Channels page, and anything it leaves blank falls back
// to the defaults below.

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
  host: string;
  endpoint: string;
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
  { name: "host", help: "Host the check belongs to (blank if none)" },
  { name: "endpoint", help: "Endpoint (network) name" },
  { name: "location", help: "Location name (blank if none)" },
  { name: "type", help: "Check type, e.g. HTTP(S)" },
  { name: "time", help: "When it happened (server time)" },
  { name: "duration", help: "How long the incident has been open" },
  { name: "remediation", help: "Suggested things to check, one per line" },
  { name: "url", help: "Link to the check in Looksee" },
];

export const DEFAULT_TEMPLATES: Required<Record<(typeof ALERT_EVENTS)[number], Required<Template>>> = {
  triggered: {
    title: "{{check}} is {{status}}",
    body: "{{check}} is {{status}}: {{message}}\nHost: {{host}} · Endpoint: {{endpoint}} · {{location}}\n{{time}}\n\nThings to check:\n{{remediation}}\n\n{{url}}",
  },
  resolved: {
    title: "{{check}} recovered",
    body: "{{check}} has recovered (now {{status}}) after {{duration}}.\nHost: {{host}} · Endpoint: {{endpoint}}\n{{url}}",
  },
  reminder: {
    title: "Still failing: {{check}}",
    body: "{{check}} is still {{status}} ({{duration}}): {{message}}\n{{url}}",
  },
  escalated: {
    title: "ESCALATED: {{check}}",
    body: "{{check}} has been {{status}} for {{duration}} and was escalated: {{message}}\n\nThings to check:\n{{remediation}}\n\n{{url}}",
  },
};

export function render(template: string, ctx: Partial<AlertContext>): string {
  const out = template.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => String((ctx as Record<string, unknown>)[name] ?? ""));
  // Tidy what an empty variable leaves behind: a "Host: " with nothing after
  // it, and the " · " separators around it. A line that ends up empty this
  // way is dropped; deliberate blank lines are kept.
  const lines: string[] = [];
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

export function renderFor(templates: Templates | null | undefined, ctx: AlertContext): { title: string; body: string } {
  const key = ctx.event === "test" ? "triggered" : ctx.event;
  const custom = templates?.[key] ?? {};
  const def = DEFAULT_TEMPLATES[key];
  return { title: render(custom.title || def.title, ctx), body: render(custom.body || def.body, ctx) };
}

export function formatDuration(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} days ${h % 24} h`;
}

export function sampleContext(): AlertContext {
  return {
    event: "test",
    check: "Example — office router ping",
    checkId: "00000000-0000-0000-0000-000000000000",
    type: "Ping",
    status: "DOWN",
    message: "100% packet loss (3 sent)",
    host: "router",
    endpoint: "Home LAN",
    location: "Home",
    time: new Date().toLocaleString(),
    duration: "4 min",
    remediation: "• Is the device powered on and its network cable/link up?\n• Is ICMP (ping) allowed by its firewall?",
    url: `${dashboardUrl()}/manage`,
  };
}

export function dashboardUrl(): string {
  return (process.env.DASHBOARD_URL || process.env.PUBLIC_URL || "http://localhost:3100").replace(/\/+$/, "");
}
