// Status pages: public pages showing chosen checks' status and 90-day uptime
// (at <server>/status/<slug>), with no sign-in needed to view them. Create,
// edit (title, address, description, checks), publish/unpublish, open, delete.
// Only published pages are visible to the public.

import { useCallback, useState } from "react";
import { Linking } from "react-native";
import { Stack } from "expo-router";
import { api, type Check, type StatusPage } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { useSession } from "../../lib/session";
import { errorText } from "../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, Field, Loading, Screen, Select, T, Toggle, confirm, tell } from "../../components/ui";

type Draft = { id: string | null; title: string; slug: string; description: string; checkIds: string[]; published: boolean };

export default function StatusPages() {
  const session = useSession();
  const load = useCallback(async () => {
    const [pages, checks] = await Promise.all([api.statusPages(), api.checks()]);
    return { pages, checks };
  }, []);
  const { data, error, loading, refreshing, reload } = useLoad(load);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function save() {
    if (!draft) return;
    setErr(null);
    const input: Partial<StatusPage> = { title: draft.title.trim(), slug: draft.slug.trim().toLowerCase(), description: draft.description.trim() || null, checkIds: draft.checkIds, published: draft.published };
    try {
      if (draft.id) await api.updateStatusPage(draft.id, input);
      else await api.createStatusPage(input);
      setDraft(null);
      await reload();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  if (loading) return <Loading />;
  const checks: Check[] = data?.checks ?? [];
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Status pages" }} />
      <ErrorBox error={error} />
      {draft ? (
        <Card title={draft.id ? "Edit status page" : "New status page"}>
          <Field label="Title *" value={draft.title} onChangeText={(t) => setDraft({ ...draft, title: t })} placeholder="Service status" />
          <Field label="Address (slug) *" value={draft.slug} onChangeText={(t) => setDraft({ ...draft, slug: t })} autoCapitalize="none" placeholder="home" help={`Shown at ${session.serverUrl}/status/${draft.slug || "…"}`} />
          <Field label="Description" value={draft.description} onChangeText={(t) => setDraft({ ...draft, description: t })} />
          <Select multi label="Checks shown" value={draft.checkIds} onChange={(v) => setDraft({ ...draft, checkIds: v })} options={checks.map((c) => ({ value: c.id, label: c.name }))} />
          <Toggle label="Published (visible to anyone with the address)" value={draft.published} onChange={(v) => setDraft({ ...draft, published: v })} />
          <ErrorBox error={err} />
          <ButtonRow>
            <Button title="Cancel" onPress={() => setDraft(null)} />
            <Button variant="primary" title="Save" onPress={save} />
          </ButtonRow>
        </Card>
      ) : (
        <Button icon="add" variant="primary" title="New status page" onPress={() => setDraft({ id: null, title: "", slug: "", description: "", checkIds: [], published: false })} />
      )}
      {!data?.pages.length ? <Empty>No status pages.</Empty> : data.pages.map((p) => (
        <Card key={p.id} title={p.title}>
          <T size="s" muted>/status/{p.slug} · {p.published ? "published" : "not published"} · {p.checkIds.length} check(s)</T>
          <ButtonRow>
            <Button small title="Edit" onPress={() => setDraft({ id: p.id, title: p.title, slug: p.slug, description: p.description ?? "", checkIds: p.checkIds, published: p.published })} />
            {p.published ? <Button small title="Open" onPress={() => void Linking.openURL(`${session.serverUrl}/status/${p.slug}`)} /> : null}
            <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete "${p.title}"?`, "Its public address stops working.", async () => {
              await api.deleteStatusPage(p.id).catch((e) => tell("That didn't work", errorText(e)));
              void reload();
            })} />
          </ButtonRow>
        </Card>
      ))}
    </Screen>
  );
}
