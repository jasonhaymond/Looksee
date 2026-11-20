// SNMP templates: ready-made sets of SNMP checks for a kind of device (a
// switch, a UPS, a printer), matched by the device's sysObjectID during
// discovery. Built-in templates can be viewed; your own can be added, edited
// and deleted. Items are edited as JSON (one object per check, the same
// fields as an SNMP check's settings), checked before saving.

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { api, type SnmpTemplate, type SnmpTemplateItem } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { errorText } from "../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, Field, Loading, Screen, T, confirm, tell } from "../../components/ui";

type Draft = { id: string | null; name: string; description: string; match: string; items: string };

const toDraft = (t: SnmpTemplate | null): Draft => ({ id: t?.id ?? null, name: t?.name ?? "", description: t?.description ?? "", match: t?.matchSysObjectId ?? "", items: JSON.stringify(t?.items ?? [{ name: "Uptime", oid: "1.3.6.1.2.1.1.3.0" }], null, 2) });

export default function SnmpTemplates() {
  const load = useCallback(() => api.snmpTemplates(), []);
  const { data, error, loading, refreshing, reload } = useLoad(load);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!draft) return;
    setErr(null);
    let items: SnmpTemplateItem[];
    try {
      items = JSON.parse(draft.items);
      if (!Array.isArray(items) || items.some((i) => !i || typeof i !== "object" || !i.name)) throw new Error("Items must be a list of objects, each with a name.");
    } catch (e) {
      return setErr(`Items aren't valid: ${errorText(e)}`);
    }
    const input = { name: draft.name.trim(), description: draft.description.trim() || null, matchSysObjectId: draft.match.trim() || null, items };
    try {
      if (draft.id) await api.updateSnmpTemplate(draft.id, input);
      else await api.createSnmpTemplate(input);
      setDraft(null);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  if (loading) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "SNMP templates" }} />
      <ErrorBox error={error} />
      {draft ? (
        <Card title={draft.id ? "Edit template" : "New template"}>
          <Field label="Name *" value={draft.name} onChangeText={(t) => setDraft({ ...draft, name: t })} />
          <Field label="Description" value={draft.description} onChangeText={(t) => setDraft({ ...draft, description: t })} />
          <Field label="Match sysObjectID (prefix, optional)" value={draft.match} onChangeText={(t) => setDraft({ ...draft, match: t })} autoCapitalize="none" placeholder="1.3.6.1.4.1.9." />
          <Field label="Items (JSON)" value={draft.items} onChangeText={(t) => setDraft({ ...draft, items: t })} multiline autoCapitalize="none" autoCorrect={false} style={{ fontFamily: "monospace", fontSize: 12, minHeight: 200 }} help='e.g. [{"name": "CPU", "oid": "1.3.6…", "unit": "%", "warnAbove": 80}]' />
          <ErrorBox error={err} />
          <ButtonRow>
            <Button title="Cancel" onPress={() => setDraft(null)} />
            <Button variant="primary" title="Save" onPress={save} />
          </ButtonRow>
        </Card>
      ) : (
        <Button icon="add" variant="primary" title="New template" onPress={() => setDraft(toDraft(null))} />
      )}
      {!data?.length ? <Empty>No templates.</Empty> : data.map((t) => (
        <Card key={t.id} title={t.name}>
          <T size="s" muted>{t.builtIn ? "Built in" : "Yours"} · {t.items.length} check(s){t.matchSysObjectId ? ` · matches ${t.matchSysObjectId}` : ""}</T>
          {t.description ? <T size="s">{t.description}</T> : null}
          {open === t.id ? (
            <View style={{ gap: 2 }}>
              {t.items.map((i, n) => <T key={n} size="s">• {i.name}{i.oid ? ` (${i.oid})` : i.preset ? ` (${i.preset})` : ""}{i.unit ? `, ${i.unit}` : ""}</T>)}
            </View>
          ) : null}
          <ButtonRow>
            <Button small title={open === t.id ? "Hide checks" : "Show checks"} onPress={() => setOpen(open === t.id ? null : t.id)} />
            {!t.builtIn ? <Button small title="Edit" onPress={() => setDraft(toDraft(t))} /> : <Button small title="Copy as new" onPress={() => setDraft({ ...toDraft(t), id: null, name: `${t.name} (copy)` })} />}
            {!t.builtIn ? <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete "${t.name}"?`, "Checks already created from it are kept.", async () => {
              await api.deleteSnmpTemplate(t.id).catch((e) => tell("That didn't work", errorText(e)));
              void reload();
            })} /> : null}
          </ButtonRow>
        </Card>
      ))}
    </Screen>
  );
}
