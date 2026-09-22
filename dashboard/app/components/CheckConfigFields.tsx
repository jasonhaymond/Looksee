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
  agent_service: "Service (via agent)",
  agent_process: "Process (via agent)",
};

export const CHECK_TYPE_HELP: Record<string, string> = {
  ping: "Sends an ICMP ping to a host or IP and checks for a reply. Good for \"is this device on the network.\"",
  tcp: "Opens a TCP connection to a host:port and checks it succeeds. Good for databases, SSH, or any non-HTTP service.",
  http: "Requests a URL (http:// or https://) and checks the response status. The most common check for websites and APIs.",
  dns: "Resolves a hostname and checks it succeeds. Good for verifying a DNS server (e.g. Pi-hole) is actually answering.",
  ssl_cert: "Connects over TLS and checks how many days remain before the certificate expires, warning before it's too late to renew.",
  agent_service: "Asks the Looksee agent on a specific host whether a named OS service is active (systemctl on Linux, the service manager on Windows) — a real service-manager check, not just \"is some process running.\" Requires the agent installed on that host — see Hosts.",
  agent_process: "Asks the Looksee agent on a specific host whether a process matching this name is currently running, matched by substring — e.g. \"nginx\" matches both nginx and nginx.exe. Requires the agent installed on that host — see Hosts.",
};

export function defaultConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "ping":
      return { host: "" };
    case "tcp":
      return { host: "", port: "" };
    case "http":
      return { url: "", expectedStatus: "", method: "GET", headers: "", insecureSkipVerify: false, bodyContains: "" };
    case "dns":
      return { hostname: "" };
    case "ssl_cert":
      return { host: "", port: 443, warnDays: 14 };
    case "agent_service":
    case "agent_process":
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
    agent_process: ["serviceName"],
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
  suggestions,
}: {
  label: string;
  tooltip: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: "text" | "number";
  // Native <datalist> — offers real names without forcing one; free text
  // still works even with zero suggestions (host hasn't reported yet, or
  // reported an empty list).
  suggestions?: string[];
}) {
  const listId = suggestions ? `${label.replace(/\s+/g, "-").toLowerCase()}-suggestions` : undefined;
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
        list={listId}
        className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm outline-none"
      />
      {listId && (
        <datalist id={listId}>
          {(suggestions ?? []).map((s) => (
            <option key={s} value={s} />
          ))}
        </datalist>
      )}
    </label>
  );
}

function TextareaField({ label, tooltip, value, onChange, placeholder }: { label: string; tooltip: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <label className="block">
      <span className="inline-flex items-center text-[var(--muted)]">
        {label}
        <Tooltip text={tooltip} />
      </span>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
        className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-xs outline-none"
      />
    </label>
  );
}

function SelectField({ label, tooltip, value, onChange, options }: { label: string; tooltip: string; value: string; onChange: (v: string) => void; options: string[] }) {
  return (
    <label className="block">
      <span className="inline-flex items-center text-[var(--muted)]">
        {label}
        <Tooltip text={tooltip} />
      </span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </label>
  );
}

function CheckboxField({ label, tooltip, checked, onChange }: { label: string; tooltip: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-1.5 text-[var(--muted)]">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
      <Tooltip text={tooltip} />
    </label>
  );
}

export function CheckConfigFields({
  type,
  config,
  onChange,
  suggestions,
}: {
  type: string;
  config: Record<string, unknown>;
  onChange: (config: Record<string, unknown>) => void;
  // Real names discovered by the agent on the selected host, for
  // agent_service/agent_process's datalist. Undefined (no host selected
  // yet, or a non-agent type) just means no suggestions.
  suggestions?: string[];
}) {
  const str = (key: string) => (config[key] != null ? String(config[key]) : "");
  const set = (key: string, value: string) => onChange({ ...config, [key]: value });
  const setBool = (key: string, value: boolean) => onChange({ ...config, [key]: value });

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
          <div className="grid grid-cols-2 gap-2">
            <SelectField
              label="Method"
              tooltip="HTTP method to use. GET fits nearly every health-check endpoint; the others exist for APIs that specifically require them."
              value={str("method") || "GET"}
              onChange={(v) => set("method", v)}
              options={["GET", "POST", "HEAD", "PUT"]}
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
          <TextareaField
            label="Extra headers (optional)"
            tooltip={'One "Name: value" per line — e.g. an Authorization header for an endpoint that requires one.'}
            value={str("headers")}
            onChange={(v) => set("headers", v)}
            placeholder={"Authorization: Bearer ...\nX-Api-Key: ..."}
          />
          <Field
            label="Response must contain (optional)"
            tooltip="Checked in addition to the status code — the check only passes if this exact text appears somewhere in the response body. Useful for endpoints that return 200 even when something's actually wrong."
            value={str("bodyContains")}
            onChange={(v) => set("bodyContains", v)}
            placeholder={'e.g. "status": "ok"'}
          />
          <CheckboxField
            label="Skip TLS certificate verification"
            tooltip="For self-signed or internal HTTPS endpoints only — this weakens security by not verifying the certificate is trustworthy. Leave off for anything public-facing."
            checked={Boolean(config.insecureSkipVerify)}
            onChange={(v) => setBool("insecureSkipVerify", v)}
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
          tooltip="The exact name of a registered OS service (a systemd unit on Linux, a Windows service). Pick a host first to see real names discovered from it."
          value={str("serviceName")}
          onChange={(v) => set("serviceName", v)}
          placeholder="caddy"
          suggestions={suggestions}
        />
      );
    case "agent_process":
      return (
        <Field
          label="Process name"
          tooltip={'Process name to look for, matched by substring — e.g. "nginx" matches both nginx and nginx.exe. Pick a host first to see real names discovered from it.'}
          value={str("serviceName")}
          onChange={(v) => set("serviceName", v)}
          placeholder="nginx"
          suggestions={suggestions}
        />
      );
    default:
      return null;
  }
}
