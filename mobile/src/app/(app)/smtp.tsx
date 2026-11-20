// The email server Looksee sends through (alerts, security notices, sign-in
// codes): host, port, user, sender address and password. The password is
// write-only: it's never shown, and leaving the field blank keeps it.

import { useCallback, useState } from "react";
import { Stack } from "expo-router";
import { api, type SmtpSettings } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { errorText } from "../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Screen, T, tell } from "../../components/ui";
import { usePrompt } from "../../components/Prompt";

export default function Smtp() {
  const load = useCallback(() => api.smtpSettings(), []);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form settings={data.settings} />;
}

/** The form, created once the settings have loaded (its starting values come from them). */
function Form({ settings: s }: { settings: SmtpSettings }) {
  const [prompt, ask] = usePrompt();
  const [form, setForm] = useState({ host: s.host ?? "", port: s.port ? String(s.port) : "", user: s.user ?? "", from: s.from ?? "", password: "" });
  return (
    <Screen>
      <Stack.Screen options={{ title: "Email server (SMTP)" }} />
      <Card>
        <Field label="Host" value={form.host} onChangeText={(t) => setForm({ ...form, host: t })} autoCapitalize="none" placeholder="smtp.example.com" />
        <Field label="Port" value={form.port} onChangeText={(t) => setForm({ ...form, port: t })} keyboardType="number-pad" placeholder="587" />
        <Field label="User" value={form.user} onChangeText={(t) => setForm({ ...form, user: t })} autoCapitalize="none" />
        <Field label="Send from" value={form.from} onChangeText={(t) => setForm({ ...form, from: t })} autoCapitalize="none" keyboardType="email-address" placeholder="looksee@example.com" />
        <Field label={`Password (${s.passwordSet ? "saved; blank keeps it" : "not set"})`} value={form.password} onChangeText={(t) => setForm({ ...form, password: t })} secureTextEntry />
        <T size="s" muted>Settings here override the engine's .env values.</T>
        <ButtonRow>
          <Button variant="primary" title="Save" onPress={async () => {
            try {
              await api.updateSmtpSettings({ host: form.host.trim() || null, port: form.port ? Number(form.port) : null, user: form.user.trim() || null, from: form.from.trim() || null, ...(form.password ? { password: form.password } : {}) });
              setForm({ ...form, password: "" });
              tell("Saved");
            } catch (err) {
              tell("Not saved", errorText(err));
            }
          }} />
          <Button title="Send a test email" onPress={async () => {
            const to = await ask({ title: "Test email", label: "Send to" });
            if (!to) return;
            try {
              await api.sendTestEmail(to.trim());
              tell("Sent", `Check ${to.trim()}.`);
            } catch (err) {
              tell("Not sent", errorText(err));
            }
          }} />
        </ButtonRow>
      </Card>
      {prompt}
    </Screen>
  );
}
