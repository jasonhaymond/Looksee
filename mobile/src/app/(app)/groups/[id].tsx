// One group: its members and every check it covers through the hierarchy,
// with actions on all covered checks at once (maintenance, pause, resume, run
// now, edit settings on many), plus edit and delete.

import { useCallback } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, Dot, Empty, ErrorBox, Loading, Row, Screen, T, confirm, tell } from "../../../components/ui";
import { usePrompt } from "../../../components/Prompt";

export default function GroupDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [prompt, ask] = usePrompt();
  const load = useCallback(() => api.group(id), [id]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 60);

  /** Runs a bulk action on every check this group covers. */
  async function bulk(action: string, params: Record<string, unknown>, verb: string) {
    if (!data?.coveredCheckIds.length) return tell("This group covers no checks.");
    try {
      const r = await api.bulkChecks(data.coveredCheckIds, action, params);
      tell(`${verb}: ${r.affected} check(s)`);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  }

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const g = data.group;
  const m = data.members;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: g.name }} />
      <Card>
        {g.description ? <T>{g.description}</T> : null}
        <T size="s" muted>{g.kind === "filter" ? `Filter: ${g.target}s matching ${g.rules.match === "all" ? "all" : "any"} of ${g.rules.conditions.map((c) => `${c.field} ${c.op} "${c.value}"`).join(", ")}` : "Members picked by hand"} · covers {data.coveredCheckIds.length} check(s)</T>
        <ButtonRow>
          <Button small title="Maintenance…" onPress={async () => {
            const minutes = await ask({ title: `Maintenance: ${g.name}`, label: "Minutes", initial: "60", numeric: true });
            if (minutes) void bulk("maintenance", { minutes: Number(minutes), name: `Maintenance: ${g.name}` }, "In maintenance");
          }} />
          <Button small title="Run all now" onPress={() => bulk("run_now", {}, "Started")} />
          <Button small title="Pause all" onPress={() => bulk("disable", {}, "Paused")} />
          <Button small title="Resume all" onPress={() => bulk("enable", {}, "Resumed")} />
          <Button small title="Edit settings on all…" onPress={() => router.push({ pathname: "/checks/bulk-settings", params: { ids: data.coveredCheckIds.join(",") } })} />
          <Button small icon="create-outline" title="Edit group" onPress={() => router.push({ pathname: "/groups/edit", params: { id } })} />
          <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete "${g.name}"?`, "Only the group is deleted; its members stay.", async () => {
            await api.deleteGroup(id).catch((err) => tell("That didn't work", errorText(err)));
            router.back();
          })} />
        </ButtonRow>
      </Card>
      {m.locations.length ? <Card title="Locations">{m.locations.map((x) => <Row key={x.id} title={x.name} onPress={() => router.push(`/locations/${x.id}`)} />)}</Card> : null}
      {m.sites.length ? <Card title="Sites">{m.sites.map((x) => <Row key={x.id} left={<Dot status={x.status} />} title={x.name} onPress={() => router.push(`/sites/${x.id}`)} />)}</Card> : null}
      {m.endpoints.length ? <Card title="Endpoints">{m.endpoints.map((x) => <Row key={x.id} left={<Dot status={x.status} />} title={x.name} subtitle={[x.site, x.os].filter(Boolean).join(" · ")} onPress={() => router.push(`/endpoints/${x.id}`)} />)}</Card> : null}
      {m.checks.length ? <Card title="Checks">{m.checks.map((x) => <Row key={x.id} left={<Dot status={x.enabled ? x.status : null} />} title={x.name} subtitle={[x.endpoint, x.site].filter(Boolean).join(" · ")} onPress={() => router.push(`/checks/${x.id}`)} />)}</Card> : null}
      {!m.locations.length && !m.sites.length && !m.endpoints.length && !m.checks.length ? <Empty>No members.</Empty> : null}
      {prompt}
    </Screen>
  );
}
