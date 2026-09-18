"use client";

import { Tooltip } from "./Tooltip";

export const CHANNEL_TYPE_HELP: Record<string, string> = {
  email: "Sent via the engine's configured SMTP_* settings.",
  webhook: "Generic POST — works for Discord/Slack/ntfy/Telegram-shaped webhook URLs.",
  web_push: "Delivers to every browser subscribed via this dashboard's \"Enable push notifications\" button. No config needed.",
  sms: "Not yet wired to a provider (see spec.md deferred items) — saving this channel is a no-op until one is.",
};

export function defaultChannelConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "email":
      return { to: "" };
    case "webhook":
      return { url: "", bodyTemplate: "" };
    case "sms":
      return { to: "" };
    default:
      return {};
  }
}

export function normalizeChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === "" || value == null) continue;
    out[key] = value;
  }
  return out;
}

export function validateChannelConfig(type: string, config: Record<string, unknown>): string | null {
  if ((type === "email" || type === "sms") && !config.to) return "\"to\" is required.";
  if (type === "webhook" && !config.url) return "\"url\" is required.";
  return null;
}

export function ChannelConfigFields({
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

  if (type === "email") {
    return (
      <input
        placeholder="you@example.com"
        value={str("to")}
        onChange={(e) => set("to", e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
      />
    );
  }
  if (type === "sms") {
    return (
      <input
        placeholder="+15555550100"
        value={str("to")}
        onChange={(e) => set("to", e.target.value)}
        className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
      />
    );
  }
  if (type === "webhook") {
    return (
      <div className="space-y-2">
        <input
          placeholder="https://discord.com/api/webhooks/..."
          value={str("url")}
          onChange={(e) => set("url", e.target.value)}
          className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
        />
        <label className="block">
          <span className="inline-flex items-center text-xs text-[var(--muted)]">
            Body template (optional)
            <Tooltip text={'JSON body posted to the webhook, with {{message}} replaced by the alert text. Leave blank for the default: {"content": "{{message}}"} (works for Discord).'} />
          </span>
          <input
            placeholder='{"content": "{{message}}"}'
            value={str("bodyTemplate")}
            onChange={(e) => set("bodyTemplate", e.target.value)}
            className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-xs outline-none"
          />
        </label>
      </div>
    );
  }
  return null; // web_push needs no config
}
