// Notification channels: where alerts go (email, Slack, Teams, Telegram,
// webhooks, and Notifications: this app and browsers with push on). Lists each with a test,
// on/off, edit and delete. Delivery settings (webhook URLs, tokens) are
// write-only, so editing replaces them.

import { useCallback } from "react";
import { Stack, router } from "expo-router";
import { api, own } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, Loading, Screen, T, Toggle, confirm, tell } from "../../../components/ui";
import { CHANNEL_LABEL } from "./edit";

export default function Channels() {
  const load = useCallback(() => api.channels(), []);
  const { data, error, loading, refreshing, reload } = useLoad(load);

  /** Runs an action on a channel, reports errors, reloads. */
  const act = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) tell(done);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  };

  if (loading) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Channels" }} />
      <ErrorBox error={error} />
      <Button icon="add" variant="primary" title="New channel" onPress={() => router.push("/channels/edit")} />
      {!data?.length ? <Empty>No channels yet. Alerts only show in the app and dashboard until one is added to an alert rule.</Empty> : data.map((c) => (
        <Card key={c.id} title={c.name}>
          <T size="s" muted>{own(CHANNEL_LABEL, c.type) ?? c.type}</T>
          <Toggle label="Enabled" value={c.enabled} onChange={(enabled) => act(() => api.updateChannel(c.id, { enabled }))} />
          <ButtonRow>
            <Button small title="Send a test" onPress={() => act(() => api.testChannel(c.id), `Test sent through "${c.name}".`)} />
            <Button small title="Edit" onPress={() => router.push({ pathname: "/channels/edit", params: { id: c.id } })} />
            <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete "${c.name}"?`, "Alert rules using it will have one fewer channel.", () => void act(() => api.deleteChannel(c.id)))} />
          </ButtonRow>
        </Card>
      ))}
    </Screen>
  );
}
