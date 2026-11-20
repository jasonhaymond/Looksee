// Create or edit a group. A manual group lists its members (locations, sites,
// endpoints, checks) picked by hand; a filter group keeps itself up to date
// from rules ("checks whose type is ping and tag contains core"), previewed
// before saving. Params: id (edit), or nothing (create).

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, own, type GroupDetail, type GroupFields, type GroupRules, type MemberType } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, Chip, Chips, ErrorBox, Field, Loading, Screen, Select, T } from "../../../components/ui";

type Options = { locations: { id: string; name: string }[]; sites: { id: string; name: string }[]; endpoints: { id: string; name: string }[]; checks: { id: string; name: string }[] };

export default function GroupEdit() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const load = useCallback(async () => {
    const [detail, fields, locations, sites, endpoints, checks] = await Promise.all([id ? api.group(id) : Promise.resolve(null), api.groupFields(), api.locations(), api.sites(), api.endpoints(), api.checks()]);
    return { detail, fields, options: { locations, sites, endpoints, checks } };
  }, [id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  return <Form {...data} />;
}

function Form({ detail, fields, options }: { detail: GroupDetail | null; fields: GroupFields; options: Options }) {
  const g = detail?.group;
  const [name, setName] = useState(g?.name ?? "");
  const [description, setDescription] = useState(g?.description ?? "");
  const [kind, setKind] = useState<"manual" | "filter">(g?.kind ?? "manual");
  const [target, setTarget] = useState<MemberType>(g?.target ?? "check");
  const [rules, setRules] = useState<GroupRules>(g?.rules?.conditions?.length ? g.rules : { match: "all", conditions: [{ field: fields.fields.check[0]?.field ?? "name", op: fields.ops[0] ?? "contains", value: "" }] });
  // Manual members by type, starting from the current ones.
  const [members, setMembers] = useState<Record<MemberType, string[]>>({
    location: detail?.members.locations.map((x) => x.id) ?? [],
    site: detail?.members.sites.map((x) => x.id) ?? [],
    endpoint: detail?.members.endpoints.map((x) => x.id) ?? [],
    check: detail?.members.checks.map((x) => x.id) ?? [],
  });
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const setCond = (i: number, patch: Partial<GroupRules["conditions"][number]>) => setRules((r) => ({ ...r, conditions: r.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)) }));

  async function save() {
    if (!name.trim()) return setErr("Name is required.");
    setBusy(true);
    setErr(null);
    const all = (Object.entries(members) as [MemberType, string[]][]).flatMap(([type, ids]) => ids.map((mid) => ({ type, id: mid })));
    try {
      if (g) {
        await api.updateGroup(g.id, { name: name.trim(), description: description.trim() || null, ...(kind === "filter" ? { target, rules } : {}) });
        if (kind === "manual") {
          const before = [...detail!.members.locations.map((x) => ({ type: "location" as const, id: x.id })), ...detail!.members.sites.map((x) => ({ type: "site" as const, id: x.id })), ...detail!.members.endpoints.map((x) => ({ type: "endpoint" as const, id: x.id })), ...detail!.members.checks.map((x) => ({ type: "check" as const, id: x.id }))];
          const key = (m: { type: string; id: string }) => `${m.type}:${m.id}`;
          await api.groupMembers(g.id, { add: all.filter((m) => !before.some((b) => key(b) === key(m))), remove: before.filter((b) => !all.some((m) => key(m) === key(b))) });
        }
        router.back();
      } else {
        const created = await api.createGroup({ name: name.trim(), description: description.trim() || null, kind, ...(kind === "filter" ? { target, rules } : { members: all }) });
        router.replace(`/groups/${created.id}`);
      }
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: g ? `Edit: ${g.name}` : "New group" }} />
      <Card>
        <Field label="Name *" value={name} onChangeText={setName} />
        <Field label="Description" value={description} onChangeText={setDescription} />
        {!g ? (
          <Chips>
            <Chip label="Pick members" on={kind === "manual"} onPress={() => setKind("manual")} />
            <Chip label="Filter (keeps itself up to date)" on={kind === "filter"} onPress={() => setKind("filter")} />
          </Chips>
        ) : null}
      </Card>
      {kind === "manual" ? (
        <Card title="Members">
          <Select multi label="Locations" value={members.location} onChange={(v) => setMembers((m) => ({ ...m, location: v }))} options={options.locations.map((x) => ({ value: x.id, label: x.name }))} placeholder="None" />
          <Select multi label="Sites" value={members.site} onChange={(v) => setMembers((m) => ({ ...m, site: v }))} options={options.sites.map((x) => ({ value: x.id, label: x.name }))} placeholder="None" />
          <Select multi label="Endpoints" value={members.endpoint} onChange={(v) => setMembers((m) => ({ ...m, endpoint: v }))} options={options.endpoints.map((x) => ({ value: x.id, label: x.name }))} placeholder="None" />
          <Select multi label="Checks" value={members.check} onChange={(v) => setMembers((m) => ({ ...m, check: v }))} options={options.checks.map((x) => ({ value: x.id, label: x.name }))} placeholder="None" />
        </Card>
      ) : (
        <Card title="Filter">
          <Select label="Selects" value={target} onChange={(v) => setTarget(v as MemberType)} options={(["location", "site", "endpoint", "check"] as MemberType[]).map((t) => ({ value: t, label: `${t}s` }))} />
          <Chips>
            <Chip label="Match all rules" on={rules.match === "all"} onPress={() => setRules((r) => ({ ...r, match: "all" }))} />
            <Chip label="Match any rule" on={rules.match === "any"} onPress={() => setRules((r) => ({ ...r, match: "any" }))} />
          </Chips>
          {rules.conditions.map((c, i) => (
            <View key={i} style={{ gap: 6 }}>
              <Select label={`Rule ${i + 1}: field`} value={c.field} onChange={(v) => setCond(i, { field: v })} options={(own(fields.fields, target) ?? []).map((f) => ({ value: f.field, label: f.label, sub: f.hint }))} />
              <Select label="Condition" value={c.op} onChange={(v) => setCond(i, { op: v })} options={fields.ops.map((o) => ({ value: o, label: o }))} />
              <Field label="Value" value={c.value} onChangeText={(t) => setCond(i, { value: t })} autoCapitalize="none" />
              {rules.conditions.length > 1 ? <Button small title="Remove rule" onPress={() => setRules((r) => ({ ...r, conditions: r.conditions.filter((_, j) => j !== i) }))} /> : null}
            </View>
          ))}
          <ButtonRow>
            <Button small icon="add" title="Rule" onPress={() => setRules((r) => ({ ...r, conditions: [...r.conditions, { field: own(fields.fields, target)?.[0]?.field ?? "name", op: fields.ops[0] ?? "contains", value: "" }] }))} />
            <Button small title="Preview matches" onPress={async () => {
              try {
                const p = await api.groupPreview(target, rules);
                setPreview(`${p.total} match: ${p.matches.slice(0, 10).map((x) => x.name).join(", ")}${p.total > 10 ? "…" : ""}`);
              } catch (e) {
                setPreview(errorText(e));
              }
            }} />
          </ButtonRow>
          {preview ? <T size="s">{preview}</T> : null}
        </Card>
      )}
      <ErrorBox error={err} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={g ? "Save" : "Create group"} variant="primary" busy={busy} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
