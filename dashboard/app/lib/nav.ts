// The dashboard's page list for the left navigation (components/Sidebar.tsx).
//
// Grouped so ~20 pages stay findable: the group names say what you're trying
// to do, the items say where it lives. Adding a page = adding a line here.

/** One link: where it goes, its label, and an optional one-line hint. */
export type NavItem = { href: string; label: string; hint?: string };
/** A titled set of links. */
export type NavGroup = { label: string; items: NavItem[] };

export const NAV: NavGroup[] = [
  {
    label: "Overview",
    items: [{ href: "/", label: "Dashboards", hint: "Your widget canvases" }],
  },
  {
    label: "Monitoring",
    items: [
      { href: "/manage", label: "Checks", hint: "Everything being monitored" },
      { href: "/endpoints", label: "Endpoints", hint: "Devices: servers, PCs, switches, printers" },
      { href: "/sites", label: "Sites & locations", hint: "Networks, grouped by place" },
      { href: "/groups", label: "Groups", hint: "Your own sets, by hand or by filter" },
      { href: "/discovery", label: "Discovery", hint: "Scan a subnet for devices" },
    ],
  },
  {
    label: "Alerting",
    items: [
      { href: "/alerts", label: "Alert history", hint: "Every incident, open and resolved" },
      { href: "/channels", label: "Channels", hint: "Email, push, Slack, Teams, Telegram…" },
      { href: "/maintenance", label: "Maintenance", hint: "Silence alerts on a schedule" },
    ],
  },
  {
    label: "Insights",
    items: [
      { href: "/reports", label: "SLA reports", hint: "Uptime over 7–365 days" },
      { href: "/events", label: "Traps & syslog", hint: "Received events" },
      { href: "/flows", label: "Top talkers", hint: "NetFlow / sFlow" },
      { href: "/status-pages", label: "Status pages", hint: "Public status pages" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/security", label: "Security", hint: "Sign-in, 2FA, IP allowlist, attacks" },
      { href: "/watchdog", label: "Watchdog", hint: "Get told if Looksee itself goes down" },
      { href: "/backups", label: "Backups" },
      { href: "/logs", label: "Logs" },
      { href: "/help", label: "Help & user guide" },
    ],
  },
];
