// Native chat channels. Each takes the rendered title/body; the shapes are
// each service's own incoming-message API.

import { own } from "../../lib/own.js";
const cfg = (config: unknown, key: string) => {
  const v = config && typeof config === "object" ? own(config as Record<string, unknown>, key) : undefined;
  return v == null ? "" : String(v).trim();
};

async function post(url: string, body: unknown, what: string) {
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`${what} rejected the message: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`);
}

// Bot API sendMessage as plain text — no parse_mode, so a check name with
// "_" or "*" in it can't break Markdown parsing and drop the alert.
export async function sendTelegram(config: unknown, title: string, body: string) {
  const token = cfg(config, "botToken");
  const chatId = cfg(config, "chatId");
  if (!token || !chatId) throw new Error("Telegram channel needs a bot token and a chat ID");
  const threadId = cfg(config, "threadId");
  await post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    { chat_id: chatId, text: `${title}\n\n${body}`.slice(0, 4000), disable_web_page_preview: true, ...(threadId ? { message_thread_id: Number(threadId) } : {}) },
    "Telegram"
  );
}

const slackEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Slack incoming webhook.
export async function sendSlack(config: unknown, title: string, body: string) {
  const url = cfg(config, "webhookUrl");
  if (!url) throw new Error("Slack channel needs an incoming webhook URL");
  await post(url, { text: `*${slackEscape(title)}*\n${slackEscape(body)}` }, "Slack");
}

// Microsoft Teams: a Workflows (Power Automate) "when a Teams webhook request
// is received" URL, which expects an Adaptive Card attachment. The retired
// Office 365 connector URLs accepted the same shape.
export async function sendTeams(config: unknown, title: string, body: string, opts: { url?: string; status?: string } = {}) {
  const url = cfg(config, "webhookUrl");
  if (!url) throw new Error("Teams channel needs a Workflows webhook URL");
  const color = opts.status === "UP" ? "Good" : opts.status === "WARN" ? "Warning" : "Attention";
  const card = {
    $schema: "http://adaptivecards.io/schemas/adaptive-card.json",
    type: "AdaptiveCard",
    version: "1.4",
    body: [
      { type: "TextBlock", text: title, weight: "Bolder", size: "Medium", wrap: true, color },
      ...body.split("\n\n").map((para) => ({ type: "TextBlock", text: para.replace(/\n/g, "\n\n"), wrap: true, spacing: "Small" })),
    ],
    ...(opts.url ? { actions: [{ type: "Action.OpenUrl", title: "Open in Looksee", url: opts.url }] } : {}),
  };
  await post(url, { type: "message", attachments: [{ contentType: "application/vnd.microsoft.card.adaptive", content: card }] }, "Teams");
}
