// Create or edit a notification channel: its type, name, delivery settings
// (recipient, webhook URL, bot token…; Notifications has none) and optional
// message templates per event (triggered, resolved, reminder, escalated).
// Params: id (edit), or nothing (create).
//
// Security: delivery settings are secrets and write-only. The engine never
// returns them, so editing a saved channel starts with empty fields and
// "Replace settings" overwrites them; leaving them untouched keeps them.

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, own, type Channel, type ChannelTemplate, type TemplateInfo } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Note, Screen, Select, T, Toggle } from "../../../components/ui";

export const CHANNEL_LABEL: Record<string, string> = {
  email: "Email",
  slack: "Slack",
  teams: "Microsoft Teams",
  telegram: "Telegram",
  webhook: "Webhook (Discord, ntfy, anything)",
  web_push: "Notifications (this app and browsers)",
  sms: "SMS (not wired to a provider yet)",
};

/** The settings each type needs: [key, label, placeholder, secret]. */
const FIELDS: Record<string, [string, string, string, boolean][]> = {
  email: [["to", "Send to", "you@example.com, someone@example.com", false]],
  sms: [["to", "Phone number", "+15555550100", false]],
  webhook: [["url", "Webhook URL", "https://discord.com/api/webhooks/…", true], ["bodyTemplate", "JSON body (optional)", '{"content": "{{message}}"}', false]],
  slack: [["webhookUrl", "Webhook URL", "https://hooks.slack.com/services/…", true]],
  teams: [["webhookUrl", "Webhook URL", "https://….logic.azure.com/workflows/…", true]],
  telegram: [["botToken", "Bot token", "123456:ABC-DEF…", true], ["chatId", "Chat ID", "-1001234567890", false], ["threadId", "Topic ID (optional)", "for forum groups", false]],
};

export default function ChannelEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const load = useCallback(async () => {
    const [channels, templates] = await Promise.all([api.channels(), api.channelTemplates()]);
    return { channel: channels.find((c) => c.id === id) ?? null, templates };
  }, [id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form {...data} />;
}

function Form({ channel, templates }: { channel: Channel | null; templates: TemplateInfo }) {
  const [type, setType] = useState(channel?.type ?? "web_push");
  const [name, setName] = useState(channel?.name ?? "");
  const [config, setConfig] = useState<Record<string, string>>({});
  const [replace, setReplace] = useState(!channel);
  const [tpl, setTpl] = useState<Record<string, ChannelTemplate>>(channel?.templates ?? {});
  const [showTpl, setShowTpl] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    setErr(null);
    if (!name.trim()) return setErr("Name is required.");
    // Only non-empty values are sent; settings are replaced as a whole.
    const cfg: Record<string, unknown> = Object.fromEntries(Object.entries(config).map(([k, v]) => [k, v.trim()]).filter(([, v]) => v));
    if (replace && type !== "web_push") {
      if ((type === "email" || type === "sms") && !cfg.to) return setErr("Enter who to send to.");
      if (type === "webhook" && !cfg.url) return setErr("Enter the webhook URL.");
      if ((type === "slack" || type === "teams") && !/^https:\/\//.test(String(cfg.webhookUrl ?? ""))) return setErr("Enter the https:// webhook URL.");
      if (type === "telegram" && (!cfg.botToken || !cfg.chatId)) return setErr("Enter the bot token and chat ID.");
    }
    setBusy(true);
    try {
      if (channel) await api.updateChannel(channel.id, { name: name.trim(), templates: tpl, ...(replace && type !== "web_push" ? { config: cfg } : {}) });
      else await api.createChannel({ name: name.trim(), type, config: cfg, templates: tpl });
      router.back();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: channel ? `Edit: ${channel.name}` : "New channel" }} />
      <Card>
        {channel ? <T muted size="s">{own(CHANNEL_LABEL, type) ?? type}</T> : <Select label="Type" value={type} onChange={setType} options={Object.entries(CHANNEL_LABEL).map(([value, label]) => ({ value, label }))} />}
        <Field label="Name *" value={name} onChangeText={setName} placeholder={type === "web_push" ? "Notifications" : "Ops Slack"} />
        {type === "web_push" ? (
          <Note>Goes to every phone signed in to this app and every browser where push is turned on in the dashboard ("Enable push"), including ones added later. Nothing to set here.</Note>
        ) : (
          <>
            {channel ? <Toggle label="Replace delivery settings" help="Saved settings are secret and never shown. Turn on to type new ones; off keeps them." value={replace} onChange={setReplace} /> : null}
            {replace ? (own(FIELDS, type) ?? []).map(([key, label, placeholder, secret]) => (
              <Field key={key} label={label} value={own(config, key) ?? ""} onChangeText={(t) => setConfig((c) => ({ ...c, [key]: t }))} placeholder={placeholder} secureTextEntry={secret} autoCapitalize="none" autoCorrect={false} />
            )) : null}
          </>
        )}
      </Card>
      <Card title="Message templates" action={<Button small title={showTpl ? "Hide" : "Edit"} onPress={() => setShowTpl(!showTpl)} />}>
        {showTpl ? (
          <View style={{ gap: 10 }}>
            <T size="s" muted>Leave blank for the default. Variables: {templates.variables.map((v) => `{{${v.name}}}`).join(" ")}</T>
            {templates.events.map((ev) => (
              <View key={ev} style={{ gap: 6 }}>
                <T bold>{ev}</T>
                <Field label="Title" value={own(tpl, ev)?.title ?? ""} onChangeText={(t) => setTpl((x) => ({ ...x, [ev]: { ...own(x, ev), title: t } }))} placeholder={own(templates.defaults, ev)?.title} autoCapitalize="none" />
                <Field label="Body" value={own(tpl, ev)?.body ?? ""} onChangeText={(t) => setTpl((x) => ({ ...x, [ev]: { ...own(x, ev), body: t } }))} placeholder={own(templates.defaults, ev)?.body} multiline autoCapitalize="none" />
              </View>
            ))}
          </View>
        ) : (
          <T size="s" muted>{Object.values(tpl).some((t) => t.title || t.body) ? "Custom templates in use." : "Using the default messages."}</T>
        )}
      </Card>
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={channel ? "Save" : "Create channel"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
