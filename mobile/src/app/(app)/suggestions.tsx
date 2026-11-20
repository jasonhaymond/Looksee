// Suggested checks for an endpoint (from what its agent reported: services,
// disks, roles like "web server" or "domain controller") or for a site (from
// its devices). Tick the ones to add, optionally with an alert rule, and add
// them in one go. Params: endpointId or siteId.

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type Channel, type Suggestion } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { errorText } from "../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, Loading, Row, Screen, T, tell } from "../../components/ui";
import { AlertRuleForm, emptyRule, rulePayload } from "../../components/AlertRuleForm";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../lib/theme";

export default function Suggestions() {
  const { endpointId, siteId } = useLocalSearchParams<{ endpointId?: string; siteId?: string }>();
  const { colors } = useTheme();
  const load = useCallback(async () => {
    const [suggestions, templates, channels] = await Promise.all([
      endpointId ? api.endpointSuggestions(endpointId) : api.siteSuggestions(siteId!),
      endpointId ? api.roleTemplates(endpointId).catch(() => []) : Promise.resolve([]),
      api.channels(),
    ]);
    return { suggestions: suggestions as Suggestion[], templates, channels };
  }, [endpointId, siteId]);
  const { data, error, loading } = useLoad(load);
  const [picked, setPicked] = useState<string[]>([]);
  const [rule, setRule] = useState(emptyRule());
  const [extraChannels, setExtraChannels] = useState<Channel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function add() {
    setBusy(true);
    setErr(null);
    const payload = rulePayload(rule);
    const alertRule = payload.channelIds.length ? payload : null;
    try {
      const r = endpointId ? await api.applySuggestions(endpointId, picked, { alertRule }) : await api.applySiteSuggestions(siteId!, picked, alertRule);
      tell(`Added ${r.created} check${r.created === 1 ? "" : "s"}`);
      router.back();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  /** Adds every missing check of a role/security template to the endpoint. */
  async function applyTemplate(templateId: string, label: string) {
    try {
      const payload = rulePayload(rule);
      const r = await api.applyRoleTemplate(endpointId!, templateId, { alertRule: payload.channelIds.length ? payload : null });
      tell(`${label}: added ${r.created} check${r.created === 1 ? "" : "s"}`);
    } catch (e) {
      tell("That didn't work", errorText(e));
    }
  }

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const groups = [...new Set(data.suggestions.map((s) => s.group ?? "Suggested"))];
  return (
    <Screen>
      <Stack.Screen options={{ title: "Suggested checks" }} />
      {data.templates.length ? (
        <Card title="Templates">
          {data.templates.map((t) => (
            <Row key={t.id} title={`${t.label}${t.detected ? " (detected)" : ""}`} subtitle={`${t.description} · ${t.checks.length} to add, ${t.alreadyHave} already there`} right={t.checks.length ? <Button small title="Add all" onPress={() => void applyTemplate(t.id, t.label)} /> : <T size="s" muted>done</T>} />
          ))}
        </Card>
      ) : null}
      {data.suggestions.length === 0 ? <Empty>No suggestions: everything suggested is already monitored, or the agent hasn't reported yet.</Empty> : groups.map((g) => (
        <Card key={g} title={g}>
          {data.suggestions.filter((s) => (s.group ?? "Suggested") === g).map((s) => (
            <Row
              key={s.key}
              title={s.name}
              subtitle={s.reason}
              selected={picked.includes(s.key)}
              left={<Ionicons name={picked.includes(s.key) ? "checkbox" : "square-outline"} size={22} color={picked.includes(s.key) ? colors.accent : colors.muted} />}
              right={<View />}
              onPress={() => setPicked((p) => (p.includes(s.key) ? p.filter((x) => x !== s.key) : [...p, s.key]))}
            />
          ))}
        </Card>
      ))}
      <Card title="Alert rule for the new checks (optional)">
        <AlertRuleForm value={rule} onChange={setRule} channels={[...data.channels, ...extraChannels]} onChannelCreated={(c) => setExtraChannels((x) => [...x, c])} />
      </Card>
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title={`Select all ${data.suggestions.length}`} onPress={() => setPicked(data.suggestions.map((s) => s.key))} />
        <Button title={`Add ${picked.length}`} variant="primary" disabled={!picked.length} busy={busy} onPress={add} />
      </ButtonRow>
    </Screen>
  );
}
