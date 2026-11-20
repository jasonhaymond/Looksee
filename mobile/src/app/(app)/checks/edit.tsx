// The check form: create a check (on one or several endpoints or sites at
// once) or edit one. Sections: where it runs and how often; the type's own
// settings (from the shared registry, advanced ones folded away); thresholds;
// advanced (retry interval, timeouts before down, tags, depends on, recovers
// together with, enabled); and, when creating, an alert rule.
//
// Params: id (edit that check), or type (+ optional siteId/endpointId) to create.
// Validation and value clean-up use the same registry functions as the
// dashboard (validateConfig / normalizeConfig); the engine validates again.

import { useCallback, useEffect, useMemo, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { api, TYPE_BY_KEY, defaultConfigFor, normalizeConfig, validateConfig, type Check, type EndpointDetail, type EndpointInventory } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { errorText } from "../../../lib/format";
import { Button, ButtonRow, Card, ErrorBox, Field, Loading, Screen, Select, T, Toggle } from "../../../components/ui";
import { MetricPicker, SettingInput, Thresholds, suggestionsFor } from "../../../components/CheckFields";
import { AlertRuleForm, emptyRule, rulePayload, type RuleValue } from "../../../components/AlertRuleForm";

export default function CheckEdit() {
  const params = useLocalSearchParams<{ id?: string; type?: string; siteId?: string; endpointId?: string }>();
  const load = useCallback(async () => {
    const [check, sites, endpoints, checks, channels] = await Promise.all([params.id ? api.check(params.id) : Promise.resolve(null), api.sites(), api.endpoints(), api.checks(), api.channels()]);
    return { check, sites, endpoints, checks, channels };
  }, [params.id]);
  const { data, error, loading } = useLoad(load);
  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const type = data.check?.type ?? params.type ?? "";
  if (!TYPE_BY_KEY.get(type)) return <Screen><ErrorBox error={`Unknown check type "${type}".`} /></Screen>;
  return <Form key={data.check?.id ?? type} type={type} initial={data.check} {...data} defaultSiteId={params.siteId} defaultEndpointId={params.endpointId} />;
}

function Form({ type, initial, sites, endpoints, checks, channels: loadedChannels, defaultSiteId, defaultEndpointId }: {
  type: string;
  initial: Check | null;
  sites: Awaited<ReturnType<typeof api.sites>>;
  endpoints: Awaited<ReturnType<typeof api.endpoints>>;
  checks: Check[];
  channels: Awaited<ReturnType<typeof api.channels>>;
  defaultSiteId?: string;
  defaultEndpointId?: string;
}) {
  const def = TYPE_BY_KEY.get(type)!;
  const editing = Boolean(initial);
  const [name, setName] = useState(initial?.name ?? "");
  const [siteId, setSiteId] = useState(initial?.siteId ?? defaultSiteId ?? sites[0]?.id ?? "");
  const [endpointId, setEndpointId] = useState(initial?.endpointId ?? defaultEndpointId ?? "");
  // Creating: one check per chosen endpoint, else per chosen site.
  const [endpointIds, setEndpointIds] = useState<string[]>(defaultEndpointId ? [defaultEndpointId] : []);
  const [siteIds, setSiteIds] = useState<string[]>(defaultSiteId ? [defaultSiteId] : sites[0] ? [sites[0].id] : []);
  const [probeEndpointId, setProbe] = useState(initial?.probeEndpointId ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(initial ? { ...initial.config } : defaultConfigFor(type));
  const [interval, setInterval_] = useState(String(initial?.intervalSeconds ?? (type === "heartbeat" || type === "push_value" ? 3600 : (def.defaultInterval ?? 60))));
  const [retry, setRetry] = useState(initial?.retryIntervalSeconds != null ? String(initial.retryIntervalSeconds) : "");
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);
  const [tags, setTags] = useState((initial?.tags ?? []).join(", "));
  const [dependsOn, setDependsOn] = useState<string[]>(initial?.dependsOn ?? []);
  const [rule, setRule] = useState<RuleValue>(emptyRule());
  const [channels, setChannels] = useState(loadedChannels);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [host, setHost] = useState<EndpointDetail | null>(null);
  const [inv, setInv] = useState<EndpointInventory | null>(null);

  // The endpoint whose agent report feeds the "Pick from the endpoint" lists.
  const pickEndpoint = (def.otherAgent && probeEndpointId) || (editing ? endpointId : endpointIds[0]) || "";
  useEffect(() => {
    if (!pickEndpoint) return;
    api.endpoint(pickEndpoint).then(setHost).catch(() => setHost(null));
    api.endpointInventory(pickEndpoint).then(setInv).catch(() => setInv(null));
  }, [pickEndpoint]);

  const set = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  const visible = def.fields.filter((f) => !f.showIf || f.showIf(config));
  const basic = visible.filter((f) => !f.advanced && f.kind !== "metric");
  const advanced = visible.filter((f) => f.advanced);
  const others = useMemo(() => checks.filter((c) => c.id !== initial?.id), [checks, initial?.id]);
  const siteName = new Map(sites.map((s) => [s.id, s.name]));
  const endpointOptions = endpoints.map((e) => ({ value: e.id, label: e.name, sub: [siteName.get(e.siteId), e.agentVersion ? `agent ${e.agentVersion}` : "no agent"].filter(Boolean).join(" · ") }));
  const agentOptions = endpoints.filter((e) => e.hasAgentKey || e.agentVersion).map((e) => ({ value: e.id, label: `Agent on ${e.name}` }));

  /** Validates and saves; on success goes back (edit) or opens the new check. */
  async function save() {
    setError(null);
    const normalized = normalizeConfig(type, config);
    const target = editing
      ? def.needsEndpoint && !endpointId ? "Choose the endpoint this check runs on." : !siteId ? "Choose a site." : null
      : def.needsEndpoint ? (endpointIds.length ? null : "Choose at least one endpoint.") : endpointIds.length || siteIds.length ? null : "Choose at least one site or endpoint.";
    const invalid = validateConfig(type, normalized) ?? (!name.trim() ? "Name is required." : null) ?? target;
    if (invalid) return setError(invalid);
    const common = {
      probeEndpointId: (def.remoteProbe || def.otherAgent) && probeEndpointId ? probeEndpointId : null,
      intervalSeconds: Number(interval) || 60,
      retryIntervalSeconds: retry ? Number(retry) : null,
      enabled,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      dependsOn,
    };
    setSaving(true);
    try {
      if (initial) {
        await api.updateCheck(initial.id, { ...common, name: name.trim(), siteId, endpointId: endpointId || null, config: normalized });
        router.back();
        return;
      }
      const targets = endpointIds.length ? endpointIds.map((id) => ({ endpointId: id })) : siteIds.map((id) => ({ siteId: id }));
      const payload = rulePayload(rule);
      const res = await api.createChecksBatch({ ...common, type, name: name.trim(), config: normalized, targets, alertRule: payload.channelIds.length ? payload : null });
      if (!res.created.length) throw new Error(res.errors[0] ? `${res.errors[0].target}: ${res.errors[0].error}` : "Nothing was created");
      if (res.created.length === 1) router.replace(`/checks/${res.created[0].id}`);
      else router.back();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Screen>
      <Stack.Screen options={{ title: editing ? `Edit: ${initial!.name}` : `New: ${def.label}` }} />
      <T size="s" muted>{def.description}</T>
      <Card title="Basics">
        <Field label="Name *" value={name} onChangeText={setName} placeholder={`e.g. ${def.label} — office router`} help={!editing ? "With several endpoints or sites, {{endpoint}}, {{address}} and {{site}} are filled in for each one." : undefined} />
        {editing ? (
          <>
            <Select label="Site" value={siteId} onChange={setSiteId} options={sites.map((s) => ({ value: s.id, label: s.name }))} />
            <Select label={def.needsEndpoint ? "Endpoint *" : "Endpoint (optional)"} value={endpointId} onChange={setEndpointId} options={[...(def.needsEndpoint ? [] : [{ value: "", label: "None" }]), ...endpointOptions]} />
          </>
        ) : (
          <>
            <Select multi label={def.needsEndpoint ? "Endpoints * (one check each)" : "Endpoints (optional, one check each)"} value={endpointIds} onChange={setEndpointIds} options={endpointOptions} placeholder="None" />
            {!def.needsEndpoint && endpointIds.length === 0 ? <Select multi label="Sites * (one check each)" value={siteIds} onChange={setSiteIds} options={sites.map((s) => ({ value: s.id, label: s.name }))} /> : null}
          </>
        )}
        {def.remoteProbe ? <Select label="Run from" value={probeEndpointId} onChange={setProbe} options={[{ value: "", label: "Looksee engine" }, ...agentOptions]} help="An endpoint's agent, for targets only reachable from inside its network." /> : null}
        {def.otherAgent ? <Select label="Run by" value={probeEndpointId} onChange={setProbe} options={[{ value: "", label: "The endpoint's own agent" }, ...agentOptions]} help="Another endpoint's agent runs the script from its own script folder." /> : null}
        <Field label={type === "heartbeat" || type === "push_value" ? "Expect a ping every (seconds)" : "Check every (seconds)"} value={interval} onChangeText={setInterval_} keyboardType="number-pad" />
      </Card>

      <Card title="Settings">
        {type === "host_metric" ? <MetricPicker config={config} set={set} host={host} inv={inv} /> : null}
        {basic.map((f) => (
          <SettingInput key={f.key} field={f} value={config[f.key]} onChange={(v) => set(f.key, v)} suggestions={f.suggest ? suggestionsFor(f.suggest, host, inv) : []} checks={others} />
        ))}
        {basic.length === 0 && type !== "host_metric" ? <T muted size="s">Nothing else to configure.</T> : null}
      </Card>

      {def.value || def.latency ? (
        <Card title="Thresholds">
          <Thresholds config={config} set={set} unit={def.value?.unit} hint={def.value?.hint} latency={def.latency} />
        </Card>
      ) : null}

      <Card title="Advanced" action={<Button small title={showAdvanced ? "Hide" : "Show"} onPress={() => setShowAdvanced(!showAdvanced)} />}>
        {showAdvanced ? (
          <View style={{ gap: 10 }}>
            {advanced.map((f) => (
              <SettingInput key={f.key} field={f} value={config[f.key]} onChange={(v) => set(f.key, v)} checks={others} />
            ))}
            <Field label="Retry every (seconds) while failing" value={retry} onChangeText={setRetry} keyboardType="number-pad" placeholder="normal interval" help="Re-check sooner while the check isn't up." />
            <Field label="Timeouts in a row before down" value={config.timeoutsBeforeDown == null ? "" : String(config.timeoutsBeforeDown)} onChangeText={(t) => set("timeoutsBeforeDown", t === "" ? undefined : Number(t))} keyboardType="number-pad" placeholder="3" help="A timeout shows WARN first and goes DOWN after this many in a row." />
            <Field label="Tags" value={tags} onChangeText={setTags} placeholder="core, lan, backups" autoCapitalize="none" help="Comma-separated." />
            <Select multi label="Depends on" value={dependsOn} onChange={setDependsOn} options={others.map((c) => ({ value: c.id, label: c.name, sub: siteName.get(c.siteId) }))} placeholder="Nothing" help="While any of these is down, this check's alerts are held back." />
            <Select label="Recovers together with" value={String(config.recoverWithCheckId ?? "")} onChange={(v) => set("recoverWithCheckId", v || undefined)} options={[{ value: "", label: "— no —" }, ...others.map((c) => ({ value: c.id, label: c.name, sub: siteName.get(c.siteId) }))]} />
            <Toggle label="Enabled" value={enabled} onChange={setEnabled} />
          </View>
        ) : (
          <T size="s" muted>{advanced.length} more setting{advanced.length === 1 ? "" : "s"}, retry interval, tags, dependencies.</T>
        )}
      </Card>

      {!editing ? (
        <Card title="Alerts">
          <T size="s" muted>Pick channels to add an alert rule. None = the check still shows in the app and dashboard, but notifies no one.</T>
          <AlertRuleForm value={rule} onChange={setRule} channels={channels} onChannelCreated={(c) => setChannels((list) => [...list, c])} />
        </Card>
      ) : null}

      <ErrorBox error={error} />
      <ButtonRow>
        <Button title="Cancel" onPress={() => router.back()} />
        <Button title={saving ? "Saving…" : editing ? "Save changes" : "Create"} variant="primary" busy={saving} onPress={save} />
      </ButtonRow>
    </Screen>
  );
}
