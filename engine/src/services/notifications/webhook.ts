// Generic POST — covers Discord/Slack (which both accept a JSON {content}-
// or {text}-shaped payload via an incoming webhook URL), ntfy (accepts a
// plain-text POST body), and Telegram (via its bot API's sendMessage
// endpoint, url-shaped the same way). The channel config's `url` and
// optional `bodyTemplate` are what differ per destination, not the code path.
export async function sendWebhook(config: unknown, message: string, vars: Record<string, unknown> = {}) {
  const url = typeof config === "object" && config && "url" in config ? String((config as { url: unknown }).url) : undefined;
  if (!url) throw new Error("Webhook channel config is missing 'url'");

  const bodyTemplate =
    typeof config === "object" && config && "bodyTemplate" in config
      ? String((config as { bodyTemplate: unknown }).bodyTemplate)
      : '{"content": "{{message}}"}';

  // JSON-string escaping (not just quotes) — a message with a newline or
  // backslash would otherwise produce an invalid body the receiver rejects.
  // {{message}} is the rendered alert body; any other alert variable
  // ({{title}}, {{check}}, {{status}}, {{url}}…) can be used too.
  const values: Record<string, unknown> = { ...vars, message };
  const body = bodyTemplate.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) => JSON.stringify(String(values[name] ?? "")).slice(1, -1));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status} ${res.statusText}`);
}
