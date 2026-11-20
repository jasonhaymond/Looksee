// The outbound watchdog: while Looksee is healthy it calls an outside URL
// (e.g. a Healthchecks.io or Uptime Kuma push URL) on a schedule; if the
// calls stop, that outside service alerts you that Looksee itself is down.
// The URLs contain secrets, so they're shown masked and replaced, not edited.

import { useCallback, useState } from "react";
import { Stack } from "expo-router";
import { api } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { dateTime, errorText } from "../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, KeyValue, Loading, Note, Screen, T, Toggle, tell } from "../../components/ui";

export default function Watchdog() {
  const load = useCallback(() => api.watchdog(), []);
  const { data, error, loading, refreshing, reload, setData } = useLoad(load, 30);
  const [url, setUrl] = useState("");
  const [failUrl, setFailUrl] = useState("");
  const [interval, setInterval_] = useState("");

  /** Saves part of the settings and shows the result. */
  async function save(patch: Parameters<typeof api.updateWatchdog>[0]) {
    try {
      setData(await api.updateWatchdog(patch));
      setUrl("");
      setFailUrl("");
      tell("Saved");
    } catch (err) {
      tell("Not saved", errorText(err));
    }
  }

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Outbound watchdog" }} />
      <Card>
        <T size="s" muted>Looksee calls this URL every interval while it's healthy. Set up an outside monitor to alert when the calls stop.</T>
        <Toggle label="Enabled" value={data.enabled} onChange={(enabled) => save({ enabled })} />
        <KeyValue label="URL" value={data.urlSet ? data.url ?? "saved" : "not set"} mono />
        <KeyValue label="Failure URL" value={data.failUrlSet ? data.failUrl ?? "saved" : "not set"} mono />
        <KeyValue label="Every" value={`${data.intervalSeconds} s`} />
        <KeyValue label="Last ping" value={data.lastPingAt ? `${dateTime(data.lastPingAt)}: ${data.lastResult ?? ""}` : "never"} />
        {data.lastError ? <Note tone="warn">{data.lastError}</Note> : null}
        <Note tone={data.selfCheck.ok ? "up" : "warn"}>{`Self-check: ${data.selfCheck.ok ? "healthy" : "unhealthy"}${data.selfCheck.reason ? ` (${data.selfCheck.reason})` : ""}`}</Note>
      </Card>
      <Card title="Change">
        <Field label="New URL" value={url} onChangeText={setUrl} autoCapitalize="none" keyboardType="url" placeholder="https://hc-ping.com/…" />
        <Field label="New failure URL (optional)" value={failUrl} onChangeText={setFailUrl} autoCapitalize="none" keyboardType="url" help="Called instead when Looksee's self-check fails (e.g. the database is unreachable)." />
        <Field label="Every (seconds)" value={interval} onChangeText={setInterval_} keyboardType="number-pad" placeholder={String(data.intervalSeconds)} />
        <ButtonRow>
          <Button small variant="primary" title="Save" onPress={() => save({ ...(url ? { url } : {}), ...(failUrl ? { failUrl } : {}), ...(interval ? { intervalSeconds: Number(interval) } : {}) })} />
          <Button small title="Send a test ping" onPress={async () => {
            try {
              const r = await api.testWatchdog();
              tell(r.sent ? "Ping sent" : "Not sent", r.detail);
            } catch (err) {
              tell("That didn't work", errorText(err));
            }
          }} />
          {data.urlSet ? <Button small variant="danger" title="Remove URLs" onPress={() => save({ url: null, failUrl: null, enabled: false })} /> : null}
        </ButtonRow>
      </Card>
    </Screen>
  );
}
