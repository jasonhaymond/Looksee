// One location (a physical place): its address and description, its sites,
// and actions: add a site here, edit, maintenance for everything here, delete.

import { useCallback } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, KeyValue, Loading, Row, Screen, T, confirm, tell } from "../../../components/ui";
import { usePrompt } from "../../../components/Prompt";

export default function LocationDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [prompt, ask] = usePrompt();
  const load = useCallback(async () => {
    const [locations, sites] = await Promise.all([api.locations(), api.sites()]);
    const location = locations.find((l) => l.id === id);
    if (!location) throw new Error("This location no longer exists.");
    return { location, sites: sites.filter((s) => s.locationId === id) };
  }, [id]);
  const { data, error, loading, refreshing, reload } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const l = data.location;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: l.name }} />
      <Card>
        {l.description ? <T>{l.description}</T> : null}
        {l.address ? <KeyValue label="Address" value={l.address} /> : null}
        <ButtonRow>
          <Button small icon="add" title="Site here" onPress={() => router.push({ pathname: "/sites/edit", params: { locationId: id } })} />
          <Button small icon="create-outline" title="Edit" onPress={() => router.push({ pathname: "/locations/edit", params: { id } })} />
          <Button small title="Maintenance…" onPress={async () => {
            const m = await ask({ title: `Maintenance: ${l.name}`, label: "Minutes", initial: "60", numeric: true, message: "No alerts for any check at this location until it ends." });
            if (!m) return;
            try {
              const r = await api.locationMaintenance(id, Number(m));
              tell("Maintenance started", `${r.checks} check(s) in ${r.sites} site(s).`);
            } catch (err) {
              tell("That didn't work", errorText(err));
            }
          }} />
          <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete ${l.name}?`, "Its sites are kept, just no longer in a location.", async () => {
            try {
              await api.deleteLocation(id);
              router.back();
            } catch (err) {
              tell("That didn't work", errorText(err));
            }
          })} />
        </ButtonRow>
      </Card>
      <Card title={`Sites (${data.sites.length})`}>
        {data.sites.length === 0 ? <Empty>No sites here yet.</Empty> : data.sites.map((s) => <Row key={s.id} title={s.name} subtitle={s.description ?? undefined} onPress={() => router.push(`/sites/${s.id}`)} />)}
      </Card>
      {prompt}
    </Screen>
  );
}
