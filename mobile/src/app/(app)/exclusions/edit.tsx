// Create or edit an exclusion list: its kind (which checks use it), the items
// (one per line), and where it applies (every matching check, or checks in
// chosen groups). Params: id (edit), or nothing (create).

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type ExclusionKind, type ExclusionList, type Group } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Screen, Select, Toggle } from "../../../components/ui";

export default function ExclusionEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const load = useCallback(async () => {
    const [lists, kinds, groups] = await Promise.all([api.exclusionLists(), api.exclusionKinds(), api.groups()]);
    return { list: lists.find((l) => l.id === id) ?? null, kinds, groups };
  }, [id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form {...data} />;
}

function Form({ list, kinds, groups }: { list: ExclusionList | null; kinds: ExclusionKind[]; groups: Group[] }) {
  const [name, setName] = useState(list?.name ?? "");
  const [description, setDescription] = useState(list?.description ?? "");
  const [kind, setKind] = useState(list?.kind ?? kinds[0]?.id ?? "");
  const [items, setItems] = useState((list?.items ?? []).join("\n"));
  const [applyToAll, setApplyToAll] = useState(list?.applyToAll ?? true);
  const [groupIds, setGroupIds] = useState<string[]>(list?.groupIds ?? []);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const k = kinds.find((x) => x.id === kind);

  async function save() {
    if (!name.trim()) return setErr("Name is required.");
    setBusy(true);
    setErr(null);
    const input = { name: name.trim(), description: description.trim() || null, kind, items, applyToAll, groupIds: applyToAll ? [] : groupIds };
    try {
      if (list) await api.updateExclusionList(list.id, input);
      else await api.createExclusionList(input);
      router.back();
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: list ? `Edit: ${list.name}` : "New exclusion list" }} />
      <Card>
        <Field label="Name *" value={name} onChangeText={setName} />
        <Field label="Description" value={description} onChangeText={setDescription} />
        <Select label="Kind" value={kind} onChange={setKind} options={kinds.map((x) => ({ value: x.id, label: x.label, sub: x.help }))} help={k?.help} />
        <Field label="Items (one per line)" value={items} onChangeText={setItems} multiline autoCapitalize="none" autoCorrect={false} help={k?.match === "text" ? "A message containing any of these texts (case ignored) is ignored." : "Whole names, case ignored; * matches anything."} />
        <Toggle label="Apply to every matching check" value={applyToAll} onChange={setApplyToAll} />
        {!applyToAll ? <Select multi label="Only checks in these groups" value={groupIds} onChange={setGroupIds} options={groups.map((g) => ({ value: g.id, label: g.name }))} /> : null}
      </Card>
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={list ? "Save" : "Create list"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
