// Groups: named sets of locations, sites, endpoints and checks that cut across
// the hierarchy ("all printers", "customer X"), either picked by hand or kept
// up to date by a filter. Lists each with its worst status; "+" adds one.

import { useCallback } from "react";
import { Stack, router } from "expo-router";
import { api } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { Button, Card, Dot, Empty, ErrorBox, Loading, Row, Screen } from "../../../components/ui";

export default function Groups() {
  const load = useCallback(() => api.groups(), []);
  const { data, error, loading, refreshing, reload } = useLoad(load, 60);
  if (loading) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Groups" }} />
      <ErrorBox error={error} />
      <Button icon="add" variant="primary" title="New group" onPress={() => router.push("/groups/edit")} />
      <Card>
        {!data?.length ? <Empty>No groups yet.</Empty> : data.map((g) => (
          <Row key={g.id} left={<Dot status={g.status} />} title={g.name} subtitle={[g.kind === "filter" ? `Filter on ${g.target}s` : "Picked by hand", `${g.counts.coveredChecks} checks`, g.problems ? `${g.problems} problem(s)` : null, g.description].filter(Boolean).join(" · ")} onPress={() => router.push(`/groups/${g.id}`)} />
        ))}
      </Card>
    </Screen>
  );
}
