"use client";

import { Label, inputClass } from "./ui";

export const CHANNEL_TYPE_LABEL: Record<string, string> = {
  email: "Email",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  webhook: "Webhook (Discord, ntfy, anything)",
  web_push: "Browser / phone push",
  sms: "SMS (not wired to a provider yet)",
};

export const CHANNEL_TYPE_HELP: Record<string, string> = {
  email: "Sent through the SMTP server above.",
  webhook: "A generic JSON POST — Discord, ntfy, Gotify, Home Assistant, or your own endpoint.",
  web_push: "Delivers to every browser subscribed via this dashboard's \"Enable push notifications\" button. No config needed.",
  sms: "Not yet wired to a provider (see spec.md deferred items) — saving this channel is a no-op until one is.",
  slack: "Posts to a Slack channel through an incoming webhook.",
  teams: "Posts an Adaptive Card to a Teams channel through a Workflows webhook.",
  telegram: "Sends a message from your own Telegram bot to a chat, group or channel.",
};

// Step-by-step setup shown under the fields for each type.
const SETUP: Record<string, string[]> = {
  slack: ["In Slack: Apps → search “Incoming Webhooks” → Add to Slack (or create an app at api.slack.com/apps → Incoming Webhooks → On).", "Pick the channel, then copy the Webhook URL (https://hooks.slack.com/services/…) into the field above."],
  teams: [
    "In the Teams channel: ••• → Workflows → “Post to a channel when a webhook request is received”.",
    "Name it, pick the team and channel, then copy the URL it gives you into the field above.",
    "(The old “Incoming Webhook” connector URLs also work while Microsoft still accepts them.)",
  ],
  telegram: [
    "Message @BotFather in Telegram: /newbot → copy the bot token it gives you.",
    "Add the bot to your group/channel (or send it a message directly).",
    "Get the chat ID: open https://api.telegram.org/bot<token>/getUpdates after messaging the bot — it's the \"chat\":{\"id\":…} number (groups start with -100).",
  ],
  webhook: ["Paste the service's webhook URL. The body is JSON; {{message}} becomes the alert text, and {{title}}, {{check}}, {{status}}, {{url}} are available too.", 'Discord (default body): {"content": "{{message}}"} · ntfy: post to https://ntfy.sh/your-topic with body {{message}}.'],
};

export function defaultChannelConfigFor(type: string): Record<string, unknown> {
  switch (type) {
    case "email":
    case "sms":
      return { to: "" };
    case "webhook":
      return { url: "", bodyTemplate: "" };
    case "slack":
    case "teams":
      return { webhookUrl: "" };
    case "telegram":
      return { botToken: "", chatId: "", threadId: "" };
    default:
      return {};
  }
}

export function normalizeChannelConfig(config: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (value === "" || value == null) continue;
    out[key] = typeof value === "string" ? value.trim() : value;
  }
  return out;
}

export function validateChannelConfig(type: string, config: Record<string, unknown>): string | null {
  if ((type === "email" || type === "sms") && !config.to) return "Enter who to send to.";
  if (type === "webhook" && !config.url) return "Enter the webhook URL.";
  if ((type === "slack" || type === "teams") && !/^https:\/\//.test(String(config.webhookUrl ?? ""))) return "Enter the https:// webhook URL.";
  if (type === "telegram" && (!config.botToken || !config.chatId)) return "Enter the bot token and chat ID.";
  return null;
}

export function ChannelConfigFields({ type, config, onChange }: { type: string; config: Record<string, unknown>; onChange: (config: Record<string, unknown>) => void }) {
  const str = (key: string) => (config[key] != null ? String(config[key]) : "");
  const set = (key: string, value: string) => onChange({ ...config, [key]: value });
  const text = (key: string, label: string, placeholder?: string, secret = false, mono = false) => (
    <Label label={label}>
      <input type={secret ? "password" : "text"} autoComplete="off" placeholder={placeholder} value={str(key)} onChange={(e) => set(key, e.target.value)} className={`${inputClass} ${mono ? "font-mono text-xs" : ""}`} />
    </Label>
  );
  const setup = SETUP[type];
  return (
    <div className="space-y-2">
      {type === "email" && text("to", "Send to", "you@example.com, someone@example.com")}
      {type === "sms" && text("to", "Phone number", "+15555550100")}
      {type === "webhook" && (
        <>
          {text("url", "Webhook URL", "https://discord.com/api/webhooks/…")}
          {text("bodyTemplate", "JSON body (optional)", '{"content": "{{message}}"}', false, true)}
        </>
      )}
      {(type === "slack" || type === "teams") && text("webhookUrl", "Webhook URL", type === "slack" ? "https://hooks.slack.com/services/…" : "https://….logic.azure.com/workflows/…", true)}
      {type === "telegram" && (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <div className="sm:col-span-3">{text("botToken", "Bot token", "123456:ABC-DEF…", true)}</div>
          {text("chatId", "Chat ID", "-1001234567890")}
          {text("threadId", "Topic ID (optional)", "for forum groups")}
        </div>
      )}
      {setup && (
        <details className="rounded-md bg-[var(--code-bg)] p-2 text-xs">
          <summary className="cursor-pointer text-[var(--muted)]">How to set this up</summary>
          <ol className="mt-1 list-decimal space-y-1 pl-4">
            {setup.map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
        </details>
      )}
    </div>
  );
}
