// Security: your account (password, recovery codes, moving to a new
// authenticator), signed-in sessions and phones with the app, sign-in
// safeguards (lockouts, session length, idle timeout, new-address email
// codes), IP access (allowlist, blocks, trusted addresses), attack detection
// rules, and the security log.
//
// Two-factor sign-in can't be turned off here (or anywhere in the app); the
// only bypass is a command on the server. Changing the password, making new
// recovery codes and moving the authenticator all need a current code.

import { useCallback, useState } from "react";
import { Linking, View } from "react-native";
import { Stack } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, type SecurityRule, type SecuritySettings } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { useSession } from "../../lib/session";
import { dateTime, errorText, relativeTime } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import { Button, ButtonRow, Card, Chip, Chips, Empty, ErrorBox, Field, KeyValue, Loading, Note, Row, Screen, Select, T, Toggle, confirm, tell } from "../../components/ui";
import { usePrompt } from "../../components/Prompt";

export default function Security() {
  const { colors } = useTheme();
  const session = useSession();
  const [prompt, ask] = usePrompt();
  const [hours, setHours] = useState(24);
  const load = useCallback(async () => {
    const [overview, sessions, devices, blocks, trusted, rules, events, channels] = await Promise.all([
      api.securityOverview(),
      api.sessions(),
      api.appDevices(),
      api.ipBlocks(),
      api.trustedIps(),
      api.securityRules(),
      api.securityEvents({ hours, limit: 100 }),
      api.channels(),
    ]);
    return { overview, sessions, devices, blocks, trusted, rules, events, channels };
  }, [hours]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 60);
  const [pw, setPw] = useState({ current: "", next: "", code: "" });
  const [codes, setCodes] = useState<string[] | null>(null);
  const [rotate, setRotate] = useState<{ challengeId: string; secret: string; uri: string } | null>(null);
  const [allowText, setAllowText] = useState<string | null>(null);
  const [rule, setRule] = useState<Partial<SecurityRule> | null>(null);

  /** Runs an action, reports errors, reloads. */
  const act = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) tell(done);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  };
  const saveSettings = (patch: Partial<SecuritySettings>) => act(() => api.updateSecuritySettings(patch));

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const s = data.overview.settings;
  const kindLabel = new Map(data.overview.kinds.map((k) => [k.kind, k.label]));

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Security" }} />
      <ErrorBox error={error} />

      <Card title="Your account">
        <T size="s">Two-factor: <T size="s" bold color={colors.up}>on (required)</T> · {data.overview.recoveryCodesLeft} recovery code(s) left</T>
        <T size="s" muted>Password last changed: {data.overview.passwordChangedAt ? dateTime(data.overview.passwordChangedAt) : "never (set at install)"}</T>
        <ButtonRow>
          <Button small title="New recovery codes" onPress={async () => {
            const code = await ask({ title: "New recovery codes", label: "Current authenticator code", numeric: true, message: "Your old recovery codes stop working." });
            if (code) void act(async () => setCodes((await api.regenerateRecoveryCodes(code.trim())).recoveryCodes));
          }} />
          <Button small title="Move to a new authenticator" onPress={async () => {
            const code = await ask({ title: "New authenticator", label: "Code from your current authenticator", numeric: true });
            if (code) void act(async () => setRotate(await api.rotateTotp(code.trim())));
          }} />
        </ButtonRow>
        {codes ? (
          <Note tone="warn">
            <T size="s">Save these now; they can't be shown again. Each works once.</T>
            <T selectable style={{ fontFamily: "monospace", marginVertical: 6 }}>{codes.join("\n")}</T>
            <ButtonRow>
              <Button small title="Copy" onPress={() => void Clipboard.setStringAsync(codes.join("\n"))} />
              <Button small variant="primary" title="I've saved them" onPress={() => setCodes(null)} />
            </ButtonRow>
          </Note>
        ) : null}
        {rotate ? (
          <Note>
            <T size="s">Add this key to the new authenticator, then enter its code. The old one keeps working until you confirm.</T>
            <T selectable style={{ fontFamily: "monospace", marginVertical: 6 }}>{rotate.secret.replace(/(.{4})/g, "$1 ").trim()}</T>
            <ButtonRow>
              <Button small title="Open in authenticator app" onPress={() => void Linking.openURL(rotate.uri).catch(() => tell("No authenticator app handles the link", "Type the key in instead."))} />
              <Button small variant="primary" title="Enter the new code" onPress={async () => {
                const code = await ask({ title: "Confirm", label: "Code from the NEW authenticator", numeric: true });
                if (code) void act(async () => {
                  await api.confirmRotateTotp(rotate.challengeId, code.trim());
                  setRotate(null);
                }, "Moved to the new authenticator.");
              }} />
            </ButtonRow>
          </Note>
        ) : null}
        <T bold>Change password</T>
        <Field label="Current password" value={pw.current} onChangeText={(t) => setPw({ ...pw, current: t })} secureTextEntry />
        <Field label={`New password (${s.minPasswordLength}+ characters)`} value={pw.next} onChangeText={(t) => setPw({ ...pw, next: t })} secureTextEntry />
        <Field label="Authenticator code" value={pw.code} onChangeText={(t) => setPw({ ...pw, code: t })} keyboardType="number-pad" />
        <Button small variant="primary" title="Change password" disabled={!pw.current || !pw.next || !pw.code} onPress={() => act(async () => {
          await api.changePassword({ currentPassword: pw.current, newPassword: pw.next, code: pw.code.trim() });
          setPw({ current: "", next: "", code: "" });
        }, "Password changed. Every other session was signed out.")} />
      </Card>

      <Card title="Signed-in sessions" action={<Button small title="Sign out others" onPress={() => confirm("Sign out every other session?", "Browsers and other phones must sign in again. Their alerts keep arriving.", () => void act(() => api.revokeSession("others")), "Sign out others")} />}>
        {data.sessions.map((x) => (
          <Row key={x.id} title={x.userAgent ?? "Unknown browser"} subtitle={`${x.ip ?? "—"} · signed in ${dateTime(x.createdAt)} · active ${relativeTime(x.lastSeenAt)}`} right={x.current ? <T size="s" color={colors.up}>this app</T> : <Button small title="Sign out" onPress={() => act(() => api.revokeSession(x.id))} />} />
        ))}
      </Card>

      <Card title="Phones with the Looksee app">
        {data.devices.length === 0 ? <Empty>None.</Empty> : data.devices.map((d) => (
          <Row key={d.id} title={`${d.name}${d.id === session.deviceId ? " (this phone)" : ""}`} subtitle={[d.connected ? "connected now" : `last connected ${relativeTime(d.lastConnectedAt)}`, d.appVersion && `app ${d.appVersion}`, d.platform, d.lastIp].filter(Boolean).join(" · ")} right={
            <Button small variant="danger" title="Remove" onPress={() => confirm(`Remove "${d.name}"?`, "It stops receiving notifications at once. Sign out its session separately above.", () => void act(() => api.removeAppDevice(d.id)), "Remove")} />
          } />
        ))}
      </Card>

      <Card title="Sign-in safeguards">
        <Toggle label="Email a code for sign-ins from a new address" value={s.newIpConfirmation} onChange={(v) => saveSettings({ newIpConfirmation: v })} />
        <SettingNumber label="Lock out after failed sign-ins" value={s.lockoutThreshold} onSave={(n) => n != null && saveSettings({ lockoutThreshold: n })} />
        <SettingNumber label="Lockout length (minutes)" value={s.lockoutMinutes} onSave={(n) => n != null && saveSettings({ lockoutMinutes: n })} />
        <SettingNumber label="Session length (hours)" value={s.sessionHours} onSave={(n) => n != null && saveSettings({ sessionHours: n })} />
        <SettingNumber label="Sign out after idle (minutes, blank = never)" value={s.idleTimeoutMinutes} onSave={(n) => saveSettings({ idleTimeoutMinutes: n })} allowBlank />
        <SettingNumber label="Minimum password length" value={s.minPasswordLength} onSave={(n) => n != null && saveSettings({ minPasswordLength: n })} />
      </Card>

      <Card title="IP access">
        <KeyValue label="Your address" value={data.overview.yourIp} mono />
        <Toggle label="Only allow addresses on the allowlist" help="Turning this on from an address not on the list would lock this phone out." value={s.allowlistEnabled} onChange={(v) => confirm(v ? "Turn on the allowlist?" : "Turn off the allowlist?", v ? `Only the listed addresses can reach Looksee. Make sure ${data.overview.yourIp} (or its range) is on it.` : "Every address can reach the sign-in page again.", () => void saveSettings({ allowlistEnabled: v }), v ? "Turn on" : "Turn off")} />
        <Toggle label="Also apply it to agents" value={s.allowlistAgents} onChange={(v) => saveSettings({ allowlistAgents: v })} />
        {allowText === null ? (
          <ButtonRow>
            <T size="s" style={{ flex: 1 }}>{s.allowlist.length ? s.allowlist.join(", ") : "Allowlist is empty."}</T>
            <Button small title="Edit list" onPress={() => setAllowText(s.allowlist.join("\n"))} />
          </ButtonRow>
        ) : (
          <>
            <Field label="Allowlist (one address or CIDR per line)" value={allowText} onChangeText={setAllowText} multiline autoCapitalize="none" />
            <ButtonRow>
              <Button small title="Cancel" onPress={() => setAllowText(null)} />
              <Button small variant="primary" title="Save list" onPress={() => act(async () => {
                await api.updateSecuritySettings({ allowlist: allowText.split(/[\s,]+/).filter(Boolean) });
                setAllowText(null);
              })} />
            </ButtonRow>
          </>
        )}
        <T bold>Blocked</T>
        {data.blocks.length === 0 ? <Empty>No blocked addresses.</Empty> : data.blocks.map((b) => (
          <Row key={b.id} title={b.ip} subtitle={`${b.reason ?? ""}${b.until ? ` · until ${dateTime(b.until)}` : " · until removed"}`} right={<Button small title="Unblock" onPress={() => act(() => api.unblockIp(b.id))} />} />
        ))}
        <Button small title="Block an address…" onPress={async () => {
          const ip = await ask({ title: "Block an address", label: "IP or CIDR" });
          if (!ip?.trim()) return;
          const minutes = await ask({ title: "For how long?", label: "Minutes (blank = until removed)", numeric: true });
          if (minutes === null) return;
          void act(() => api.blockIp({ ip: ip.trim(), minutes: minutes ? Number(minutes) : null, reason: "Blocked from the Android app" }));
        }} />
        <T bold>Trusted (signed in from before)</T>
        {data.trusted.map((t) => <Row key={t.id} title={t.ip} subtitle={`last ${relativeTime(t.lastSeenAt)}`} right={<Button small title="Forget" onPress={() => act(() => api.forgetTrustedIp(t.id))} />} />)}
      </Card>

      <Card title="Attack detection" action={<Button small icon="add" title="Rule" onPress={() => setRule({ name: "", kinds: [], threshold: 5, windowMinutes: 10, perIp: true, notify: true, blockMinutes: 60, cooldownMinutes: 60 })} />}>
        <Toggle label="Count scanner probes (/.env, /wp-login.php…)" value={s.detectScans} onChange={(v) => saveSettings({ detectScans: v })} />
        <Select multi label="Also notify these channels" value={s.notifyChannelIds} onChange={(v) => saveSettings({ notifyChannelIds: v })} options={data.channels.filter((c) => c.type !== "email").map((c) => ({ value: c.id, label: c.name }))} placeholder="Email only" help={`Security notices are emailed to ${s.notifyEmail ?? "the admin's address"}.`} />
        {rule ? (
          <View style={{ gap: 8 }}>
            <Field label="Rule name" value={rule.name ?? ""} onChangeText={(t) => setRule({ ...rule, name: t })} />
            <Select multi label="Counts these events" value={rule.kinds ?? []} onChange={(v) => setRule({ ...rule, kinds: v })} options={data.overview.kinds.map((k) => ({ value: k.kind, label: k.label }))} />
            <Field label="When this many happen…" value={String(rule.threshold ?? "")} onChangeText={(t) => setRule({ ...rule, threshold: Number(t) })} keyboardType="number-pad" />
            <Field label="…within (minutes)" value={String(rule.windowMinutes ?? "")} onChangeText={(t) => setRule({ ...rule, windowMinutes: Number(t) })} keyboardType="number-pad" />
            <Toggle label="Count per address" value={rule.perIp ?? true} onChange={(v) => setRule({ ...rule, perIp: v })} />
            <Toggle label="Notify" value={rule.notify ?? true} onChange={(v) => setRule({ ...rule, notify: v })} />
            <Field label="Block the address for (minutes, blank = don't block)" value={rule.blockMinutes ? String(rule.blockMinutes) : ""} onChangeText={(t) => setRule({ ...rule, blockMinutes: t ? Number(t) : null })} keyboardType="number-pad" />
            <Field label="Then wait (minutes) before firing again" value={String(rule.cooldownMinutes ?? 0)} onChangeText={(t) => setRule({ ...rule, cooldownMinutes: Number(t) })} keyboardType="number-pad" />
            <ButtonRow>
              <Button small title="Cancel" onPress={() => setRule(null)} />
              <Button small variant="primary" title="Save rule" onPress={() => act(async () => {
                if (rule.id) await api.updateSecurityRule(rule.id, rule);
                else await api.createSecurityRule(rule);
                setRule(null);
              })} />
            </ButtonRow>
          </View>
        ) : null}
        {data.rules.map((r) => (
          <View key={r.id} style={{ gap: 4 }}>
            <Toggle label={r.name} help={`${r.threshold}× ${r.kinds.map((k) => kindLabel.get(k) ?? k).join(" / ")} in ${r.windowMinutes} min${r.perIp ? " from one address" : ""} → ${[r.notify ? "notify" : null, r.blockMinutes ? `block ${r.blockMinutes} min` : null].filter(Boolean).join(", ") || "nothing"}${r.lastFiredAt ? ` · last fired ${relativeTime(r.lastFiredAt)}` : ""}`} value={r.enabled} onChange={(enabled) => act(() => api.updateSecurityRule(r.id, { enabled }))} />
            <ButtonRow>
              <Button small title="Edit" onPress={() => setRule(r)} />
              <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete rule "${r.name}"?`, "", () => void act(() => api.deleteSecurityRule(r.id)))} />
            </ButtonRow>
          </View>
        ))}
        <Button small title="Send a test security notice" onPress={() => act(() => api.testSecurityNotification(), "Sent")} />
      </Card>

      <Card title="Security log">
        <Chips>
          {[1, 24, 168].map((h) => <Chip key={h} label={h === 1 ? "1 h" : h === 24 ? "24 h" : "7 d"} on={hours === h} onPress={() => setHours(h)} />)}
        </Chips>
        {data.events.length === 0 ? <Empty>Nothing recorded.</Empty> : data.events.map((e) => (
          <Row key={e.id} title={kindLabel.get(e.kind) ?? e.kind} subtitle={[dateTime(e.createdAt), e.ip, e.detail].filter(Boolean).join(" · ")} left={<T size="s" bold color={e.severity === "critical" ? colors.down : e.severity === "warn" ? colors.warn : colors.muted} style={{ width: 40 }}>{e.severity.toUpperCase().slice(0, 4)}</T>} />
        ))}
      </Card>
      {prompt}
    </Screen>
  );
}

/** A number setting with its own Save button (blank allowed when allowBlank). */
function SettingNumber({ label, value, onSave, allowBlank }: { label: string; value: number | null; onSave: (n: number | null) => void; allowBlank?: boolean }) {
  const [text, setText] = useState(value == null ? "" : String(value));
  const changed = text !== (value == null ? "" : String(value));
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-end", gap: 8 }}>
      <View style={{ flex: 1 }}>
        <Field label={label} value={text} onChangeText={setText} keyboardType="number-pad" />
      </View>
      {changed ? <Button small variant="primary" title="Save" disabled={!text && !allowBlank} onPress={() => onSave(text ? Number(text) : null)} /> : null}
    </View>
  );
}
