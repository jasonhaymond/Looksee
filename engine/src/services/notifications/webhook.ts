// Generic POST — covers Discord/Slack (which both accept a JSON {content}-
// or {text}-shaped payload via an incoming webhook URL), ntfy (accepts a
// plain-text POST body), and Telegram (via its bot API's sendMessage
// endpoint, url-shaped the same way). The channel config's `url` and
// optional `bodyTemplate` are what differ per destination, not the code path.
export async function sendWebhook(config: unknown, message: string) {
  const url = typeof config === "object" && config && "url" in config ? String((config as { url: unknown }).url) : undefined;
  if (!url) throw new Error("Webhook channel config is missing 'url'");

  const bodyTemplate =
    typeof config === "object" && config && "bodyTemplate" in config
      ? String((config as { bodyTemplate: unknown }).bodyTemplate)
      : '{"content": "{{message}}"}';

  const body = bodyTemplate.replace("{{message}}", message.replace(/"/g, '\\"'));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  if (!res.ok) throw new Error(`Webhook POST failed: ${res.status} ${res.statusText}`);
}
