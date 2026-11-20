// Browse tab: the Location → Site → Endpoint tree with each one's worst
// status and number of problems, plus groups. Tapping opens that location,
// site, endpoint or group; the buttons add a location or site.

import { useCallback } from "react";
import { View } from "react-native";
import { router } from "expo-router";
import { api, type TreeSite } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { Button, ButtonRow, Card, Dot, Empty, ErrorBox, Loading, Row, Screen, T } from "../../../components/ui";

/** "3 checks · 1 problem" for a tree node. */
const summary = (n: { checkCount: number; problems: number }) => `${n.checkCount} check${n.checkCount === 1 ? "" : "s"}${n.problems ? ` · ${n.problems} problem${n.problems === 1 ? "" : "s"}` : ""}`;

export default function Browse() {
  const load = useCallback(() => api.tree(), []);
  const { data, error, loading, refreshing, reload } = useLoad(load, 60);
  if (loading) return <Loading />;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <ErrorBox error={error} />
      <ButtonRow>
        <Button small icon="add" title="Location" onPress={() => router.push("/locations/edit")} />
        <Button small icon="add" title="Site" onPress={() => router.push("/sites/edit")} />
        <Button small icon="add" title="Endpoint" onPress={() => router.push("/endpoints/edit")} />
      </ButtonRow>
      {data?.locations.map((loc) => (
        <Card key={loc.id}>
          <Row first left={<Dot status={loc.status} />} title={<T bold>{loc.name}</T>} subtitle={`Location · ${summary(loc)}`} onPress={() => router.push(`/locations/${loc.id}`)} />
          {loc.sites.map((s) => <SiteRows key={s.id} site={s} />)}
          {loc.sites.length === 0 ? <Empty>No sites in this location.</Empty> : null}
        </Card>
      ))}
      {data && data.unassignedSites.length > 0 ? (
        <Card title={data.locations.length ? "Sites without a location" : "Sites"}>
          {data.unassignedSites.map((s, i) => <SiteRows key={s.id} site={s} first={i === 0 && !data.locations.length} />)}
        </Card>
      ) : null}
      {data && !data.locations.length && !data.unassignedSites.length ? <Empty>Nothing here yet. Add a site to start.</Empty> : null}
      {data && data.groups.length > 0 ? (
        <Card title="Groups" action={<Button small title="All groups" onPress={() => router.push("/groups")} />}>
          {data.groups.map((g) => (
            <Row key={g.id} left={<Dot status={g.status} />} title={g.name} subtitle={`${g.kind === "filter" ? "Saved filter" : "Group"} · ${summary(g)}`} onPress={() => router.push(`/groups/${g.id}`)} />
          ))}
        </Card>
      ) : null}
    </Screen>
  );
}

/** A site and, indented under it, its endpoints. */
function SiteRows({ site, first }: { site: TreeSite; first?: boolean }) {
  return (
    <View>
      <Row first={first} left={<Dot status={site.status} />} title={site.name} subtitle={`Site · ${summary(site)}`} onPress={() => router.push(`/sites/${site.id}`)} />
      <View style={{ paddingLeft: 18 }}>
        {site.endpoints.map((e) => (
          <Row key={e.id} left={<Dot status={e.status} />} title={e.name} subtitle={[e.os, e.agent ? "agent" : null, e.collector ? "collector" : null, summary(e)].filter(Boolean).join(" · ")} onPress={() => router.push(`/endpoints/${e.id}`)} />
        ))}
      </View>
    </View>
  );
}
