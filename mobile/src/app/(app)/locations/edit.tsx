// Create or edit a location: name, address, description, and which sites are
// in it. Params: id (edit), or nothing (create).

import { useCallback, useState } from "react";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, type Location, type Site } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Screen, Select } from "../../../components/ui";

export default function LocationEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const load = useCallback(async () => {
    const [locations, sites] = await Promise.all([api.locations(), api.sites()]);
    return { location: locations.find((l) => l.id === id) ?? null, sites };
  }, [id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form location={data.location} sites={data.sites} />;
}

function Form({ location, sites }: { location: Location | null; sites: Site[] }) {
  const [name, setName] = useState(location?.name ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [description, setDescription] = useState(location?.description ?? "");
  const [siteIds, setSiteIds] = useState<string[]>(location ? sites.filter((s) => s.locationId === location.id).map((s) => s.id) : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!name.trim()) return setError("Name is required.");
    setBusy(true);
    setError(null);
    const input = { name: name.trim(), address: address.trim() || null, description: description.trim() || null, siteIds };
    try {
      const saved = location ? await api.updateLocation(location.id, input) : await api.createLocation(input);
      if (location) router.back();
      else router.replace(`/locations/${saved.id}`);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: location ? `Edit: ${location.name}` : "New location" }} />
      <Card>
        <Field label="Name *" value={name} onChangeText={setName} placeholder="Head office" />
        <Field label="Address" value={address} onChangeText={setAddress} />
        <Field label="Description" value={description} onChangeText={setDescription} />
        <Select multi label="Sites in this location" value={siteIds} onChange={setSiteIds} options={sites.map((s) => ({ value: s.id, label: s.name }))} placeholder="None" />
      </Card>
      <ErrorBox error={error} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={location ? "Save" : "Create location"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
