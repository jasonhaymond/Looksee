// Create or edit an endpoint: site, name, address (hostname or IP), operating
// system, MAC address (for Wake-on-LAN and address tracking) and tags.
// Params: id (edit), or nothing (create; optional siteId).

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type Endpoint, type Site } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Screen, Select } from "../../../components/ui";

export default function EndpointEdit() {
  const params = useLocalSearchParams<{ id?: string; siteId?: string }>();
  const load = useCallback(async () => {
    const [sites, endpoint] = await Promise.all([api.sites(), params.id ? api.endpoint(params.id) : Promise.resolve(null)]);
    return { sites, endpoint };
  }, [params.id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form endpoint={data.endpoint} sites={data.sites} siteId={params.siteId} />;
}

function Form({ endpoint, sites, siteId: initialSite }: { endpoint: Endpoint | null; sites: Site[]; siteId?: string }) {
  const [siteId, setSiteId] = useState(endpoint?.siteId ?? initialSite ?? sites[0]?.id ?? "");
  const [name, setName] = useState(endpoint?.name ?? "");
  const [hostname, setHostname] = useState(endpoint?.hostname ?? "");
  const [os, setOs] = useState(endpoint?.os ?? "");
  const [mac, setMac] = useState(endpoint?.macAddress ?? "");
  const [tags, setTags] = useState((endpoint?.tags ?? []).join(", "));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("Name is required.");
    if (!siteId) return setError("Choose a site (add one first on the Browse tab).");
    setBusy(true);
    setError(null);
    const tagList = tags.split(",").map((t) => t.trim()).filter(Boolean);
    try {
      if (endpoint) {
        await api.updateEndpoint(endpoint.id, { siteId, name: name.trim(), hostname: hostname.trim() || null, os: os.trim() || null, macAddress: mac.trim() || null, tags: tagList });
        router.back();
      } else {
        const created = await api.createEndpoint({ siteId, name: name.trim(), hostname: hostname.trim() || undefined, os: os.trim() || undefined, macAddress: mac.trim() || undefined, tags: tagList });
        router.replace(`/endpoints/${created.id}`);
      }
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: endpoint ? `Edit: ${endpoint.name}` : "New endpoint" }} />
      <Card>
        <Select label="Site *" value={siteId} onChange={setSiteId} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
        <Field label="Name *" value={name} onChangeText={setName} placeholder="nas01" />
        <Field label="Address" value={hostname} onChangeText={setHostname} autoCapitalize="none" keyboardType="url" placeholder="192.168.1.20 or nas01.lan" help="Used by checks targeting this endpoint's address." />
        <Field label="Operating system" value={os} onChangeText={setOs} placeholder="Filled in by the agent" />
        <Field label="MAC address" value={mac} onChangeText={setMac} autoCapitalize="none" placeholder="aa:bb:cc:dd:ee:ff" help="Needed for Wake-on-LAN." />
        <Field label="Tags" value={tags} onChangeText={setTags} autoCapitalize="none" help="Comma-separated." />
      </Card>
      <ErrorBox error={error} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={endpoint ? "Save" : "Create endpoint"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
