// Exclusion lists: reusable lists of things checks ignore (services that are
// meant to be stopped, harmless log messages…), applied to every check of the
// matching kind or only to checks in chosen groups. A check's own exclusions
// are edited on the check (or on many checks with "Edit settings on many").

import { useCallback } from "react";
import { Stack, router } from "expo-router";
import { api } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, Loading, Screen, T, Toggle, confirm, tell } from "../../../components/ui";

export default function Exclusions() {
  const load = useCallback(async () => {
    const [lists, kinds] = await Promise.all([api.exclusionLists(), api.exclusionKinds()]);
    return { lists, kind: new Map(kinds.map((k) => [k.id, k.label])) };
  }, []);
  const { data, error, loading, refreshing, reload } = useLoad(load);
  if (loading) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Exclusion lists" }} />
      <ErrorBox error={error} />
      <Button icon="add" variant="primary" title="New list" onPress={() => router.push("/exclusions/edit")} />
      {!data?.lists.length ? <Empty>No exclusion lists.</Empty> : data.lists.map((l) => (
        <Card key={l.id} title={l.name}>
          <T size="s" muted>{data.kind.get(l.kind) ?? l.kind} · {l.items.length} item(s) · {l.applyToAll ? "every matching check" : `${l.groupIds.length} group(s)`}</T>
          {l.description ? <T size="s">{l.description}</T> : null}
          <Toggle label="Enabled" value={l.enabled} onChange={async (enabled) => {
            await api.updateExclusionList(l.id, { enabled }).catch((err) => tell("That didn't work", errorText(err)));
            void reload();
          }} />
          <ButtonRow>
            <Button small title="Edit" onPress={() => router.push({ pathname: "/exclusions/edit", params: { id: l.id } })} />
            <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete "${l.name}"?`, "Checks stop ignoring its items.", async () => {
              await api.deleteExclusionList(l.id).catch((err) => tell("That didn't work", errorText(err)));
              void reload();
            })} />
          </ButtonRow>
        </Card>
      ))}
    </Screen>
  );
}
