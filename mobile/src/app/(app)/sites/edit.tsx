// Create or edit a site: name, description, location, which endpoint's agent
// collects for it (or the Looksee server), its own address ranges (CIDR) and
// public IPs. Params: id (edit), or nothing (create; optional locationId).

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type Endpoint, type Location, type Site } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Screen, Select } from "../../../components/ui";

/** Splits a comma/space/newline-separated list. */
const list = (s: string) => s.split(/[\s,]+/).map((x) => x.trim()).filter(Boolean);

export default function SiteEdit() {
  const params = useLocalSearchParams<{ id?: string; locationId?: string }>();
  const load = useCallback(async () => {
    const [sites, locations, endpoints] = await Promise.all([api.sites(), api.locations(), api.endpoints()]);
    return { site: sites.find((s) => s.id === params.id) ?? null, locations, endpoints };
  }, [params.id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form site={data.site} locations={data.locations} endpoints={data.endpoints} locationId={params.locationId} />;
}

function Form({ site, locations, endpoints, locationId }: { site: Site | null; locations: Location[]; endpoints: Endpoint[]; locationId?: string }) {
  const [name, setName] = useState(site?.name ?? "");
  const [description, setDescription] = useState(site?.description ?? "");
  const [loc, setLoc] = useState(site?.locationId ?? locationId ?? "");
  const [collector, setCollector] = useState(site?.collectorEndpointId ?? "");
  const [networks, setNetworks] = useState((site?.networks ?? []).join("\n"));
  const [publicIps, setPublicIps] = useState((site?.publicIps ?? []).join("\n"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Saves the site, then (if it changed) which agent collects for it. */
  async function save() {
    if (!name.trim()) return setError("Name is required.");
    setBusy(true);
    setError(null);
    const input = { name: name.trim(), description: description.trim() || null, locationId: loc || null, networks: list(networks), publicIps: list(publicIps) };
    try {
      const saved = site ? await api.updateSite(site.id, input) : await api.createSite(input);
      // The collector is stored on the endpoint side ("collect for these sites"),
      // so the site is added to / removed from that endpoint's list.
      const before = site?.collectorEndpointId ?? "";
      if (collector !== before) {
        const all = await api.sites();
        if (before) await api.setCollectorSites(before, all.filter((s) => s.collectorEndpointId === before && s.id !== saved.id).map((s) => s.id));
        if (collector) await api.setCollectorSites(collector, [...new Set([...all.filter((s) => s.collectorEndpointId === collector).map((s) => s.id), saved.id])]);
      }
      if (site) router.back();
      else router.replace(`/sites/${saved.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: site ? `Edit: ${site.name}` : "New site" }} />
      <Card>
        <Field label="Name *" value={name} onChangeText={setName} placeholder="Home LAN" />
        <Field label="Description" value={description} onChangeText={setDescription} />
        <Select label="Location" value={loc} onChange={setLoc} options={[{ value: "", label: "None" }, ...locations.map((l) => ({ value: l.id, label: l.name }))]} />
        <Select label="Collector" value={collector} onChange={setCollector} options={[{ value: "", label: "The Looksee server" }, ...endpoints.filter((e) => e.hasAgentKey || e.agentVersion).map((e) => ({ value: e.id, label: `Agent on ${e.name}` }))]} help="Who runs this site's network checks, receivers and discovery: the server itself, or an agent inside the site's network." />
        <Field label="Networks (CIDR)" value={networks} onChangeText={setNetworks} multiline autoCapitalize="none" placeholder="192.168.1.0/24" help="The site's own address ranges; tells sites apart when one collector serves several." />
        <Field label="Public IPs" value={publicIps} onChangeText={setPublicIps} multiline autoCapitalize="none" help="For devices sending syslog/traps/flows straight to the server from this site." />
      </Card>
      <ErrorBox error={error} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={site ? "Save" : "Create site"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
