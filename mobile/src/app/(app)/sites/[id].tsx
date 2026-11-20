// One site (a network): its details, endpoints and checks, and actions: add a
// check or endpoint, suggested checks, edit, maintenance, pause/resume all its
// checks, delete.

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText, relativeTime } from "../../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, KeyValue, Loading, Row, Screen, T, confirm, tell } from "../../../components/ui";
import { CheckRow } from "../../../components/CheckRow";
import { usePrompt } from "../../../components/Prompt";

export default function SiteDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [prompt, ask] = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    const [sites, endpoints, checks, locations, all] = await Promise.all([api.sites(), api.endpoints(id), api.checks(id), api.locations(), api.endpoints()]);
    const site = sites.find((s) => s.id === id);
    if (!site) throw new Error("This site no longer exists.");
    return { site, endpoints, checks, location: locations.find((l) => l.id === site.locationId), collector: all.find((e) => e.id === site.collectorEndpointId) };
  }, [id]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);

  /** Runs a bulk action on this site and reports the result. */
  async function bulk(action: string, params: Record<string, unknown>, done: string) {
    setBusy(action);
    try {
      await api.bulkSites([id], action, params);
      tell(done);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const { site } = data;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: site.name }} />
      <ErrorBox error={error} />
      <Card>
        {site.description ? <T>{site.description}</T> : null}
        <KeyValue label="Location" value={data.location?.name ?? "none"} />
        <KeyValue label="Collector" value={data.collector ? `Agent on ${data.collector.name}` : "The Looksee server"} />
        {site.networks.length ? <KeyValue label="Networks" value={site.networks.join(", ")} mono /> : null}
        {site.publicIps.length ? <KeyValue label="Public IPs" value={site.publicIps.join(", ")} mono /> : null}
        <ButtonRow>
          <Button small icon="add" title="Check" onPress={() => router.push({ pathname: "/checks/new", params: { siteId: id } })} />
          <Button small icon="add" title="Endpoint" onPress={() => router.push({ pathname: "/endpoints/edit", params: { siteId: id } })} />
          <Button small title="Suggested checks" onPress={() => router.push({ pathname: "/suggestions", params: { siteId: id } })} />
          <Button small icon="create-outline" title="Edit" onPress={() => router.push({ pathname: "/sites/edit", params: { id } })} />
          <Button small title="Maintenance…" busy={busy === "maintenance"} onPress={async () => {
            const m = await ask({ title: `Maintenance: ${site.name}`, label: "Minutes", initial: "60", numeric: true, message: "No alerts for any check in this site until it ends." });
            if (m) void bulk("maintenance", { minutes: Number(m) }, "Maintenance started");
          }} />
          <Button small title="Pause all checks" busy={busy === "disable_checks"} onPress={() => bulk("disable_checks", {}, "Paused")} />
          <Button small title="Resume all checks" busy={busy === "enable_checks"} onPress={() => bulk("enable_checks", {}, "Resumed")} />
          <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete ${site.name}?`, "Its endpoints, checks and their history are deleted too. This can't be undone.", async () => {
            try {
              await api.deleteSite(id);
              router.back();
            } catch (err) {
              tell("That didn't work", errorText(err));
            }
          })} />
        </ButtonRow>
      </Card>
      <Card title={`Endpoints (${data.endpoints.length})`}>
        {data.endpoints.length === 0 ? <Empty>No endpoints yet.</Empty> : data.endpoints.map((e) => (
          <Row key={e.id} title={e.name} subtitle={[e.hostname, e.os, e.agentVersion ? `agent ${e.agentVersion}, seen ${relativeTime(e.lastSeenAt)}` : "no agent"].filter(Boolean).join(" · ")} onPress={() => router.push(`/endpoints/${e.id}`)} />
        ))}
      </Card>
      <Card title={`Checks (${data.checks.length})`}>
        {data.checks.length === 0 ? <Empty>No checks yet.</Empty> : [...data.checks].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <CheckRow key={c.id} check={c} />)}
      </Card>
      {prompt}
    </Screen>
  );
}
