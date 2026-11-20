// Adds the same alert rule to many checks at once (bulk "add_alert_rule").
// Params: ids (comma-separated check IDs). Each check gets its own copy of the
// rule; existing rules are left as they are.

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type Channel } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Loading, Screen, T, tell } from "../../../components/ui";
import { AlertRuleForm, emptyRule, rulePayload } from "../../../components/AlertRuleForm";

export default function BulkAlert() {
  const { ids } = useLocalSearchParams<{ ids?: string }>();
  const list = (ids ?? "").split(",").filter(Boolean);
  const load = useCallback(() => api.channels(), []);
  const { data, error, loading, setData } = useLoad<Channel[]>(load);
  const [rule, setRule] = useState(emptyRule());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function apply() {
    const payload = rulePayload(rule);
    if (!payload.channelIds.length) return setErr("Choose at least one channel to notify.");
    setBusy(true);
    setErr(null);
    try {
      const r = await api.bulkChecks(list, "add_alert_rule", payload);
      tell(`Alert rule added to ${r.affected} check${r.affected === 1 ? "" : "s"}`);
      router.back();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  return (
    <Screen>
      <Stack.Screen options={{ title: "Add alert rule" }} />
      <ErrorBox error={error} />
      <Card>
        <T size="s" muted>Adds this rule to {list.length} check{list.length === 1 ? "" : "s"}. Their existing rules stay.</T>
        <AlertRuleForm value={rule} onChange={setRule} channels={data ?? []} onChannelCreated={(c) => setData([...(data ?? []), c])} />
      </Card>
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title="Add rule" variant="primary" busy={busy} onPress={apply} />
      </ButtonRow>
    </Screen>
  );
}
