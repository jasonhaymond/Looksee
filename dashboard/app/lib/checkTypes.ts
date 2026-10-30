// Every check type's label, category, help text and form fields. The
// engine's own registry (engine/src/db/checkTypes.ts) decides who runs
// each type; this file describes how to configure it. Field keys must match
// what the engine probes (engine/src/services/probes) and the agent
// (agent/internal/checks) read out of checks.config.

import { own, setOwn } from "../lib/own";
export type FieldKind = "text" | "number" | "select" | "checkbox" | "textarea" | "secret" | "multi" | "metric" | "checkref";

export type Field = {
  key: string;
  label: string;
  kind: FieldKind;
  help?: string;
  placeholder?: string;
  required?: boolean;
  options?: { value: string; label: string }[];
  default?: unknown;
  // Where suggestions come from for a text field (agent-discovered names).
  suggest?: "services" | "processes" | "containers" | "mounts" | "interfaces" | "devices" | "scripts";
  showIf?: (config: Record<string, unknown>) => boolean;
  advanced?: boolean;
  wide?: boolean;
};

export type CheckTypeDef = {
  type: string;
  label: string;
  category: string;
  description: string;
  fields: Field[];
  // Show the value-threshold editor (warn/critical above/below) and what
  // the value means.
  value?: { unit: string; hint: string };
  latency?: boolean;
  needsEndpoint?: boolean;
  remoteProbe?: boolean;
  // An agent check another endpoint's agent may run on this endpoint's
  // behalf (the form's "Run by" choice; engine: otherAgent in its registry).
  otherAgent?: boolean;
  // The form's starting "check every" value for types too heavy to run
  // every minute (a zone transfer, a whole-disk walk). 60 s otherwise.
  defaultInterval?: number;
  // Hidden from the "add" picker (kept for existing checks).
  legacy?: boolean;
};

const opts = (...values: (string | [string, string])[]) => values.map((v) => (Array.isArray(v) ? { value: v[0], label: v[1] } : { value: v, label: v }));
const is = (key: string, ...values: string[]) => (c: Record<string, unknown>) => values.includes(String(own(c, key) ?? ""));
const not = (key: string, ...values: string[]) => (c: Record<string, unknown>) => !values.includes(String(own(c, key) ?? ""));

const insecure: Field = { key: "insecureSkipVerify", label: "Skip TLS certificate verification", kind: "checkbox", help: "For self-signed or internal certificates only — weakens security for anything public-facing.", advanced: true };
const timeout = (d: number): Field => ({ key: "timeoutSeconds", label: "Timeout (seconds)", kind: "number", default: d, advanced: true });
const host = (placeholder = "10.0.0.5"): Field => ({ key: "host", label: "Address", kind: "text", required: true, placeholder, help: "Hostname or IP address of what to check." });
const port = (placeholder: string, required = false): Field => ({ key: "port", label: "Port", kind: "number", placeholder, required });
const severity = (d = "down"): Field => ({ key: "severity", label: "Status when triggered", kind: "select", options: opts(["down", "Down (critical)"], ["warn", "Warn"]), default: d });
const holdMinutes: Field = { key: "holdMinutes", label: "Hold the alert status for (minutes)", kind: "number", default: 15, help: "One-time events stay failing this long so a normal 2-in-a-row alert rule still catches them.", advanced: true };
// The check's own exclusions (merged by the engine with any reusable lists
// from the Exclusions page). `names` items match whole names with * and ?
// wildcards; message texts match anywhere in the line.
const exclude = (what: string, example: string, names = true): Field => ({
  key: "exclude",
  label: `Exclude ${what}`,
  kind: "textarea",
  advanced: true,
  placeholder: example,
  help: `${names ? "One per line; whole names, case ignored, * matches anything." : "One per line; a line containing any of these texts (case ignored) is ignored."} Reusable lists for many checks: the Exclusions page.`,
});
const snmpAuth: Field[] = [
  { key: "version", label: "SNMP version", kind: "select", options: opts("1", "2c", "3"), default: "2c" },
  { key: "community", label: "Community", kind: "text", default: "public", showIf: not("version", "3") },
  { key: "username", label: "v3 username", kind: "text", showIf: is("version", "3") },
  { key: "securityLevel", label: "Security level", kind: "select", options: opts("noAuthNoPriv", "authNoPriv", "authPriv"), default: "authPriv", showIf: is("version", "3") },
  { key: "authProtocol", label: "Auth protocol", kind: "select", options: opts("md5", "sha", "sha224", "sha256", "sha384", "sha512"), default: "sha", showIf: is("version", "3") },
  { key: "authKey", label: "Auth key", kind: "secret", showIf: is("version", "3") },
  { key: "privProtocol", label: "Privacy protocol", kind: "select", options: opts("des", "aes", "aes256b", "aes256r"), default: "aes", showIf: is("version", "3") },
  { key: "privKey", label: "Privacy key", kind: "secret", showIf: is("version", "3") },
];

export const CATEGORIES = [
  "Reachability & web",
  "Network services",
  "Databases & apps",
  "Network devices & hardware",
  "Virtualization & containers",
  "Endpoint metrics (agent)",
  "Services & processes (agent)",
  "Files & logs (agent)",
  "OS & hardware (agent)",
  "Software & security (agent)",
  "Push & smart",
] as const;

export const CHECK_TYPES: CheckTypeDef[] = [
  // ---- Reachability & web ----
  {
    type: "ping",
    label: "Ping",
    category: "Reachability & web",
    description: "ICMP ping with packet loss, jitter and round-trip time.",
    remoteProbe: true,
    latency: true,
    fields: [
      host("8.8.8.8"),
      { key: "count", label: "Pings per check", kind: "number", default: 3 },
      { key: "lossWarnPercent", label: "Warn at loss %", kind: "number", placeholder: "20" },
      { key: "lossCriticalPercent", label: "Critical at loss %", kind: "number", placeholder: "50" },
      { key: "jitterWarnMs", label: "Warn at jitter (ms)", kind: "number", advanced: true },
      { key: "jitterCriticalMs", label: "Critical at jitter (ms)", kind: "number", advanced: true },
    ],
  },
  {
    type: "tcp",
    label: "TCP port",
    category: "Reachability & web",
    description: "Opens a TCP connection to host:port. Optionally sends text and checks the reply (a banner, or an answer to a simple command).",
    remoteProbe: true,
    latency: true,
    fields: [
      host(),
      port("5432", true),
      { ...timeout(5), help: "How long to wait for the connection (and the reply, when one is expected)." },
      { key: "sendText", label: "Send after connecting", kind: "text", placeholder: "PING\\r\\n", advanced: true, help: "Optional. Type \\r and \\n for line breaks." },
      { key: "expectText", label: "Reply must contain", kind: "text", placeholder: "+PONG", advanced: true, help: "Optional. Without it, connecting is enough. With it, the service must answer — catches a port that's open but hung." },
    ],
  },
  {
    type: "udp",
    label: "UDP port",
    category: "Reachability & web",
    description: "Sends a UDP payload and expects a reply (UDP has no handshake, so a reply is the only proof).",
    latency: true,
    fields: [
      host(),
      port("161", true),
      { key: "payload", label: "Payload", kind: "text", default: "ping" },
      { key: "payloadHex", label: "Payload is hex", kind: "checkbox" },
      { key: "expectContains", label: "Reply must contain", kind: "text" },
      timeout(5),
    ],
  },
  {
    type: "http",
    label: "HTTP(S)",
    category: "Reachability & web",
    description: "Requests a URL; checks status, body text/regex, JSON fields, redirects and response time.",
    remoteProbe: true,
    latency: true,
    value: { unit: "", hint: "the number at the JSON path, if it's numeric" },
    fields: [
      { key: "url", label: "URL", kind: "text", required: true, placeholder: "https://example.com/health", wide: true },
      { key: "method", label: "Method", kind: "select", options: opts("GET", "POST", "HEAD", "PUT", "DELETE", "OPTIONS"), default: "GET" },
      { key: "expectedStatus", label: "Expected status", kind: "text", placeholder: "200 or 200-299,301 or 2xx", help: "Blank accepts anything under 400." },
      { key: "bodyContains", label: "Body must contain", kind: "text" },
      { key: "bodyNotContains", label: "Body must NOT contain", kind: "text", placeholder: "error" },
      { key: "bodyRegex", label: "Body must match regex", kind: "text", advanced: true },
      { key: "jsonPath", label: "JSON path", kind: "text", placeholder: "$.status", advanced: true },
      { key: "jsonOperator", label: "JSON comparison", kind: "select", options: opts(["equals", "equals"], ["not_equals", "does not equal"], ["contains", "contains"], ["gt", "greater than"], ["lt", "less than"], ["exists", "exists"]), default: "equals", advanced: true, showIf: (c) => Boolean(c.jsonPath) },
      { key: "jsonExpected", label: "JSON expected value", kind: "text", advanced: true, showIf: (c) => Boolean(c.jsonPath) },
      { key: "headers", label: "Extra headers", kind: "textarea", placeholder: "Authorization: Bearer ...", help: "One \"Name: value\" per line.", advanced: true, wide: true },
      { key: "body", label: "Request body", kind: "textarea", advanced: true, wide: true, showIf: is("method", "POST", "PUT") },
      { key: "followRedirects", label: "Follow redirects", kind: "checkbox", default: true, advanced: true },
      { key: "expectedFinalUrl", label: "Must end at URL", kind: "text", advanced: true },
      { key: "maxRedirectsAllowed", label: "Warn above N redirects", kind: "number", advanced: true },
      timeout(10),
      insecure,
    ],
  },
  {
    type: "browser",
    label: "Real browser (headless Chrome)",
    category: "Reachability & web",
    description: "Loads the page in headless Chrome: checks it renders, waits for an element, catches JavaScript errors. Needs Chrome/Chromium on the engine host.",
    latency: true,
    value: { unit: " ms", hint: "page load time" },
    fields: [
      { key: "url", label: "URL", kind: "text", required: true, wide: true },
      { key: "waitForSelector", label: "Wait for element (CSS selector)", kind: "text", placeholder: "#app" },
      { key: "expectText", label: "Rendered text must contain", kind: "text" },
      { key: "failOnJsErrors", label: "Warn on JavaScript errors", kind: "checkbox", default: true },
      timeout(30),
      insecure,
    ],
  },
  {
    type: "dns",
    label: "DNS",
    category: "Reachability & web",
    description: "Resolves a name (any record type), optionally via a specific server, checks the answer and DNSSEC.",
    remoteProbe: true,
    latency: true,
    fields: [
      { key: "hostname", label: "Name to resolve", kind: "text", required: true, placeholder: "example.com" },
      { key: "recordType", label: "Record type", kind: "select", options: opts("A", "AAAA", "MX", "TXT", "CNAME", "NS", "SOA", "SRV", "PTR", "CAA"), default: "A" },
      { key: "server", label: "DNS server", kind: "text", placeholder: "system resolver", help: "e.g. 10.0.0.53 or 1.1.1.1:53" },
      { key: "expectedValue", label: "Answer must contain", kind: "text" },
      { key: "dnssec", label: "Require DNSSEC validation (AD flag)", kind: "checkbox", help: "Needs a validating resolver. Engine only — not available on remote agent probes." },
      { ...timeout(5), help: "How long to wait for each try." },
      { key: "tries", label: "Tries", kind: "number", default: 2, advanced: true, help: "How many times to ask before giving up (1–5)." },
    ],
  },
  {
    type: "dns_zone",
    label: "DNS zone history",
    category: "Reachability & web",
    description: "Takes an inventory of every record in a zone and keeps a history of what was added, removed or changed — by zone transfer (AXFR) or by reading a list of names.",
    latency: true,
    defaultInterval: 3600,
    value: { unit: "", hint: "records in the zone" },
    fields: [
      { key: "zone", label: "Zone", kind: "text", required: true, placeholder: "example.com" },
      { key: "mode", label: "Read the zone by", kind: "select", options: opts(["axfr", "Zone transfer (AXFR) — every record"], ["names", "Reading a list of names"]), default: "axfr", help: "A zone transfer sees everything, but the server must allow transfers to Looksee's address (or the site collector's). Reading names works with any server but only sees the names you list." },
      { key: "server", label: "DNS server", kind: "text", placeholder: "10.0.0.53 or ns1.example.com:53", help: "The zone's own (authoritative) server. Needed for a zone transfer; for a list of names, blank uses the system resolver." },
      { key: "names", label: "Names to read", kind: "textarea", required: true, placeholder: "@\nwww\nmail\n_dmarc\n_sip._tcp", help: "One per line, relative to the zone (@ is the zone itself) or ending with a dot for a full name. Each is read as A, AAAA, CNAME, MX, TXT, NS, SRV and CAA.", showIf: is("mode", "names") },
      { key: "tsigName", label: "TSIG key name", kind: "text", placeholder: "looksee-transfer", showIf: not("mode", "names"), advanced: true, help: "Optional: for servers that only allow signed transfers (BIND allow-transfer { key …; })." },
      { key: "tsigSecret", label: "TSIG secret (base64)", kind: "secret", showIf: not("mode", "names"), advanced: true },
      { key: "tsigAlgorithm", label: "TSIG algorithm", kind: "select", options: opts("hmac-sha256", "hmac-sha512", "hmac-sha1"), default: "hmac-sha256", showIf: not("mode", "names"), advanced: true },
      { ...severity("warn"), label: "Status when records change" },
      { ...holdMinutes, default: 60, help: "A change keeps the check failing this long, so an alert rule catches it." },
      { key: "ignoreNames", label: "Ignore names", kind: "textarea", placeholder: "_acme-challenge*\ndhcp-*", advanced: true, help: "One per line, relative to the zone; * matches anything. For records that change on their own — certificate challenges, DHCP-registered hosts." },
      { key: "watchTtl", label: "Also report TTL changes", kind: "checkbox", advanced: true },
      { key: "watchSoa", label: "Also report SOA changes", kind: "checkbox", advanced: true, help: "Off by default: the SOA serial changes with every edit, so it would repeat every other change." },
      { key: "maxRecords", label: "Most records", kind: "number", default: 5000, advanced: true, help: "A bigger zone fails with a clear message instead of being read." },
      { ...timeout(30), help: "How long the whole transfer (or each name) may take." },
    ],
  },
  {
    type: "ssl_cert",
    label: "TLS certificate",
    category: "Reachability & web",
    description: "Days to expiry, chain trust, hostname match, and whether TLS 1.0/1.1 is still accepted.",
    remoteProbe: true,
    value: { unit: " days", hint: "days until expiry" },
    fields: [
      host("example.com"),
      port("443"),
      { key: "warnDays", label: "Warn within (days)", kind: "number", default: 14 },
      { key: "criticalDays", label: "Critical within (days)", kind: "number", default: 3 },
      { key: "checkChain", label: "Require a trusted chain", kind: "checkbox", default: true },
      { key: "checkHostname", label: "Require hostname match", kind: "checkbox", default: true },
      { key: "checkWeakProtocols", label: "Warn if TLS 1.0/1.1 is accepted", kind: "checkbox", default: true },
      { key: "serverName", label: "Certificate name (SNI)", kind: "text", placeholder: "www.example.com", advanced: true, help: "The name to ask the server for and check the certificate against — for checking by IP address or one name behind a shared address. Blank = the host above." },
      { ...timeout(5), help: "How long to wait for the TLS connection." },
    ],
  },
  {
    type: "domain_expiry",
    label: "Domain registration expiry",
    category: "Reachability & web",
    description: "Reads the domain's expiry date from its registry over RDAP.",
    value: { unit: " days", hint: "days until the registration expires" },
    fields: [
      { key: "domain", label: "Domain", kind: "text", required: true, placeholder: "example.com" },
      { key: "warnDays", label: "Warn within (days)", kind: "number", default: 30 },
      { key: "criticalDays", label: "Critical within (days)", kind: "number", default: 7 },
      { key: "rdapServer", label: "RDAP server override", kind: "text", advanced: true },
    ],
  },
  {
    type: "websocket",
    label: "WebSocket",
    category: "Reachability & web",
    description: "Opens a ws:// or wss:// connection, optionally sends a message and waits for a reply.",
    latency: true,
    fields: [
      { key: "url", label: "URL", kind: "text", required: true, placeholder: "wss://example.com/socket", wide: true },
      { key: "send", label: "Send on connect", kind: "text" },
      { key: "expectContains", label: "Wait for a message containing", kind: "text" },
      timeout(10),
      insecure,
    ],
  },

  // ---- Network services ----
  {
    type: "protocol",
    label: "Mail / SSH / FTP / LDAP / RDP",
    category: "Network services",
    description: "Speaks just enough of the protocol to prove the service answers: SMTP (with STARTTLS), IMAP, POP3, FTP, SSH, LDAP bind, RDP.",
    latency: true,
    fields: [
      { key: "protocol", label: "Protocol", kind: "select", options: opts("smtp", "submission", "smtps", "imap", "imaps", "pop3", "pop3s", "ftp", "ftps", "ssh", "sftp", "ldap", "ldaps", "rdp"), default: "smtp" },
      host("mail.example.com"),
      port("protocol default"),
      { key: "requireStartTls", label: "Require STARTTLS", kind: "checkbox", showIf: is("protocol", "smtp", "submission", "imap") },
      { key: "bindDn", label: "Bind DN", kind: "text", placeholder: "anonymous", showIf: is("protocol", "ldap", "ldaps") },
      { key: "bindPassword", label: "Bind password", kind: "secret", showIf: is("protocol", "ldap", "ldaps") },
      { key: "expect", label: "Response must match (regex)", kind: "text", placeholder: "OpenSSH_9", advanced: true },
      timeout(8),
      insecure,
    ],
  },
  {
    type: "email_roundtrip",
    label: "Email round-trip",
    category: "Network services",
    description: "Sends a tagged message by SMTP and waits for it to arrive over IMAP — proves mail actually flows end to end.",
    value: { unit: " s", hint: "delivery time in seconds" },
    latency: true,
    fields: [
      { key: "smtpHost", label: "SMTP host", kind: "text", required: true },
      { key: "smtpPort", label: "SMTP port", kind: "number", default: 587 },
      { key: "smtpUser", label: "SMTP user", kind: "text" },
      { key: "smtpPassword", label: "SMTP password", kind: "secret" },
      { key: "from", label: "From", kind: "text" },
      { key: "to", label: "To (mailbox to watch)", kind: "text", required: true },
      { key: "imapHost", label: "IMAP host", kind: "text", required: true },
      { key: "imapPort", label: "IMAP port", kind: "number", default: 993 },
      { key: "imapUser", label: "IMAP user", kind: "text", placeholder: "same as To" },
      { key: "imapPassword", label: "IMAP password", kind: "secret" },
      { key: "mailbox", label: "Mailbox", kind: "text", default: "INBOX", advanced: true },
      { key: "deleteAfter", label: "Delete the test message", kind: "checkbox", default: true, advanced: true },
      timeout(120),
      insecure,
    ],
  },
  {
    type: "ntp",
    label: "NTP server",
    category: "Network services",
    description: "Queries an NTP server: is it synchronized (stratum) and how far off is its time.",
    value: { unit: " ms", hint: "absolute clock offset" },
    fields: [host("pool.ntp.org"), port("123"), { key: "offsetWarnMs", label: "Warn at offset (ms)", kind: "number", placeholder: "100" }, { key: "offsetCriticalMs", label: "Critical at offset (ms)", kind: "number", placeholder: "1000" }, { key: "maxStratum", label: "Max stratum", kind: "number", advanced: true }],
  },
  {
    type: "dhcp",
    label: "DHCP server",
    category: "Network services",
    description: "Broadcasts a DHCP DISCOVER and expects an offer (no lease is taken). Set the expected server to detect rogue DHCP. Needs the engine to bind UDP 68 — see the deployment guide.",
    latency: true,
    fields: [
      { key: "server", label: "Send to", kind: "text", placeholder: "255.255.255.255 (broadcast)" },
      { key: "expectedServer", label: "Expected server IP", kind: "text", help: "An offer from any other server is reported as a possible rogue DHCP server." },
      timeout(5),
    ],
  },
  { type: "grpc", label: "gRPC health", category: "Network services", description: "Calls the standard grpc.health.v1 Health/Check.", latency: true, fields: [host(), port("50051", true), { key: "service", label: "Service name", kind: "text", placeholder: "(whole server)" }, { key: "tls", label: "Use TLS", kind: "checkbox" }, insecure, timeout(8)] },
  {
    type: "mqtt",
    label: "MQTT broker",
    category: "Network services",
    description: "Connects to an MQTT broker and checks the CONNACK.",
    latency: true,
    fields: [host(), port("1883 / 8883"), { key: "tls", label: "Use TLS", kind: "checkbox" }, { key: "username", label: "Username", kind: "text" }, { key: "password", label: "Password", kind: "secret" }, insecure],
  },
  {
    type: "docker_registry",
    label: "Container registry",
    category: "Network services",
    description: "Checks a Docker/OCI registry answers, and optionally that an image tag exists.",
    fields: [
      { key: "url", label: "Registry URL", kind: "text", required: true, placeholder: "https://registry.example.com" },
      { key: "image", label: "Image", kind: "text", placeholder: "library/nginx" },
      { key: "tag", label: "Tag", kind: "text", default: "latest" },
      { key: "username", label: "Username", kind: "text", advanced: true },
      { key: "password", label: "Password / token", kind: "secret", advanced: true },
      insecure,
    ],
  },
  {
    type: "traceroute",
    label: "Traceroute / path change",
    category: "Network services",
    description: "Traces the route to a host and warns when the path changes or stops reaching it.",
    value: { unit: " hops", hint: "hop count" },
    fields: [host("1.1.1.1"), { key: "maxHops", label: "Max hops", kind: "number", default: 30, advanced: true }, { key: "expectedHop", label: "Path must pass through", kind: "text", placeholder: "10.0.0.1" }, { key: "requireReach", label: "Fail if the destination isn't reached", kind: "checkbox", default: true }, { key: "changeSeverity", label: "Status on path change", kind: "select", options: opts("warn", "down"), default: "warn" }],
  },
  {
    type: "public_ip",
    label: "Public IP change",
    category: "Network services",
    description: "Tracks the engine's public IP address and flags when it changes.",
    fields: [{ key: "url", label: "IP lookup URL", kind: "text", default: "https://api.ipify.org" }, { key: "expectedIp", label: "Expected IP", kind: "text", help: "Down whenever the IP isn't this one." }, { key: "changeSeverity", label: "Status on change", kind: "select", options: opts("warn", "down"), default: "warn" }, holdMinutes],
  },
  {
    type: "arp_presence",
    label: "Device present (ARP)",
    category: "Network services",
    description: "Is a device on the engine's own LAN segment? Works even for devices that ignore ping. Optionally verifies its MAC (spots IP conflicts and swapped hardware).",
    fields: [{ key: "ip", label: "IP address", kind: "text" }, { key: "mac", label: "MAC address", kind: "text", placeholder: "aa:bb:cc:dd:ee:ff" }],
  },
  {
    type: "ip_change",
    label: "IP address change (by MAC)",
    category: "Network services",
    description: "Flags when a device's MAC address shows up at a new IP — from agent reports, discovery scans and ARP checks. Catches DHCP lease changes that break checks targeting the old address.",
    value: { unit: "", hint: "IP changes in the last 24 hours" },
    fields: [
      { key: "mac", label: "MAC address", kind: "text", placeholder: "blank = the endpoint's own MAC(s)", help: "Leave blank and pick an endpoint to watch every MAC the agent reports for it." },
      severity("warn"),
      { ...holdMinutes, default: 60, help: "How long the check stays failing after a change, so an alert rule catches it." },
      { key: "includeIpv6", label: "Also watch IPv6 addresses", kind: "checkbox", advanced: true, help: "Off by default: IPv6 privacy addresses change by design." },
    ],
  },

  // ---- Databases & apps ----
  {
    type: "database",
    label: "Database",
    category: "Databases & apps",
    description: "Logs in to PostgreSQL, MySQL/MariaDB, SQL Server, Redis or MongoDB and checks it works — or reads connections, replication lag, size, or long-running queries.",
    latency: true,
    value: { unit: "", hint: "the selected metric" },
    fields: [
      { key: "engine", label: "Engine", kind: "select", options: opts(["postgres", "PostgreSQL"], ["mysql", "MySQL / MariaDB"], ["mssql", "SQL Server"], ["redis", "Redis"], ["mongodb", "MongoDB"]), default: "postgres" },
      host("db.lan"),
      port("engine default"),
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "secret" },
      { key: "database", label: "Database", kind: "text", showIf: not("engine", "redis") },
      {
        key: "metric",
        label: "What to check",
        kind: "select",
        options: opts(["connect", "Can connect and query"], ["query_value", "Value returned by a query"], ["connections_percent", "Connections (% of max)"], ["replication_lag_seconds", "Replication lag (s)"], ["database_size_mb", "Database size (MB)"], ["long_queries", "Long-running queries"], ["memory_mb", "Memory used (MB, Redis/Mongo)"]),
        default: "connect",
      },
      { key: "query", label: "Query", kind: "textarea", placeholder: "SELECT 1", showIf: is("metric", "connect", "query_value"), wide: true },
      { key: "longQuerySeconds", label: "Long = running longer than (s)", kind: "number", default: 60, showIf: is("metric", "long_queries") },
      { key: "tls", label: "Use TLS", kind: "checkbox", advanced: true },
      insecure,
      { key: "uri", label: "Connection URI (overrides the fields above)", kind: "secret", showIf: is("engine", "mongodb"), advanced: true },
    ],
  },
  {
    type: "prometheus",
    label: "Prometheus metric",
    category: "Databases & apps",
    description: "Scrapes any Prometheus /metrics site (node_exporter, cAdvisor, Caddy, Traefik, …) and puts thresholds on one metric.",
    value: { unit: "", hint: "the aggregated metric (per second if 'rate' is on)" },
    fields: [
      { key: "url", label: "Metrics URL", kind: "text", required: true, placeholder: "http://host:9100/metrics", wide: true },
      { key: "metric", label: "Metric name", kind: "text", required: true, placeholder: "node_filesystem_avail_bytes" },
      { key: "labels", label: "Label filter", kind: "text", placeholder: 'mountpoint="/", fstype!="tmpfs"' },
      { key: "aggregation", label: "Combine series by", kind: "select", options: opts("sum", "avg", "min", "max", "count"), default: "sum" },
      { key: "rate", label: "It's a counter — show per-second rate", kind: "checkbox" },
      { key: "bearerToken", label: "Bearer token", kind: "secret", advanced: true },
      { key: "headers", label: "Extra headers", kind: "textarea", advanced: true },
      insecure,
    ],
  },
  {
    type: "webserver_status",
    label: "Web server status page",
    category: "Databases & apps",
    description: "Reads nginx stub_status, Apache mod_status, or Caddy's metrics: connections, request rate, busy workers.",
    value: { unit: "", hint: "the selected metric" },
    fields: [
      { key: "kind", label: "Server", kind: "select", options: opts(["nginx", "nginx (stub_status)"], ["apache", "Apache (mod_status)"], ["caddy", "Caddy (metrics)"]), default: "nginx" },
      { key: "url", label: "Status URL", kind: "text", required: true, placeholder: "http://127.0.0.1/nginx_status", wide: true },
      {
        key: "metric",
        label: "Metric",
        kind: "select",
        options: opts(["requests_per_sec", "Requests / sec"], ["active_connections", "Active connections"], ["waiting", "Waiting (keep-alive) — nginx"], ["dropped_per_sec", "Dropped connections / sec — nginx"], ["busy_workers", "Busy workers — Apache"], ["busy_percent", "Busy workers % — Apache"], ["errors_per_sec", "Errors / sec — Caddy"]),
        default: "requests_per_sec",
      },
      insecure,
    ],
  },
  {
    type: "app_integration",
    label: "App integration",
    category: "Databases & apps",
    description: "First-party APIs of Nextcloud, Home Assistant, Plex, Jellyfin and Pi-hole, or any JSON API.",
    value: { unit: "", hint: "the selected metric" },
    fields: [
      { key: "app", label: "App", kind: "select", options: opts(["nextcloud", "Nextcloud"], ["home_assistant", "Home Assistant"], ["plex", "Plex"], ["jellyfin", "Jellyfin"], ["pihole", "Pi-hole"], ["custom_json", "Any JSON API"]), default: "nextcloud" },
      { key: "url", label: "Base URL", kind: "text", required: true, placeholder: "https://cloud.example.com", wide: true },
      { key: "token", label: "Token / password", kind: "secret", help: "Nextcloud: serverinfo NC-Token. Home Assistant: long-lived token. Plex: X-Plex-Token. Jellyfin: API key. Pi-hole: app password." },
      {
        key: "metric",
        label: "Metric",
        kind: "select",
        options: opts(["status", "Up / healthy"], ["free_space_gb", "Free space GB (Nextcloud)"], ["active_users", "Active users (Nextcloud)"], ["updates_available", "App updates (Nextcloud)"], ["active_streams", "Active streams (Plex/Jellyfin)"], ["percent_blocked", "% blocked (Pi-hole)"], ["queries_today", "Queries today (Pi-hole)"]),
        default: "status",
        showIf: not("app", "home_assistant", "custom_json"),
      },
      { key: "entityId", label: "Entity", kind: "text", placeholder: "sensor.outdoor_temp", showIf: is("app", "home_assistant") },
      { key: "expectedState", label: "Expected state", kind: "text", placeholder: "on", showIf: is("app", "home_assistant") },
      { key: "path", label: "Path", kind: "text", placeholder: "/api/health", showIf: is("app", "custom_json") },
      { key: "jsonPath", label: "JSON path", kind: "text", placeholder: "$.data.count", showIf: is("app", "custom_json") },
      insecure,
    ],
  },

  // ---- Network devices & hardware ----
  {
    type: "snmp",
    label: "SNMP value / template",
    category: "Network devices & hardware",
    description: "Reads one OID, a walked subtree, or a ready-made template (printer toner, UPS, CPU, storage, reboot detection, temperatures).",
    value: { unit: "", hint: "the value read (or computed by the template)" },
    fields: [
      host("10.0.0.20"),
      port("161"),
      ...snmpAuth,
      {
        key: "preset",
        label: "Template",
        kind: "select",
        options: opts(["", "Custom OID"], ["printer_supplies", "Printer: lowest toner/ink %"], ["printer_status", "Printer: errors (jam, paper, offline…)"], ["printer_jobs", "Printer: failed / aborted print jobs"], ["ups_battery", "UPS: battery %"], ["ups_runtime", "UPS: minutes remaining"], ["ups_on_battery", "UPS: on battery?"], ["hr_cpu", "CPU % (HOST-RESOURCES)"], ["hr_memory", "Memory % (HOST-RESOURCES)"], ["hr_storage", "Fullest disk % (HOST-RESOURCES)"], ["sensor_temp_max", "Hottest sensor °C (ENTITY-SENSOR)"], ["uptime_reboot", "Reboot detection (sysUpTime)"]),
        default: "",
      },
      { key: "oid", label: "OID", kind: "text", placeholder: "1.3.6.1.2.1.1.3.0", showIf: (c) => !c.preset, help: "Leave blank when the result is calculated from Extra OIDs alone (Advanced)." },
      { key: "mode", label: "Read as", kind: "select", options: opts(["get", "Single value"], ["walk_avg", "Walk: average"], ["walk_sum", "Walk: sum"], ["walk_min", "Walk: minimum"], ["walk_max", "Walk: maximum"], ["walk_count", "Walk: count"], ["walk_all", "Full walk: keep every value"]), default: "get", showIf: (c) => !c.preset, help: "Walk modes read every value under the OID. Full walk records all of them in the result (the check page shows the table)." },
      { key: "aggregate", label: "Value of a full walk", kind: "select", options: opts(["count", "Number of rows"], ["sum", "Sum"], ["avg", "Average"], ["min", "Minimum"], ["max", "Maximum"]), default: "count", showIf: (c) => !c.preset && c.mode === "walk_all" },
      { key: "asRate", label: "Counter — report per-second rate", kind: "checkbox", showIf: (c) => !c.preset, help: "For counters (octets, packets, errors). On a walk each row's rate is worked out separately, then combined — so \"max\" is the busiest row's rate." },
      { key: "indexFilter", label: "Only rows whose index matches (regex)", kind: "text", placeholder: "^(1|2|3)$", showIf: (c) => !c.preset && String(c.mode ?? "get") !== "get", advanced: true },
      { key: "maxRows", label: "Keep at most N rows", kind: "number", default: 2000, showIf: (c) => !c.preset && c.mode === "walk_all", advanced: true },
      { key: "scale", label: "Multiply by", kind: "number", showIf: (c) => !c.preset, advanced: true },
      { key: "unit", label: "Unit label", kind: "text", showIf: (c) => !c.preset, advanced: true },
      { key: "expectString", label: "Text value must contain", kind: "text", showIf: (c) => !c.preset, advanced: true },
      {
        key: "expression",
        label: "Calculate",
        kind: "text",
        placeholder: "value / 10",
        help: "Optional maths on the value read, after “Multiply by”: value / 10, value * 8 / 1e6, round(value / 1024, 1). Use the names of Extra OIDs (below) to combine several values from this device, and ref for another check's latest value. + - * / % ^, brackets, min max abs round floor ceil sqrt log10.",
        advanced: true,
      },
      {
        key: "extraOids",
        label: "Extra OIDs (name = OID)",
        kind: "textarea",
        placeholder: "used = 1.3.6.1.2.1.25.2.3.1.6.1\nsize = 1.3.6.1.2.1.25.2.3.1.5.1\ninb = rate(1.3.6.1.2.1.31.1.1.1.6.1)",
        help: "More values read from this device in the same poll, one per line, for Calculate to use by name — e.g. used / size * 100. rate(…) turns a counter into a per-second rate. With these, the main OID is optional.",
        advanced: true,
      },
      { key: "refCheckId", label: "ref = this check's latest value", kind: "checkref", help: "For a value worked out from another check — e.g. this counter as a % of a capacity another check reads.", showIf: (c) => /\bref\b/.test(String(c.expression ?? "")), advanced: true },
      { key: "instance", label: "Disk name filter", kind: "text", showIf: is("preset", "hr_storage") },
      { key: "countCanceled", label: "Count canceled jobs as failures too", kind: "checkbox", showIf: is("preset", "printer_jobs") },
      { ...severity("warn"), showIf: is("preset", "printer_jobs") },
      { ...holdMinutes, showIf: is("preset", "uptime_reboot", "printer_jobs") },
      {
        ...exclude("rows / values", "1.5\nVirtual Memory\n/run*\nWaste*"),
        help: "One per line. A walked row, disk, printer supply or alert is left out when its index (1.5), name or value matches — whole text, case ignored, * matches anything. Reusable lists for many devices: the Exclusions page (SNMP rows and values).",
        showIf: (c) => Boolean(c.preset) || String(c.mode ?? "get") !== "get",
      },
    ],
  },
  {
    type: "snmp_interfaces",
    label: "SNMP interfaces (switch / router ports)",
    category: "Network devices & hardware",
    description: "Walks the whole interface table: ports that went down, utilization, and error rates — one check per device.",
    value: { unit: "%", hint: "busiest port's utilization" },
    fields: [
      host("10.0.0.2"),
      port("161"),
      ...snmpAuth,
      { key: "interfaceFilter", label: "Only interfaces matching (regex)", kind: "text", placeholder: "^(Gi|eth|port)" },
      { key: "alertOnOperDown", label: "Fail when an enabled port is down", kind: "checkbox", default: true },
      { key: "operDownSeverity", label: "Status for a down port", kind: "select", options: opts("down", "warn"), default: "down" },
      { key: "utilWarnPercent", label: "Warn at utilization %", kind: "number", placeholder: "80" },
      { key: "utilCriticalPercent", label: "Critical at utilization %", kind: "number", placeholder: "95" },
      { key: "errorsWarnPerSec", label: "Warn at errors+discards / sec", kind: "number", placeholder: "1" },
      exclude("interfaces", "Vlan1\nNull0\nloopback*"),
    ],
  },
  {
    type: "trap_match",
    label: "SNMP trap received",
    category: "Network devices & hardware",
    description: "Fails when matching SNMP traps arrive (point devices' trap destination at the engine, UDP 1162 by default).",
    value: { unit: "", hint: "matching traps in the window" },
    fields: [{ key: "sourceIp", label: "From IP", kind: "text", placeholder: "any" }, { key: "pattern", label: "Text matches (regex)", kind: "text", placeholder: "linkDown" }, { key: "windowMinutes", label: "Window (minutes)", kind: "number", default: 5 }, { key: "clearPattern", label: "Clears when text matches (regex)", kind: "text", placeholder: "linkUp", help: "A matching event arriving after a failure recovers the check straight away — e.g. linkUp after linkDown. Same sender/site filters apply." }, { key: "autoRecoverMinutes", label: "Recover on its own after (minutes)", kind: "number", placeholder: "same as window", help: "With no thresholds, the check stays failing until this long after the newest matching event. Blank = the window length." }, { key: "exclude", label: "Ignore messages containing", kind: "textarea", advanced: true, placeholder: "one text per line", help: "Events whose message contains any of these (case-insensitive) are ignored entirely." }, severity()],
  },
  {
    type: "syslog_match",
    label: "Syslog message received",
    category: "Network devices & hardware",
    description: "Fails when matching syslog lines arrive (send syslog to the engine, UDP/TCP 1514 by default).",
    value: { unit: "", hint: "matching messages in the window" },
    fields: [
      { key: "sourceIp", label: "From IP", kind: "text", placeholder: "any" },
      { key: "pattern", label: "Text matches (regex)", kind: "text", placeholder: "link down|failed" },
      { key: "maxSeverity", label: "Severity at or above", kind: "select", options: opts(["", "any"], ["0", "emergency"], ["1", "alert"], ["2", "critical"], ["3", "error"], ["4", "warning"], ["5", "notice"], ["6", "info"]), default: "3" },
      { key: "windowMinutes", label: "Window (minutes)", kind: "number", default: 5 },
      { key: "clearPattern", label: "Clears when text matches (regex)", kind: "text", placeholder: "linkUp", help: "A matching event arriving after a failure recovers the check straight away — e.g. linkUp after linkDown. Same sender/site filters apply." }, { key: "autoRecoverMinutes", label: "Recover on its own after (minutes)", kind: "number", placeholder: "same as window", help: "With no thresholds, the check stays failing until this long after the newest matching event. Blank = the window length." }, { key: "exclude", label: "Ignore messages containing", kind: "textarea", advanced: true, placeholder: "one text per line", help: "Events whose message contains any of these (case-insensitive) are ignored entirely." },
      severity(),
    ],
  },
  {
    type: "bmc",
    label: "Server hardware (iDRAC / iLO / IPMI)",
    category: "Network devices & hardware",
    description: "Power supplies, fans, temperatures and overall health from the server's BMC — Redfish for modern boards, IPMI (ipmitool) for older ones.",
    value: { unit: "°C", hint: "hottest temperature sensor" },
    fields: [
      { key: "protocol", label: "Protocol", kind: "select", options: opts(["redfish", "Redfish (iDRAC 8+, iLO 4+, Supermicro X10+)"], ["ipmi", "IPMI over LAN (needs ipmitool)"]), default: "redfish" },
      { key: "url", label: "BMC URL", kind: "text", placeholder: "https://10.0.0.30", showIf: not("protocol", "ipmi"), required: true },
      { key: "host", label: "BMC host", kind: "text", showIf: is("protocol", "ipmi"), required: true },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "secret" },
      { key: "requirePoweredOn", label: "Fail if the server is powered off", kind: "checkbox", default: true, showIf: not("protocol", "ipmi") },
      { ...insecure, default: true },
    ],
  },

  // ---- Virtualization & containers ----
  {
    type: "proxmox",
    label: "Proxmox VE",
    category: "Virtualization & containers",
    description: "Cluster quorum, node load, a VM/container's state, storage usage, or the age of the last successful backup — via an API token.",
    value: { unit: "", hint: "CPU/RAM %, storage %, stopped guests, or hours since backup" },
    fields: [
      { key: "url", label: "API URL", kind: "text", required: true, placeholder: "https://pve.lan:8006", wide: true },
      { key: "tokenId", label: "Token ID", kind: "text", required: true, placeholder: "monitor@pve!looksee" },
      { key: "tokenSecret", label: "Token secret", kind: "secret", required: true },
      { key: "target", label: "Check", kind: "select", options: opts(["node", "Node CPU / memory"], ["cluster", "Cluster quorum & nodes"], ["vm", "VM / container state"], ["storage", "Storage usage"], ["backups", "Last backup (vzdump)"]), default: "node" },
      { key: "name", label: "Node / VMID / storage name", kind: "text", placeholder: "pve1, 101, local-zfs, or * for all guests", showIf: not("target", "cluster") },
      { key: "metric", label: "Metric", kind: "select", options: opts(["cpu_percent", "CPU %"], ["memory_percent", "Memory %"]), default: "cpu_percent", showIf: is("target", "node") },
      { key: "expectedStatus", label: "Expected state", kind: "text", default: "running", showIf: is("target", "vm") },
      { key: "maxAgeHours", label: "Max hours since last OK backup", kind: "number", default: 26, showIf: is("target", "backups") },
      { ...insecure, default: true },
    ],
  },
  {
    type: "vmware",
    label: "VMware ESXi / vCenter",
    category: "Virtualization & containers",
    description: "VM power state, datastore space, or host health over the vSphere API.",
    value: { unit: "", hint: "VMs not powered on, or datastore %" },
    fields: [
      { key: "url", label: "Endpoint / vCenter URL", kind: "text", required: true, placeholder: "https://esxi.lan", wide: true },
      { key: "username", label: "Username", kind: "text" },
      { key: "password", label: "Password", kind: "secret" },
      { key: "target", label: "Check", kind: "select", options: opts(["vm", "VM power state"], ["datastore", "Datastore space"], ["host", "Endpoint health"]), default: "vm" },
      { key: "name", label: "Name (or * for all)", kind: "text", placeholder: "*" },
      { ...insecure, default: true },
    ],
  },
  {
    type: "agent_hyperv",
    label: "Hyper-V VMs",
    category: "Virtualization & containers",
    description: "VM state on a Hyper-V host (via the agent on that machine).",
    needsEndpoint: true,
    value: { unit: "", hint: "VMs not running (or the VM's CPU %)" },
    fields: [{ key: "vmName", label: "VM name (or * for all)", kind: "text", default: "*" }, { key: "ignore", label: "Ignore VMs", kind: "text", placeholder: "comma-separated; * wildcards" }, { key: "expectedState", label: "Expected state", kind: "text", default: "Running", advanced: true }, severity()],
  },
  {
    type: "agent_docker",
    label: "Docker containers",
    category: "Virtualization & containers",
    description: "Container running/healthy state, restarts, or CPU/memory — via the agent on the Docker host.",
    needsEndpoint: true,
    value: { unit: "", hint: "problem count, restarts, or CPU/memory %" },
    fields: [
      { key: "container", label: "Container (name, glob, or *)", kind: "text", default: "*", suggest: "containers" },
      { key: "measure", label: "Measure", kind: "select", options: opts(["status", "Running & healthy"], ["restart_count", "Restarts since last check"], ["cpu_percent", "CPU %"], ["memory_percent", "Memory % of limit"]), default: "status" },
      { key: "ignoreStopped", label: "Ignore stopped containers", kind: "checkbox" },
      exclude("containers", "*-migrate\nbackup-job"),
      severity(),
      holdMinutes,
    ],
  },

  // ---- Endpoint metrics (agent) ----
  {
    type: "host_metric",
    label: "Endpoint metric",
    category: "Endpoint metrics (agent)",
    description: "Any of 60+ metrics the agent reports: CPU detail, load, swap, every disk, inodes, I/O, interfaces, temperatures, SMART, RAID, updates, firewall, Defender, encryption…",
    needsEndpoint: true,
    value: { unit: "", hint: "the metric" },
    fields: [{ key: "metric", label: "Metric", kind: "metric", required: true }, exclude("mounts, interfaces, devices or sensors", "/snap/*\nveth*\nloop*")],
  },
  { type: "host_cpu", label: "CPU usage (simple)", category: "Endpoint metrics (agent)", description: "Overall CPU %. Endpoint metric offers more detail.", needsEndpoint: true, legacy: true, fields: [{ key: "warnPercent", label: "Warn at %", kind: "number" }, { key: "criticalPercent", label: "Critical at %", kind: "number" }] },
  { type: "host_memory", label: "Memory usage (simple)", category: "Endpoint metrics (agent)", description: "Overall memory %.", needsEndpoint: true, legacy: true, fields: [{ key: "warnPercent", label: "Warn at %", kind: "number" }, { key: "criticalPercent", label: "Critical at %", kind: "number" }] },
  { type: "host_disk", label: "Disk usage (simple)", category: "Endpoint metrics (agent)", description: "The agent's main disk %. Endpoint metric covers every mount.", needsEndpoint: true, legacy: true, fields: [{ key: "warnPercent", label: "Warn at %", kind: "number" }, { key: "criticalPercent", label: "Critical at %", kind: "number" }] },
  {
    type: "disk_forecast",
    label: "Disk full forecast",
    category: "Endpoint metrics (agent)",
    description: "Projects when a disk fills at its recent growth rate.",
    needsEndpoint: true,
    value: { unit: " days", hint: "days until full" },
    fields: [
      { key: "mount", label: "Mount (blank = soonest to fill)", kind: "text", suggest: "mounts" },
      { key: "lookbackDays", label: "Trend over (days)", kind: "number", default: 7, advanced: true, help: "Longer smooths out weekly patterns; shorter reacts faster to a sudden change in growth." },
      { key: "warnDays", label: "Warn when full within (days)", kind: "number", default: 14 },
      { key: "criticalDays", label: "Critical when full within (days)", kind: "number", default: 3 },
    ],
  },
  { type: "host_reboot", label: "Reboot detection", category: "Endpoint metrics (agent)", description: "Flags every reboot so an unplanned one doesn't go unnoticed.", needsEndpoint: true, fields: [severity("warn"), holdMinutes] },
  {
    type: "host_change",
    label: "Change detection",
    category: "Endpoint metrics (agent)",
    description: "Alerts when something about the endpoint changes: new login sessions, listening ports, hardware/OS inventory, interfaces, mounts.",
    needsEndpoint: true,
    fields: [{ key: "what", label: "Watch", kind: "select", options: opts(["sessions", "New login sessions"], ["listening_ports", "Listening ports"], ["inventory", "Hardware / OS inventory"], ["interfaces", "Network interfaces"], ["mounts", "Mounted filesystems"]), default: "sessions" }, severity("warn"), holdMinutes],
  },
  { type: "agent_heartbeat", label: "Agent online", category: "Endpoint metrics (agent)", description: "Fails if the endpoint's agent stops reporting — machine down, agent crashed, or network cut.", needsEndpoint: true, value: { unit: " s", hint: "seconds since the last report" }, fields: [{ key: "maxSilenceSeconds", label: "Allowed silence (seconds)", kind: "number", default: 180 }, { key: "severity", label: "Status when silent", kind: "select", options: opts(["down", "Down"], ["warn", "Warn — e.g. laptops that sleep"]), default: "down", advanced: true }] },

  // ---- Services & processes (agent) ----
  { type: "agent_service", label: "OS service", category: "Services & processes (agent)", description: "Is a systemd unit / Windows service running. On Linux also counts restarts.", needsEndpoint: true, fields: [
      { key: "serviceName", label: "Service", kind: "text", required: true, suggest: "services" },
      { key: "maxRestarts", label: "Warn above N restarts / hour", kind: "number", help: "systemd only." },
      { key: "expectState", label: "Should be", kind: "select", options: opts(["running", "Running"], ["stopped", "Stopped — e.g. Telnet, Remote Registry"]), default: "running", advanced: true, help: "Stopped makes this a check that a risky or unneeded service stays off. Needs agent 5.0." },
      { ...severity("down"), advanced: true },
    ] },
  {
    type: "agent_process",
    label: "Process",
    category: "Services & processes (agent)",
    description: "Process running (by name substring), how many, and their CPU / memory.",
    needsEndpoint: true,
    value: { unit: "", hint: "count, CPU %, or MB" },
    fields: [
      { key: "serviceName", label: "Process name", kind: "text", required: true, suggest: "processes" },
      { key: "measure", label: "Measure", kind: "select", options: opts(["count", "Instance count"], ["cpu_percent", "CPU %"], ["memory_mb", "Memory (MB)"]), default: "count" },
      { key: "minCount", label: "At least N running", kind: "number", default: 1 },
      { key: "maxCount", label: "At most N running", kind: "number" },
    ],
  },
  { type: "agent_services_overview", label: "Failed / stopped services", category: "Services & processes (agent)", description: "Any failed systemd unit (Linux), or any automatic-start service that isn't running (Windows).", needsEndpoint: true, value: { unit: "", hint: "how many" }, fields: [{ key: "exclude", label: "Ignore", kind: "textarea", placeholder: "one name per line or comma-separated", help: "Whole names, case ignored, * matches anything. Reusable lists for many endpoints: the Exclusions page." }, { key: "includeCleanStops", label: "Also count services that stopped cleanly (Windows)", kind: "checkbox", advanced: true, help: "Off by default: updaters and on-demand services routinely stop themselves with exit code 0." }, severity()] },
  { type: "agent_scheduled_task", label: "Scheduled task / timer", category: "Services & processes (agent)", description: "Last result and run time of a Windows scheduled task or a systemd timer. (For cron jobs, use a Heartbeat.)", needsEndpoint: true, value: { unit: " h", hint: "hours since it last ran" }, fields: [{ key: "taskName", label: "Task / unit", kind: "text", required: true, placeholder: "\\Backup\\Nightly or backup.timer" }, { key: "maxAgeHours", label: "Fail if it hasn't run for (hours)", kind: "number" }] },
  {
    type: "agent_script",
    label: "Custom script",
    category: "Services & processes (agent)",
    description: "Runs a script or command wrapper from the agent's script_dir and checks its output and exit code. Without an expected output, exit 0/1/2 = up/warn/down (Nagios convention); a number in the output becomes the value. Can be run by another endpoint's agent.",
    needsEndpoint: true,
    otherAgent: true,
    value: { unit: "", hint: "perfdata or first number in the output" },
    fields: [
      { key: "script", label: "Script file name", kind: "text", required: true, placeholder: "check_queue.sh", suggest: "scripts", help: "Must sit directly in script_dir on that endpoint — the list shows what the agent found there. Looksee never sends commands to run; see the agent README → Custom scripts." },
      { key: "args", label: "Arguments", kind: "text" },
      { key: "expectMode", label: "Expected output", kind: "select", options: opts(["", "None — use the exit code"], ["contains", "Contains"], ["not_contains", "Does not contain"], ["equals", "Equals (whole output)"], ["regex", "Matches regex"]), default: "" },
      { key: "expectText", label: "Expected text / pattern", kind: "text", required: true, showIf: (c) => Boolean(c.expectMode), wide: true },
      { key: "expectIgnoreCase", label: "Ignore case", kind: "checkbox", showIf: (c) => Boolean(c.expectMode) },
      { key: "expectExitCode", label: "Expected exit code", kind: "number", placeholder: "any", help: "Blank = any exit code is fine when an expected output is set." },
      { key: "expectSeverity", label: "Status when it doesn't match", kind: "select", options: opts(["down", "Down (critical)"], ["warn", "Warn"]), default: "down", showIf: (c) => Boolean(c.expectMode) || (c.expectExitCode !== undefined && c.expectExitCode !== "") },
      { key: "warnIfMatches", label: "Warn if the output contains", kind: "text", placeholder: "DEGRADED", help: "Optional. For scripts that print a problem rather than confirm success. Works with or without an expected output; the worse status wins.", wide: true },
      { key: "downIfMatches", label: "Down if the output contains", kind: "text", placeholder: "ERROR", help: "Optional. Checked before the warn text — when both appear, the check is down.", wide: true },
      { key: "alertMatchMode", label: "Warn/down text is", kind: "select", options: opts(["contains", "Plain text"], ["regex", "A regular expression"]), default: "contains", showIf: (c) => Boolean(c.warnIfMatches) || Boolean(c.downIfMatches) },
      { key: "alertIgnoreCase", label: "Ignore case in warn/down text", kind: "checkbox", showIf: (c) => Boolean(c.warnIfMatches) || Boolean(c.downIfMatches) },
      timeout(30),
      { key: "parseValue", label: "Read a number from the output", kind: "checkbox", default: true, advanced: true },
    ],
  },

  {
    type: "agent_users",
    label: "Local user accounts",
    category: "Software & security (agent)",
    description: "Lists the endpoint's local accounts and alerts on new, removed or changed ones — disabled/enabled, admin rights, password changed (Windows, Linux, macOS).",
    needsEndpoint: true,
    defaultInterval: 300,
    value: { unit: "", hint: "accounts watched" },
    fields: [
      { key: "watch", label: "Alert on", kind: "multi", options: opts(["added", "new accounts"], ["removed", "removed accounts"], ["changed", "changed accounts"]), default: "added,removed,changed" },
      { ...severity("warn"), label: "Status when an account changes" },
      { key: "adminSeverity", label: "Status when someone gains admin rights", kind: "select", options: opts(["down", "Down (critical)"], ["warn", "Warn"]), default: "down", help: "A new admin account, or an existing account added to Administrators / sudo / wheel / admin." },
      { ...holdMinutes, default: 60 },
      { key: "includeSystem", label: "Include built-in and service accounts", kind: "checkbox", advanced: true, help: "Off by default: Linux/macOS system users (low user IDs) and Windows built-ins change with OS updates." },
      exclude("accounts", "svc-backup\ntmp-*"),
    ],
  },

  // ---- Files & logs (agent) ----
  {
    type: "agent_file",
    label: "File / folder",
    category: "Files & logs (agent)",
    description: "Exists, age (did the backup land?), size, file count, folder size, checksum drift, or a folder watchdog for created/changed/deleted files.",
    needsEndpoint: true,
    value: { unit: "", hint: "minutes old, MB, or count" },
    fields: [
      { key: "path", label: "Path", kind: "text", required: true, placeholder: "/srv/backups or C:\\Backups", wide: true },
      {
        key: "mode",
        label: "Check",
        kind: "select",
        options: opts(["exists", "Exists"], ["not_exists", "Doesn't exist"], ["age", "Age of file / newest file in folder"], ["size", "File size (MB)"], ["count", "Number of files in folder"], ["folder_size", "Folder size (MB)"], ["checksum", "Content changed (checksum)"], ["watchdog", "Folder watchdog (created / modified / deleted)"]),
        default: "exists",
      },
      { key: "pattern", label: "Only files matching", kind: "text", placeholder: "*.tar.gz", showIf: is("mode", "age", "count", "folder_size", "watchdog") },
      { key: "recursive", label: "Include subfolders", kind: "checkbox", showIf: is("mode", "age", "count", "folder_size", "watchdog") },
      { key: "maxAgeMinutes", label: "Fail if older than (minutes)", kind: "number", showIf: is("mode", "age") },
      { key: "events", label: "Watch for", kind: "multi", options: opts("created", "modified", "deleted"), default: "created,modified,deleted", showIf: is("mode", "watchdog") },
      { key: "expectedChecksum", label: "Expected SHA-256", kind: "text", help: "Blank = the first value seen becomes the baseline.", showIf: is("mode", "checksum") },
      { ...severity("warn"), showIf: is("mode", "watchdog", "checksum", "not_exists") },
      { ...holdMinutes, showIf: is("mode", "watchdog", "checksum") },
    ],
  },
  {
    type: "agent_disk_tree",
    label: "Largest folders and files",
    category: "Files & logs (agent)",
    description: "Walks each disk (or one folder) and lists the largest folders and files, with how much each grew since the last scan — finds what's filling a disk.",
    needsEndpoint: true,
    defaultInterval: 21600,
    value: { unit: " GB", hint: "total size scanned" },
    fields: [
      { key: "path", label: "Folder", kind: "text", placeholder: "every local disk", suggest: "mounts", help: "Blank scans every local disk. A folder scans just that tree.", wide: true },
      { key: "top", label: "How many to list", kind: "number", default: 25, help: "Largest folders and largest files, each (per disk)." },
      { key: "depth", label: "Folder levels", kind: "number", default: 4, advanced: true, help: "Folders up to this many levels below the disk or folder are ranked (their sizes always include everything below them)." },
      { key: "maxSeconds", label: "Stop scanning after (seconds)", kind: "number", default: 300, advanced: true, help: "A very large disk is reported as partially scanned rather than walked forever." },
      { key: "skip", label: "Skip folders", kind: "textarea", placeholder: "/proc\nC:\\Windows\\WinSxS", advanced: true, help: "One path per line; their contents aren't scanned." },
    ],
  },
  {
    type: "agent_log",
    label: "Log file pattern",
    category: "Files & logs (agent)",
    description: "Tails a log file (follows rotation; globs allowed) and counts new lines matching a pattern.",
    needsEndpoint: true,
    value: { unit: "", hint: "new matching lines" },
    fields: [
      { key: "path", label: "Log file", kind: "text", required: true, placeholder: "/var/log/app/*.log", wide: true },
      { key: "pattern", label: "Match (regex)", kind: "text", placeholder: "ERROR|FATAL" },
      { key: "ignoreCase", label: "Ignore case", kind: "checkbox", default: true },
      { key: "invert", label: "Count lines that DON'T match", kind: "checkbox", advanced: true },
      exclude("lines containing", "healthcheck\nDEBUG", false),
      severity(),
    ],
  },
  {
    type: "agent_journal",
    label: "systemd journal",
    category: "Files & logs (agent)",
    description: "New journal entries for a unit and/or priority, optionally filtered by text (Linux).",
    needsEndpoint: true,
    value: { unit: "", hint: "new matching entries" },
    fields: [{ key: "unit", label: "Unit", kind: "text", suggest: "services" }, { key: "priority", label: "Priority at or above", kind: "select", options: opts(["", "any"], "emerg", "alert", "crit", "err", "warning", "notice", "info"), default: "err" }, { key: "pattern", label: "Text matches (regex)", kind: "text" }, exclude("entries containing", "pam_unix\nhealthcheck", false), severity()],
  },
  {
    type: "agent_eventlog",
    label: "Windows Event Log",
    category: "Files & logs (agent)",
    description: "New events by log, ID, level and source — disk errors, failed logons (4625), unexpected shutdowns (6008)…",
    needsEndpoint: true,
    value: { unit: "", hint: "new matching events" },
    fields: [
      { key: "logName", label: "Log", kind: "text", default: "System", placeholder: "System, Application, Security" },
      { key: "eventIds", label: "Event IDs", kind: "text", placeholder: "41,6008" },
      { key: "levels", label: "Levels", kind: "multi", options: opts("critical", "error", "warning", "information"), default: "critical,error" },
      { key: "provider", label: "Source / provider", kind: "text" },
      { key: "pattern", label: "Message matches (regex)", kind: "text" },
      { ...exclude("events", "10016\nDistributedCOM", false), help: "One per line: an event ID (digits only) skips that ID; anything else skips events whose message contains it. Reusable lists: the Exclusions page." },
      severity(),
    ],
  },

  // ---- OS & hardware (agent) ----
  { type: "agent_perfcounter", label: "Windows performance counter", category: "OS & hardware (agent)", description: "Any Windows perf counter path (wildcards combined).", needsEndpoint: true, value: { unit: "", hint: "counter value" }, fields: [{ key: "counter", label: "Counter path", kind: "text", required: true, placeholder: "\\Processor(_Total)\\% Processor Time", wide: true }, { key: "aggregation", label: "Combine instances by", kind: "select", options: opts("sum", "avg", "max", "min"), default: "sum", advanced: true }] },
  {
    type: "agent_vpn",
    label: "VPN tunnel",
    category: "OS & hardware (agent)",
    description: "WireGuard handshake age, or that a tunnel interface (OpenVPN, Tailscale, ZeroTier…) exists and is up.",
    needsEndpoint: true,
    value: { unit: " s", hint: "seconds since the last WireGuard handshake" },
    fields: [{ key: "kind", label: "Type", kind: "select", options: opts(["wireguard", "WireGuard"], ["interface", "Any tunnel interface"]), default: "wireguard" }, { key: "interface", label: "Interface", kind: "text", required: true, suggest: "interfaces", placeholder: "wg0" }, { key: "peer", label: "Peer public key", kind: "text", showIf: is("kind", "wireguard"), advanced: true }, { key: "maxHandshakeAgeSeconds", label: "Max handshake age (s)", kind: "number", default: 300, showIf: is("kind", "wireguard") }],
  },
  { type: "agent_ups", label: "UPS (NUT / apcupsd)", category: "OS & hardware (agent)", description: "A UPS attached to this endpoint: on battery = warn, low battery = down.", needsEndpoint: true, value: { unit: "%", hint: "battery charge" }, fields: [{ key: "driver", label: "Software", kind: "select", options: opts(["nut", "Network UPS Tools (upsc)"], ["apcupsd", "apcupsd (apcaccess)"]), default: "nut" }, { key: "upsName", label: "UPS name", kind: "text", default: "ups@localhost", showIf: is("driver", "nut") }] },
  {
    type: "agent_backup",
    label: "Backup job (Borg / restic / Veeam)",
    category: "OS & hardware (agent)",
    description: "Age (and result, for Veeam) of the newest backup.",
    needsEndpoint: true,
    value: { unit: " h", hint: "hours since the newest backup" },
    fields: [
      { key: "tool", label: "Tool", kind: "select", options: opts(["borg", "BorgBackup"], ["restic", "restic"], ["veeam", "Veeam (Windows event log)"]), default: "borg" },
      { key: "repo", label: "Repository", kind: "text", placeholder: "ssh://backup@nas/./repo", showIf: not("tool", "veeam"), wide: true },
      { key: "passphrase", label: "Passphrase", kind: "secret", showIf: not("tool", "veeam") },
      { key: "maxAgeHours", label: "Fail if older than (hours)", kind: "number", default: 26 },
      { key: "extraEnv", label: "Extra environment", kind: "secret", placeholder: "BORG_RSH=ssh -i /root/.ssh/backup", showIf: not("tool", "veeam"), advanced: true },
    ],
  },

  // ---- Push & smart ----
  {
    type: "heartbeat",
    label: "Heartbeat (cron / job check-in)",
    category: "Push & smart",
    description: "Your job calls a unique URL when it finishes; if no call arrives within the interval plus grace, the check goes down. The interval below is how often you expect the call.",
    fields: [{ key: "graceSeconds", label: "Grace period (seconds)", kind: "number", default: 60, advanced: true, help: "Extra time after the interval before a missing call counts as a failure — allow for jobs that run long." }],
  },
  {
    type: "push_value",
    label: "Push a value",
    category: "Push & smart",
    description: "A script sends a number to a unique URL (?value=42); thresholds and graphs apply as for any check.",
    value: { unit: "", hint: "the pushed value" },
    fields: [
      { key: "graceSeconds", label: "Grace period (seconds)", kind: "number", default: 60, advanced: true },
      { key: "autoRecoverMinutes", label: "Recover on its own after (minutes)", kind: "number", placeholder: "off", advanced: true, help: "A failure pushed in normally stays until the next push. Set this to mark the check recovered when no new result has arrived for this long." },
    ],
  },
  // ---- Software & security (agent) ----
  {
    type: "host_packages",
    label: "Upgradable packages",
    category: "Software & security (agent)",
    description: "Lists the packages with updates waiting (apt, dnf, pacman, Windows Update, macOS). Ubuntu phased updates — held back on purpose by Ubuntu's gradual rollout — are left out unless you include them.",
    needsEndpoint: true,
    value: { unit: "", hint: "packages to update" },
    fields: [
      { key: "failOn", label: "Fail when", kind: "select", options: opts(["security", "a security update is waiting"], ["any", "any update is waiting"], ["none", "never (just report — or use thresholds)"]), default: "security" },
      severity("warn"),
      { key: "securityOnly", label: "Only count security updates", kind: "checkbox" },
      { key: "includePhased", label: "Include Ubuntu phased updates", kind: "checkbox", advanced: true, help: "Off by default: Ubuntu holds these back for most machines until its rollout reaches them, so apt won't install them yet anyway." },
      exclude("packages", "linux-image-*\nlinux-headers-*"),
    ],
  },
  {
    type: "host_software",
    label: "Installed software changed",
    category: "Software & security (agent)",
    description: "Alerts when software is installed, removed or changes version — OS packages, Windows programs, macOS apps, global npm/pip packages, runtimes and lock files.",
    needsEndpoint: true,
    value: { unit: "", hint: "packages installed" },
    fields: [
      { key: "sources", label: "Only watch", kind: "multi", options: opts(["dpkg", "Debian/Ubuntu packages"], ["rpm", "RPM packages"], ["apk", "Alpine packages"], ["pacman", "Arch packages"], ["windows", "Windows programs"], ["macos", "macOS apps"], ["npm", "npm"], ["pip", "pip"], ["composer", "Composer"], ["runtime", "Runtimes (Node, Python, PHP)"]), help: "Blank = everything." },
      { ...holdMinutes, default: 60 },
      severity("warn"),
      exclude("packages", "google-chrome-*\nmicrosoft-edge-*"),
      { key: "lockfiles", label: "Also watch lock files", kind: "textarea", placeholder: "/srv/app/package-lock.json", advanced: true, help: "One path per line: package-lock.json, npm-shrinkwrap.json, Pipfile.lock, requirements.txt or composer.lock. Only files with those names are read." },
    ],
  },
  {
    type: "host_vulnerable",
    label: "Vulnerable or unsupported software",
    category: "Software & security (agent)",
    description: "Checks installed software against known vulnerabilities (OSV.dev — OS packages, npm, pip, Composer, lock files) and end-of-life dates (endoflife.date — the OS, Node.js, Python, PHP, PostgreSQL, MySQL, MariaDB). Package names and versions are sent to those public services.",
    needsEndpoint: true,
    value: { unit: "", hint: "vulnerable packages" },
    fields: [
      { key: "warnAt", label: "Warn at severity", kind: "select", options: opts("low", "medium", "high", "critical"), default: "medium" },
      { key: "downAt", label: "Down at severity", kind: "select", options: opts("low", "medium", "high", "critical"), default: "high" },
      { key: "eolStatus", label: "Unsupported (end of life)", kind: "select", options: opts(["down", "Down"], ["warn", "Warn"]), default: "down" },
      { key: "eolWarnDays", label: "Warn this many days before end of life", kind: "number", default: 90 },
      {
        key: "exclude",
        label: "Accepted risks",
        kind: "textarea",
        placeholder: "libssl1.1 # needed by the old ERP client\nCVE-2024-1234 # not reachable here",
        help: "One per line: a package name (* wildcards) or an advisory ID (CVE-…, GHSA-…, USN-…), then # and why it can't be updated or replaced. Reasons are shown with the result.",
      },
      { key: "lockfiles", label: "Also check lock files", kind: "textarea", placeholder: "/srv/app/package-lock.json\n/var/www/site/composer.lock", help: "One path per line: package-lock.json, npm-shrinkwrap.json, Pipfile.lock, requirements.txt or composer.lock — your apps' own dependencies. Only files with those names are read." },
      { key: "useOsv", label: "Look up vulnerabilities (OSV.dev)", kind: "checkbox", default: true, advanced: true },
      { key: "useEol", label: "Look up end-of-life dates (endoflife.date)", kind: "checkbox", default: true, advanced: true },
    ],
  },
  {
    type: "calculated",
    label: "Calculated value",
    category: "Push & smart",
    description: "Works out a value from up to four other checks' latest values — UPS load in watts from load % and capacity, two disks' combined free space, the difference between two sensors.",
    value: { unit: "", hint: "the calculated value" },
    fields: [
      { key: "expression", label: "Expression", kind: "text", required: true, placeholder: "a / 100 * b", help: "Use a, b, c and d for the checks below. + - * / % ^, brackets, min max abs round floor ceil sqrt log10.", wide: true },
      { key: "varA", label: "a =", kind: "checkref" },
      { key: "varB", label: "b =", kind: "checkref" },
      { key: "varC", label: "c =", kind: "checkref" },
      { key: "varD", label: "d =", kind: "checkref" },
      { key: "unit", label: "Unit label", kind: "text", placeholder: " W" },
      { key: "maxAgeMinutes", label: "Inputs must be newer than (minutes)", kind: "number", default: 15, advanced: true, help: "An older input makes the result unknown rather than calculating from stale data." },
    ],
  },
  {
    type: "anomaly",
    label: "Anomaly (unusual value)",
    category: "Push & smart",
    description: "Compares another check's latest value to its own history for the same hour of day (or week), and flags anything unusually far off.",
    fields: [
      { key: "sourceCheckId", label: "Watch this check", kind: "checkref", required: true },
      { key: "field", label: "Using its", kind: "select", options: opts(["value", "value"], ["latency", "response time"]), default: "value" },
      { key: "sensitivity", label: "Unusual beyond (standard deviations)", kind: "number", default: 3 },
      { key: "direction", label: "Direction", kind: "select", options: opts(["both", "too high or too low"], ["above", "too high only"], ["below", "too low only"]), default: "both" },
      { key: "seasonality", label: "Compare with", kind: "select", options: opts(["hour_of_day", "same hour, previous days"], ["hour_of_week", "same hour & weekday"], ["none", "all recent values"]), default: "hour_of_day", advanced: true },
      { key: "lookbackDays", label: "History (days)", kind: "number", default: 14, advanced: true },
      { key: "minSamples", label: "Learn from at least N samples", kind: "number", default: 20, advanced: true },
    ],
  },
];

export const TYPE_BY_KEY = new Map(CHECK_TYPES.map((t) => [t.type, t]));
export const typeLabel = (type: string) => TYPE_BY_KEY.get(type)?.label ?? type;
export const typeCategory = (type: string) => TYPE_BY_KEY.get(type)?.category ?? "Other";

export function defaultConfigFor(type: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of TYPE_BY_KEY.get(type)?.fields ?? []) if (f.default !== undefined) out[f.key] = f.default;
  return out;
}

const NUMERIC_EXTRA = ["warnAbove", "criticalAbove", "warnBelow", "criticalBelow", "latencyWarnMs", "latencyCriticalMs", "timeoutsBeforeDown"];

// Form state is strings; the API wants numbers/booleans and no empty keys.
// Fields hidden by showIf are dropped so a switched mode doesn't leave
// stale settings behind.
export function normalizeConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const def = TYPE_BY_KEY.get(type);
  const fieldByKey = new Map((def?.fields ?? []).map((f) => [f.key, f]));
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const f = fieldByKey.get(key);
    if (f?.showIf && !f.showIf(config)) continue;
    if (value === "" || value == null) continue;
    if (f?.kind === "number" || NUMERIC_EXTRA.includes(key)) {
      const n = Number(value);
      if (Number.isFinite(n)) setOwn(out, key, n);
      continue;
    }
    setOwn(out, key, value);
  }
  return out;
}

export function validateConfig(type: string, config: Record<string, unknown>): string | null {
  for (const f of TYPE_BY_KEY.get(type)?.fields ?? []) {
    if (!f.required || (f.showIf && !f.showIf(config))) continue;
    const v = config[f.key];
    if (v === undefined || v === null || v === "") return `${f.label} is required.`;
  }
  return null;
}
