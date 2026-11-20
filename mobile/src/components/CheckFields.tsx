// The inputs for a check's own settings, driven by the shared check-type
// registry (dashboard/app/lib/checkTypes.ts): each setting has a kind (text,
// number, choice, on/off, several choices, long text, write-only secret, or
// "another check"), and this file draws the matching input. Also the
// endpoint-metric picker (host_metric checks) and the warn/critical threshold
// inputs. Used by the check form and by "Edit settings on many".
//
// Values are kept as the user typed them (numbers as text); the registry's
// normalizeConfig() turns them into proper values before saving, exactly as
// the dashboard does.
//
// Secrets: the engine never sends a saved secret back; it sends a mask
// ("••••••••") in its place, which is saved back unchanged unless the user
// types a new value, so editing other settings never wipes a password.

import { useEffect, useState } from "react";
import { View } from "react-native";
import { api, own, type Check, type EndpointDetail, type EndpointInventory, type Field as FieldDef, type MetricDef } from "../lib/shared";
import { Field, Select, T, Toggle, type Option } from "./ui";

/** Names the agent reported on the endpoint, offered for a setting that names a service, process, disk… */
export function suggestionsFor(kind: FieldDef["suggest"] | string | undefined, host: EndpointDetail | null, inv: EndpointInventory | null): Option[] {
  const snap = host?.lastSnapshot;
  const names = (xs: string[] | null | undefined) => (xs ?? []).map((x) => ({ value: x, label: x }));
  switch (kind) {
    case "services":
      return inv?.services?.length ? inv.services.map((s) => ({ value: s.name, label: s.displayName && s.displayName !== s.name ? `${s.name} — ${s.displayName}` : s.name, sub: s.state })) : names(host?.availableServices);
    case "processes":
      return inv?.processes?.length ? [...new Set(inv.processes.map((p) => p.name))].sort().map((n) => ({ value: n, label: n })) : names(host?.availableProcesses);
    case "containers":
      return names(inv?.containers ?? snap?.availableContainers);
    case "scripts":
      return names(inv?.scripts ?? host?.availableScripts);
    case "mounts":
    case "mount":
      return (snap?.disks ?? []).map((d) => ({ value: d.mount, label: d.mount, sub: `${d.percent.toFixed(0)}% used` }));
    case "interfaces":
    case "interface":
      return (snap?.net ?? []).map((n) => ({ value: n.name, label: n.name, sub: n.up ? "up" : "down" }));
    case "device":
    case "devices":
      return (snap?.smart ?? []).map((s) => ({ value: s.device, label: s.device, sub: s.model }));
    case "sensor":
      return (snap?.temps ?? []).map((t) => ({ value: t.sensor, label: t.sensor, sub: `${t.celsius}°C` }));
    case "array":
      return (snap?.raid ?? []).map((r) => ({ value: r.name, label: r.name, sub: r.kind }));
    case "port":
      return (snap?.listening ?? []).map((l) => ({ value: String(l.port), label: `${l.port}/${l.proto}`, sub: l.process }));
    default:
      return [];
  }
}

/**
 * One setting's input.
 * @param suggestions names from the endpoint's agent ("Pick from the endpoint" list)
 * @param checks the checks a "checkref" setting may point at
 */
export function SettingInput({ field, value, onChange, suggestions = [], checks = [] }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; suggestions?: Option[]; checks?: Check[] }) {
  const str = value == null ? "" : String(value);
  const label = field.label + (field.required ? " *" : "");
  switch (field.kind) {
    case "checkbox":
      return <Toggle label={field.label} help={field.help} value={value === true || value === "true"} onChange={onChange} />;
    case "select":
      return <Select label={label} help={field.help} options={field.options ?? []} value={str} onChange={onChange} />;
    case "multi": {
      const chosen = str.split(",").map((s) => s.trim()).filter(Boolean);
      return <Select multi label={label} help={field.help} options={field.options ?? []} value={chosen} onChange={(v: string[]) => onChange(v.join(","))} />;
    }
    case "checkref":
      return <Select label={label} help={field.help} options={checks.map((c) => ({ value: c.id, label: c.name }))} value={str} onChange={onChange} placeholder="Choose a check…" />;
    case "textarea":
      return <Field label={label} help={field.help} value={str} onChangeText={onChange} placeholder={field.placeholder} multiline autoCapitalize="none" autoCorrect={false} style={{ fontFamily: "monospace", fontSize: 13 }} />;
    case "secret":
      return <Field label={label} help={`${field.help ? `${field.help} ` : ""}Write-only: never shown again after saving.`} value={str.startsWith("••") ? "" : str} onChangeText={onChange} placeholder={str.startsWith("••") ? "saved — type to replace" : field.placeholder} secureTextEntry autoCapitalize="none" />;
    default:
      return (
        <View style={{ gap: 6 }}>
          <Field label={label} help={field.help} value={str} onChangeText={onChange} placeholder={field.placeholder} keyboardType={field.kind === "number" ? "numeric" : "default"} autoCapitalize="none" autoCorrect={false} />
          {suggestions.length ? <Select label={`Pick from the endpoint (${suggestions.length})`} options={suggestions} value={str} onChange={onChange} placeholder="From the agent's latest report…" /> : null}
        </View>
      );
  }
}

let catalog: Promise<MetricDef[]> | null = null;

/** The metric picker for "Endpoint metric" checks: which metric, which instance, and for yes/no metrics what's healthy. */
export function MetricPicker({ config, set, host, inv }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void; host: EndpointDetail | null; inv: EndpointInventory | null }) {
  const [defs, setDefs] = useState<MetricDef[]>([]);
  useEffect(() => {
    (catalog ??= api.endpointMetricCatalog()).then(setDefs).catch(() => setDefs([]));
  }, []);
  const metric = defs.find((m) => m.key === config.metric);
  const instances = metric?.instance ? suggestionsFor(metric.instance, host, inv) : [];
  return (
    <View style={{ gap: 10 }}>
      <Select label="Metric *" help={metric?.help} value={String(config.metric ?? "")} onChange={(v) => set("metric", v)} options={defs.map((m) => ({ value: m.key, label: `${m.label}${m.unit ? ` (${m.unit.trim()})` : ""}`, sub: [m.group, m.platforms].filter(Boolean).join(" · ") }))} />
      {metric?.instance ? (
        <Select
          label={`${metric.instance[0].toUpperCase()}${metric.instance.slice(1)}${metric.instanceRequired ? " *" : ""}`}
          value={String(config.instance ?? "")}
          onChange={(v) => set("instance", v)}
          options={[...(metric.instanceRequired ? [] : [{ value: "", label: `All ${metric.instance}s (worst wins)` }]), ...instances]}
        />
      ) : null}
      {metric?.kind === "boolean" ? (
        <>
          <Select label="Healthy when" value={String(config.expect ?? metric.expect ?? true)} onChange={(v) => set("expect", v === "true")} options={[{ value: "true", label: "yes / true" }, { value: "false", label: "no / false" }]} />
          <Select label="Status otherwise" value={String(config.severity ?? "down")} onChange={(v) => set("severity", v)} options={[{ value: "down", label: "Down (critical)" }, { value: "warn", label: "Warn" }]} />
        </>
      ) : null}
    </View>
  );
}

/** Warn/critical thresholds for the check's value and/or response time. */
export function Thresholds({ config, set, unit, hint, latency }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void; unit?: string; hint?: string; latency?: boolean }) {
  const num = (key: string, label: string) => (
    <View style={{ flexBasis: "47%", flexGrow: 1 }}>
      <Field label={label} value={own(config, key) == null ? "" : String(own(config, key))} onChangeText={(t) => set(key, t)} keyboardType="numeric" />
    </View>
  );
  return (
    <View style={{ gap: 8 }}>
      {unit !== undefined ? (
        <>
          <T size="s" muted>Value: {hint}{unit ? ` (${unit.trim()})` : ""}. Fill in only the directions you care about.</T>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {num("warnAbove", "Warn above")}
            {num("criticalAbove", "Critical above")}
            {num("warnBelow", "Warn below")}
            {num("criticalBelow", "Critical below")}
          </View>
        </>
      ) : null}
      {latency ? (
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {num("latencyWarnMs", "Warn if slower than (ms)")}
          {num("latencyCriticalMs", "Critical if slower than (ms)")}
        </View>
      ) : null}
    </View>
  );
}
