// This app's settings: notifications on this phone (connection status,
// Android's notification permission, battery-saving exemption, a test
// notification, this phone's name, and the notifications it received), the
// light/dark theme, the signed-in account with Sign out, and version numbers.
// Notification taps that report a connection problem open this screen
// (looksee://settings).

import { useCallback, useState } from "react";
import { PermissionsAndroid, Platform, View } from "react-native";
import { Stack } from "expo-router";
import Constants from "expo-constants";
import * as Stream from "../../../modules/looksee-stream";
import { api } from "../../lib/shared";
import { useSession } from "../../lib/session";
import { useTheme, type ThemeChoice } from "../../lib/theme";
import { useLoad } from "../../lib/useLoad";
import { useStreamStatus } from "../../lib/useStreamStatus";
import { dateTime, errorText, relativeTime } from "../../lib/format";
import { Button, ButtonRow, Card, Chip, Chips, Empty, ErrorBox, KeyValue, Note, Row, Screen, StatusBadge, T, confirm, tell } from "../../components/ui";
import { usePrompt } from "../../components/Prompt";

/** Whether Android lets this app show notifications (Android 13+ asks the user). */
async function notificationsAllowed() {
  if (Platform.OS !== "android" || Number(Platform.Version) < 33) return true;
  return PermissionsAndroid.check(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
}

export default function Settings() {
  const session = useSession();
  const { choice, setChoice } = useTheme();
  const stream = useStreamStatus();
  const [prompt, ask] = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [health, devices, allowed] = await Promise.all([api.health().catch(() => null), api.appDevices().catch(() => []), notificationsAllowed()]);
    const device = devices.find((d) => d.id === session.deviceId) ?? null;
    const history = device ? await api.appDeviceNotifications(device.id).catch(() => []) : [];
    return { health, device, history, allowed, battery: Stream.isIgnoringBatteryOptimizations() };
  }, [session.deviceId]);
  const { data, error, refreshing, reload } = useLoad(load, 10);

  /** Runs a settings action with a busy indicator and an error message. */
  async function act(name: string, run: () => Promise<unknown>) {
    setBusy(name);
    try {
      await run();
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    } finally {
      setBusy(null);
    }
  }

  const stateText = !stream.enabled
    ? stream.lastError ?? "Off on this phone."
    : stream.state === "connected"
      ? "Connected: alerts arrive within seconds, even with the app closed."
      : stream.state === "waiting"
        ? `Not connected (${stream.lastError ?? "retrying"}). Retrying automatically.`
        : "Connecting…";

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Settings" }} />
      <ErrorBox error={error} />
      <Card title="Notifications on this phone">
        {!Stream.isAvailable() ? <Note tone="warn">This build has no notification service (it only exists in the installed Android app).</Note> : null}
        <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
          <StatusBadge status={stream.state === "connected" ? "up" : stream.enabled ? "warn" : "down"} />
          <T style={{ flex: 1 }}>{stateText}</T>
        </View>
        <T size="s" muted>Last connected {relativeTime(stream.lastConnectedAt)}. If the connection is down for over 10 minutes you get a "Can't reach Looksee" notification.</T>
        {data && !data.allowed ? (
          <Note tone="warn">
            <T size="s">Android is blocking Looksee's notifications.</T>
            <Button small title="Allow notifications" onPress={() => act("perm", async () => {
              const r = await PermissionsAndroid.request(PermissionsAndroid.PERMISSIONS.POST_NOTIFICATIONS);
              if (r !== "granted") Stream.openNotificationSettings();
            })} />
          </Note>
        ) : null}
        {data && !data.battery ? (
          <Note tone="warn">
            <T size="s">Battery saving may cut the connection while the phone sleeps, delaying alerts.</T>
            <Button small title="Let Looksee run in the background" onPress={() => Stream.requestIgnoreBatteryOptimizations()} />
          </Note>
        ) : null}
        <ButtonRow>
          {!stream.enabled || !session.deviceId ? (
            <Button small variant="primary" title="Turn on notifications" busy={busy === "on"} onPress={() => act("on", session.enableNotifications)} />
          ) : (
            <Button small title="Send a test" busy={busy === "test"} onPress={() => act("test", async () => {
              const r = await api.testAppDevice(session.deviceId!);
              if (!r.connected) tell("Queued", "This phone isn't connected right now; the test arrives when it reconnects.");
            })} />
          )}
          <Button small title="Sounds & categories" onPress={() => Stream.openNotificationSettings()} />
          {data?.device ? (
            <Button small title="Rename this phone" onPress={async () => {
              const name = await ask({ title: "Phone name", label: "Shown on the Security page and the Channels page", initial: data.device!.name });
              if (name?.trim()) void act("rename", () => api.renameAppDevice(data.device!.id, name.trim()));
            }} />
          ) : null}
        </ButtonRow>
        <T size="s" muted>Alerts come from "Notifications" channels (which also reach browsers with push on): add one to an alert rule on a check, or when creating checks.</T>
      </Card>

      <Card title="Received on this phone">
        {!data?.history.length ? <Empty>Nothing yet.</Empty> : data.history.slice(0, 30).map((n) => (
          <Row key={n.id} left={<StatusBadge status={n.status?.toLowerCase()} small />} title={n.title} subtitle={`${dateTime(n.createdAt)}${n.deliveredAt ? "" : " · not delivered yet"}`} />
        ))}
      </Card>

      <Card title="Appearance">
        <Chips>
          {(["system", "light", "dark"] as ThemeChoice[]).map((c) => <Chip key={c} label={c === "system" ? "Follow the phone" : c[0].toUpperCase() + c.slice(1)} on={choice === c} onPress={() => setChoice(c)} />)}
        </Chips>
      </Card>

      <Card title="Account">
        <KeyValue label="Signed in as" value={session.email ?? "—"} />
        <KeyValue label="Server" value={session.serverUrl ?? "—"} />
        <Button variant="danger" title="Sign out" onPress={() => confirm("Sign out?", "This phone also stops receiving Looksee notifications.", () => void session.signOut(), "Sign out")} />
      </Card>

      <Card title="About">
        <KeyValue label="App version" value={Constants.expoConfig?.version ?? "—"} />
        <KeyValue label="Server version" value={data?.health?.version ?? "—"} />
        {data?.health && Constants.expoConfig?.version && data.health.version !== Constants.expoConfig.version ? <Note tone="warn">{`The app (${Constants.expoConfig.version}) and server (${data.health.version}) versions differ. Install the matching app version.`}</Note> : null}
      </Card>
      {prompt}
    </Screen>
  );
}
