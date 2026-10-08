"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type Channel, type Check, type Endpoint, type Host, type HostDetail, type MetricDef } from "../lib/api";
import { CATEGORIES, CHECK_TYPES, TYPE_BY_KEY, defaultConfigFor, normalizeConfig, validateConfig, type Field } from "../lib/checkTypes";
import { Button, Label, inputClass } from "./ui";
import { Tooltip } from "./Tooltip";

let catalogPromise: Promise<MetricDef[]> | null = null;
const loadCatalog = () => (catalogPromise ??= api.hostMetricCatalog());

const hostCache = new Map<string, Promise<HostDetail>>();
const loadHost = (id: string) => {
  if (!hostCache.has(id)) hostCache.set(id, api.host(id));
  return hostCache.get(id)!;
};

export function TypePicker({ onPick, onCancel }: { onPick: (type: string) => void; onCancel?: () => void }) {
  const [q, setQ] = useState("");
  const query = q.trim().toLowerCase();
  const visible = CHECK_TYPES.filter((t) => !t.legacy && (!query || `${t.label} ${t.description} ${t.category} ${t.type}`.toLowerCase().includes(query)));
  return (
    <div className="space-y-4">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search check types — e.g. disk, ssl, docker, backup, printer…" className={inputClass} />
      {CATEGORIES.map((cat) => {
        const types = visible.filter((t) => t.category === cat);
        if (!types.length) return null;
        return (
          <section key={cat}>
            <h3 className="mb-2 text-xs uppercase tracking-wide text-[var(--muted)]">{cat}</h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {types.map((t) => (
                <button key={t.type} onClick={() => onPick(t.type)} className="rounded-lg border border-[var(--border)] p-2.5 text-left hover:border-[var(--muted)] hover:bg-[var(--border)]/20">
                  <span className="block text-sm font-medium">{t.label}</span>
                  <span className="mt-0.5 block text-xs text-[var(--muted)]">{t.description}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
      {visible.length === 0 && <p className="text-sm text-[var(--muted)]">No check type matches “{q}”.</p>}
      {onCancel && (
        <div className="flex justify-end">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}

function suggestionsFor(kind: Field["suggest"], host: HostDetail | null, metric?: MetricDef): string[] {
  if (!host) return [];
  const snap = host.lastSnapshot;
  switch (kind ?? metric?.instance) {
    case "services":
      return host.availableServices ?? [];
    case "processes":
      return host.availableProcesses ?? [];
    case "containers":
      return snap?.availableContainers ?? [];
    case "mounts":
    case "mount":
      return snap?.disks?.map((d) => d.mount) ?? [];
    case "interfaces":
    case "interface":
      return snap?.net?.map((n) => n.name) ?? [];
    case "device":
    case "devices":
      return [...(snap?.smart?.map((s) => s.device) ?? [])];
    case "sensor":
      return snap?.temps?.map((t) => t.sensor) ?? [];
    case "array":
      return snap?.raid?.map((r) => r.name) ?? [];
    case "port":
      return snap?.listening?.map((l) => String(l.port)) ?? [];
    default:
      return [];
  }
}

function FieldInput({ field, value, onChange, host, checks, editing }: { field: Field; value: unknown; onChange: (v: unknown) => void; host: HostDetail | null; checks: Check[]; editing: boolean }) {
  const str = value == null ? "" : String(value);
  const listId = `dl-${field.key}`;
  switch (field.kind) {
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value === true || value === "true"} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--up)]" />
          <span>{field.label}</span>
          {field.help && <Tooltip text={field.help} />}
        </label>
      );
    case "select":
      return (
        <Label label={field.label} help={field.help}>
          <select value={str} onChange={(e) => onChange(e.target.value)} className={inputClass}>
            {field.options!.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </Label>
      );
    case "multi": {
      const set = new Set(str.split(",").map((s) => s.trim()).filter(Boolean));
      return (
        <Label label={field.label} help={field.help}>
          <span className="flex flex-wrap gap-3 pt-1">
            {field.options!.map((o) => (
              <label key={o.value} className="flex items-center gap-1.5 text-sm">
                <input
                  type="checkbox"
                  checked={set.has(o.value)}
                  onChange={(e) => {
                    const next = new Set(set);
                    if (e.target.checked) next.add(o.value);
                    else next.delete(o.value);
                    onChange([...next].join(","));
                  }}
                  className="accent-[var(--up)]"
                />
                {o.label}
              </label>
            ))}
          </span>
        </Label>
      );
    }
    case "textarea":
      return (
        <Label label={field.label} help={field.help}>
          <textarea value={str} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} rows={3} className={`${inputClass} font-mono text-xs`} />
        </Label>
      );
    case "secret":
      return (
        <Label label={field.label} help={(field.help ? `${field.help} ` : "") + "Write-only: never shown again after saving."}>
          <input type="password" autoComplete="new-password" value={str} onChange={(e) => onChange(e.target.value)} placeholder={editing && str ? "saved — type to replace" : field.placeholder} className={inputClass} />
        </Label>
      );
    case "checkref":
      return (
        <Label label={field.label} help={field.help}>
          <select value={str} onChange={(e) => onChange(e.target.value)} className={inputClass}>
            <option value="">Choose a check…</option>
            {checks.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </Label>
      );
    default: {
      const suggestions = suggestionsFor(field.suggest, host);
      return (
        <Label label={field.label + (field.required ? " *" : "")} help={field.help}>
          <input type={field.kind === "number" ? "number" : "text"} value={str} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} list={suggestions.length ? listId : undefined} className={inputClass} />
          {suggestions.length > 0 && (
            <datalist id={listId}>
              {suggestions.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          )}
        </Label>
      );
    }
  }
}

function MetricFields({ config, set, host }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void; host: HostDetail | null }) {
  const [catalog, setCatalog] = useState<MetricDef[]>([]);
  useEffect(() => {
    loadCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);
  const metric = catalog.find((m) => m.key === config.metric);
  const groups = [...new Set(catalog.map((m) => m.group))];
  const suggestions = metric ? suggestionsFor(undefined, host, metric) : [];
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Label label="Metric *" help={metric?.help ?? "What to measure on the host."} className="sm:col-span-2">
        <select value={String(config.metric ?? "")} onChange={(e) => set("metric", e.target.value)} className={inputClass}>
          <option value="">Choose a metric…</option>
          {groups.map((g) => (
            <optgroup key={g} label={g}>
              {catalog
                .filter((m) => m.group === g)
                .map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                    {m.unit ? ` (${m.unit.trim()})` : ""}
                    {m.platforms ? ` — ${m.platforms}` : ""}
                  </option>
                ))}
            </optgroup>
          ))}
        </select>
      </Label>
      {metric?.instance && (
        <Label label={`${metric.instance[0].toUpperCase()}${metric.instance.slice(1)}${metric.instanceRequired ? " *" : " (blank = all)"}`} help={metric.instanceRequired ? undefined : `Leave blank to evaluate every ${metric.instance} and report the worst.`}>
          <input value={String(config.instance ?? "")} onChange={(e) => set("instance", e.target.value)} list="dl-instance" className={inputClass} placeholder={suggestions[0] ?? ""} />
          <datalist id="dl-instance">
            {suggestions.map((s) => (
              <option key={s} value={s} />
            ))}
          </datalist>
        </Label>
      )}
      {metric?.kind === "boolean" && (
        <>
          <Label label="Healthy when">
            <select value={String(config.expect ?? metric.expect ?? true)} onChange={(e) => set("expect", e.target.value === "true")} className={inputClass}>
              <option value="true">yes / true</option>
              <option value="false">no / false</option>
            </select>
          </Label>
          <Label label="Status otherwise">
            <select value={String(config.severity ?? "down")} onChange={(e) => set("severity", e.target.value)} className={inputClass}>
              <option value="down">Down (critical)</option>
              <option value="warn">Warn</option>
            </select>
          </Label>
        </>
      )}
      {!host?.hasSnapshot && host && <p className="text-xs text-[var(--warn)] sm:col-span-2">This host hasn&apos;t sent a 3.x agent report yet — update its agent to see real names here.</p>}
    </div>
  );
}

function ThresholdFields({ config, set, unit, hint, latency }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void; unit?: string; hint?: string; latency?: boolean }) {
  const num = (key: string, label: string, placeholder?: string) => (
    <Label label={label}>
      <input type="number" value={config[key] == null ? "" : String(config[key])} onChange={(e) => set(key, e.target.value)} placeholder={placeholder} className={inputClass} />
    </Label>
  );
  return (
    <div className="space-y-3">
      {unit !== undefined && (
        <div>
          <p className="mb-2 text-xs text-[var(--muted)]">
            Value: {hint}
            {unit ? ` (${unit.trim()})` : ""}. Fill in only the directions you care about.
          </p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {num("warnAbove", "Warn above")}
            {num("criticalAbove", "Critical above")}
            {num("warnBelow", "Warn below")}
            {num("criticalBelow", "Critical below")}
          </div>
        </div>
      )}
      {latency && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {num("latencyWarnMs", "Warn if slower than (ms)")}
          {num("latencyCriticalMs", "Critical if slower than (ms)")}
        </div>
      )}
    </div>
  );
}

function Section({ title, children, defaultOpen = true }: { title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen} className="rounded-lg border border-[var(--border)] p-3">
      <summary className="cursor-pointer select-none text-sm font-medium">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

export function CheckForm({
  type,
  check,
  endpoints,
  hosts,
  checks,
  channels = [],
  defaultEndpointId,
  defaultHostId,
  onSaved,
  onCancel,
  onChangeType,
}: {
  type: string;
  check?: Check;
  endpoints: Endpoint[];
  hosts: Host[];
  checks: Check[];
  channels?: Channel[];
  defaultEndpointId?: string;
  defaultHostId?: string;
  onSaved: (check: Check) => void;
  onCancel: () => void;
  onChangeType?: () => void;
}) {
  const def = TYPE_BY_KEY.get(type)!;
  const editing = Boolean(check);
  const [name, setName] = useState(check?.name ?? "");
  const [endpointId, setEndpointId] = useState(check?.endpointId ?? defaultEndpointId ?? endpoints[0]?.id ?? "");
  const [hostId, setHostId] = useState(check?.hostId ?? defaultHostId ?? "");
  const [probeHostId, setProbeHostId] = useState(check?.probeHostId ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(check ? { ...check.config } : defaultConfigFor(type));
  const [interval, setIntervalSecs] = useState(String(check?.intervalSeconds ?? (type === "heartbeat" || type === "push_value" ? 3600 : 60)));
  const [retry, setRetry] = useState(check?.retryIntervalSeconds != null ? String(check.retryIntervalSeconds) : "");
  const [enabled, setEnabled] = useState(check?.enabled ?? true);
  const [tags, setTags] = useState((check?.tags ?? []).join(", "));
  const [dependsOn, setDependsOn] = useState<string[]>(check?.dependsOn ?? []);
  const [alertChannels, setAlertChannels] = useState<string[]>([]);
  const [alertOnWarn, setAlertOnWarn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [host, setHost] = useState<HostDetail | null>(null);

  const selectedHostId = hostId || probeHostId;
  useEffect(() => {
    if (!selectedHostId) {
      setHost(null);
      return;
    }
    loadHost(selectedHostId).then(setHost).catch(() => setHost(null));
  }, [selectedHostId]);

  const set = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  const visibleFields = def.fields.filter((f) => !f.showIf || f.showIf(config));
  // The metric picker renders its own fields (MetricFields), not via FieldInput.
  const basic = visibleFields.filter((f) => !f.advanced && f.kind !== "metric");
  const advanced = visibleFields.filter((f) => f.advanced);
  const otherChecks = useMemo(() => checks.filter((c) => c.id !== check?.id), [checks, check?.id]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeConfig(type, config);
    const invalid = validateConfig(type, normalized) ?? (!name.trim() ? "Name is required." : null) ?? (def.needsHost && !hostId ? "Choose the host this check runs on." : null) ?? (!endpointId ? "Choose an endpoint." : null);
    if (invalid) {
      setError(invalid);
      return;
    }
    const body = {
      name: name.trim(),
      endpointId,
      hostId: hostId || null,
      probeHostId: def.remoteProbe && probeHostId ? probeHostId : null,
      config: normalized,
      intervalSeconds: Number(interval) || 60,
      retryIntervalSeconds: retry ? Number(retry) : null,
      enabled,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      dependsOn,
    };
    setSaving(true);
    try {
      const saved = check ? await api.updateCheck(check.id, body) : await api.createCheck({ ...body, type });
      if (!check && alertChannels.length) {
        await api.createAlertRule({ checkId: saved.id, consecutiveFailures: 2, triggerOn: alertOnWarn ? "warn" : "down", channelIds: alertChannels });
      }
      onSaved(saved);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const agentHosts = hosts.filter((h) => h.hasAgentKey || h.agentVersion);

  return (
    <form onSubmit={handleSubmit} className="space-y-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-[var(--muted)]">
          <span className="font-medium text-[var(--text)]">{def.label}</span> — {def.description}
        </p>
        {!editing && onChangeType && (
          <button type="button" onClick={onChangeType} className="text-xs underline text-[var(--muted)]">
            change type
          </button>
        )}
      </div>

      <Section title="Basics">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label label="Name *" className="sm:col-span-2">
            <input autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} placeholder={`e.g. ${def.label} — office router`} className={inputClass} />
          </Label>
          <Label label="Endpoint" help="The group / network this check belongs to.">
            <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className={inputClass}>
              {endpoints.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </Label>
          <Label label={def.needsHost ? "Host *" : "Host (optional)"} help={def.needsHost ? "The machine whose agent runs this check." : "Ties the check to a host for grouping; doesn't change where it runs."}>
            <select value={hostId} onChange={(e) => setHostId(e.target.value)} className={inputClass}>
              <option value="">{def.needsHost ? "Choose a host…" : "None"}</option>
              {hosts.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                  {h.agentVersion ? ` (agent ${h.agentVersion})` : ""}
                </option>
              ))}
            </select>
          </Label>
          {def.remoteProbe && (
            <Label label="Run from" help="The engine itself, or a host's agent — for targets only reachable from inside that host's network.">
              <select value={probeHostId} onChange={(e) => setProbeHostId(e.target.value)} className={inputClass}>
                <option value="">Looksee engine</option>
                {agentHosts.map((h) => (
                  <option key={h.id} value={h.id}>
                    Agent on {h.name}
                  </option>
                ))}
              </select>
            </Label>
          )}
          <Label label={type === "heartbeat" || type === "push_value" ? "Expect a ping every (seconds)" : "Check every (seconds)"}>
            <input type="number" min={5} value={interval} onChange={(e) => setIntervalSecs(e.target.value)} className={inputClass} />
          </Label>
        </div>
      </Section>

      <Section title="Settings">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {type === "host_metric" && (
            <div className="sm:col-span-2">
              <MetricFields config={config} set={set} host={host} />
            </div>
          )}
          {basic.map((f) => (
            <div key={f.key} className={f.wide || f.kind === "textarea" || f.kind === "checkbox" ? "sm:col-span-2" : ""}>
              <FieldInput field={f} value={config[f.key]} onChange={(v) => set(f.key, v)} host={host} checks={otherChecks} editing={editing} />
            </div>
          ))}
          {basic.length === 0 && type !== "host_metric" && <p className="text-xs text-[var(--muted)]">Nothing else to configure.</p>}
        </div>
      </Section>

      {(def.value || def.latency) && (
        <Section title="Thresholds" defaultOpen={Boolean(def.value && (type === "host_metric" || type === "push_value" || type === "prometheus" || type === "agent_process"))}>
          <ThresholdFields config={config} set={set} unit={def.value?.unit} hint={def.value?.hint} latency={def.latency} />
        </Section>
      )}

      <Section title="Advanced" defaultOpen={false}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {advanced.map((f) => (
            <div key={f.key} className={f.wide || f.kind === "textarea" || f.kind === "checkbox" ? "sm:col-span-2" : ""}>
              <FieldInput field={f} value={config[f.key]} onChange={(v) => set(f.key, v)} host={host} checks={otherChecks} editing={editing} />
            </div>
          ))}
          <Label label="Retry every (seconds) while failing" help="Re-check sooner while the check isn't up, so recoveries and N-in-a-row alerts land faster. Blank = normal interval.">
            <input type="number" min={5} value={retry} onChange={(e) => setRetry(e.target.value)} className={inputClass} />
          </Label>
          <Label label="Tags" help="Comma-separated. Filter and bulk-select by tag on the Checks page.">
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="core, lan, backups" className={inputClass} />
          </Label>
          <Label label="Depends on" help="While any of these is down, this check's alerts are held back (e.g. a router everything else sits behind)." className="sm:col-span-2">
            <select
              multiple
              value={dependsOn}
              onChange={(e) => setDependsOn([...e.target.selectedOptions].map((o) => o.value))}
              className={`${inputClass} h-24`}
            >
              {otherChecks.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </Label>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-[var(--up)]" />
            Enabled
          </label>
        </div>
      </Section>

      {!editing && channels.length > 0 && (
        <Section title="Alert me (optional)" defaultOpen={false}>
          <p className="mb-2 text-xs text-[var(--muted)]">Adds an alert rule (2 failures in a row). More options — escalation, reminders — are under the check&apos;s Alerts tab afterwards.</p>
          <div className="flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5">
                <input type="checkbox" className="accent-[var(--up)]" checked={alertChannels.includes(c.id)} onChange={(e) => setAlertChannels((prev) => (e.target.checked ? [...prev, c.id] : prev.filter((x) => x !== c.id)))} />
                {c.name}
              </label>
            ))}
          </div>
          <label className="mt-2 flex items-center gap-1.5 text-xs text-[var(--muted)]">
            <input type="checkbox" className="accent-[var(--up)]" checked={alertOnWarn} onChange={(e) => setAlertOnWarn(e.target.checked)} />
            Also alert on warnings
          </label>
        </Section>
      )}

      {error && <p className="text-sm text-[var(--down)]">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : "Create check"}
        </Button>
      </div>
    </form>
  );
}
