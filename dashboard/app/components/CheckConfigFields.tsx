"use client";

import { Tooltip } from "./Tooltip";

// Structured, per-check-type fields — replaces a raw JSON config textarea
// so adding a check never requires knowing the underlying field names.
// Each type's shape here must match what engine/src/services/prober.ts
// actually reads out of `checks.config`.
export const CHECK_TYPE_LABELS: Record<string, string> = {
  ping: "Ping",
  tcp: "TCP port",
  http: "HTTP(S)",
  dns: "DNS resolution",
  ssl_cert: "SSL certificate expiry",
  agent_service: "Service/process (via agent)",
};

export const CHECK_TYPE_HELP: Record<string, string> = {
  ping: "Sends an ICMP ping to a host or IP and checks for a reply. Good for \"is this device on the network.\"",
  tcp: "Opens a TCP connection to a host:port and checks it succeeds. Good for databases, SSH, or any non-HTTP service.",
  http: "Requests a URL (http:// or https://) and checks the response status. The most common check for websites and APIs.",
  dns: "Resolves a hostname and checks it succeeds. Good for verifying a DNS server (e.g. Pi-hole) is actually answering.",
  ssl_cert: "Connects over TLS and checks how many days remain before the certificate expires, warning before it's too late to renew.",
  agent_service: "Asks the Looksee agent on a specific host whether a named process is running. Requires the agent installed on that host — see Hosts.",
};

export function defaultConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "ping":
      return { host: "" };
    case "tcp":
      return { host: "", port: "" };
    case "http":
      return { url: "", expectedStatus: "" };
    case "dns":
      return { hostname: "" };
    case "ssl_cert":
      return { host: "", port: 443, warnDays: 14 };
    case "agent_service":
      return { serviceName: "" };
    default:
      return {};
  }
}

// Form fields work with strings (controlled inputs); this converts the
// numeric-looking ones to real numbers before the config is sent to the
// API, and drops empty optional fields rather than sending "".
export function normalizeConfig(type: string, config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === "" || value == null) continue;
    const numericKeys = ["port", "expectedStatus", "warnDays"];
    out[key] = numericKeys.includes(key) ? Number(value) : value;
  }
  return out;
}

export function validateConfig(type: string, config: Record<string, unknown>): string | null {
  const required: Record<string, string[]> = {
    ping: ["host"],
    tcp: ["host", "port"],
    http: ["url"],
    dns: ["hostname"],
    ssl_cert: ["host"],
    agent_service: ["serviceName"],
  };
  for (const key of required[type] ?? []) {
    if (!config[key] && config[key] !== 0) return `${key} is required for a ${CHECK_TYPE_LABELS[type] ?? type} check.`;
  }
  return null;
}

function Field({
  label,
  tooltip,
  value,
  onChange,
  placeholder,
  type = "text",
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number";
}) {
  return (
    <label className="block">
      <span className="inline-flex items-center text-[var(--muted)]">
        {label}
        <Tooltip text={tooltip} />
      </span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm outline-none"
      />
    </label>
  );
}

export function CheckConfigFields({
  type,
  config,
  onChange,
}: {
  type: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
}) {
  const str = (key: string) => (config[key] != null ? String(config[key]) : "");
  const set = (key: string, value: string) => onChange({ ...config, [key]: value });

  switch (type) {
    case "ping":
      return <Field label="Host" tooltip="Hostname or IP address to ping. Example: 8.8.8.8 or router.local" value={str("host")} onChange={(v) => set("host", v)} placeholder="8.8.8.8" />;
    case "tcp":
      return (
        <div className="grid grid-cols-2 gap-2">
          <Field label="Host" tooltip="Hostname or IP to connect to." value={str("host")} onChange={(v) => set("host", v)} placeholder="10.1.30.10" />
          <Field label="Port" tooltip="TCP port to check, e.g. 22 for SSH, 5432 for Postgres." value={str("port")} onChange={(v) => set("port", v)} placeholder="5432" type="number" />
        </div>
      );
    case "http":
      return (
        <div className="space-y-2">
          <Field
            label="URL"
            tooltip="Full URL including http:// or https://. Both are supported — just include the scheme you want checked."
            value={str("url")}
            onChange={(v) => set("url", v)}
            placeholder="https://example.com/health"
          />
          <Field
            label="Expected status (optional)"
            tooltip="Exact HTTP status code expected, e.g. 200. Leave blank to accept any status under 400."
            value={str("expectedStatus")}
            onChange={(v) => set("expectedStatus", v)}
            placeholder="200"
            type="number"
          />
        </div>
      );
    case "dns":
      return <Field label="Hostname" tooltip="Hostname to resolve via DNS. Example: pi.hole or example.com" value={str("hostname")} onChange={(v) => set("hostname", v)} placeholder="pi.hole" />;
    case "ssl_cert":
      return (
        <div className="grid grid-cols-3 gap-2">
          <Field label="Host" tooltip="Hostname to connect to over TLS." value={str("host")} onChange={(v) => set("host", v)} placeholder="example.com" />
          <Field label="Port" tooltip="TLS port, usually 443." value={str("port")} onChange={(v) => set("port", v)} placeholder="443" type="number" />
          <Field label="Warn (days)" tooltip="Show a warning status once the certificate is within this many days of expiring." value={str("warnDays")} onChange={(v) => set("warnDays", v)} placeholder="14" type="number" />
        </div>
      );
    case "agent_service":
      return (
        <Field
          label="Service name"
          tooltip={'Process/service name to look for, matched by substring — e.g. "nginx" matches both nginx and nginx.exe. Requires the Looksee agent installed on this check\'s host.'}
          value={str("serviceName")}
          onChange={(v) => set("serviceName", v)}
          placeholder="nginx"
        />
      );
    default:
      return null;
  }
}
