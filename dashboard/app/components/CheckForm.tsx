"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type Channel, type Check, type Endpoint, type Host, type HostDetail, type HostInventory, type MetricDef, type WalkRow } from "../lib/api";
import { CATEGORIES, CHECK_TYPES, TYPE_BY_KEY, defaultConfigFor, normalizeConfig, validateConfig, type Field } from "../lib/checkTypes";
import { AlertOptions, Button, Label, Modal, MultiPicker, alertRulePayload, emptyAlertOptions, inputClass, type AlertOptionsValue, type PickItem } from "./ui";
import { Tooltip } from "./Tooltip";

let catalogPromise: Promise<MetricDef[]> | null = null;
const loadCatalog = () => (catalogPromise ??= api.hostMetricCatalog());

// Short-lived so switching hosts back and forth in one form doesn't refetch,
// but an agent that was just updated shows its new snapshot on the next form.
const HOST_CACHE_MS = 30_000;
const hostCache = new Map<string, { at: number; promise: Promise<HostDetail> }>();
const inventoryCache = new Map<string, { at: number; promise: Promise<HostInventory> }>();
function cached<T>(map: Map<string, { at: number; promise: Promise<T> }>, id: string, load: () => Promise<T>) {
  const hit = map.get(id);
  if (hit && Date.now() - hit.at < HOST_CACHE_MS) return hit.promise;
  const promise = load();
  map.set(id, { at: Date.now(), promise });
  return promise;
}
const loadHost = (id: string) => cached(hostCache, id, () => api.host(id));
const loadInventory = (id: string) => cached(inventoryCache, id, () => api.hostInventory(id));

const SNMP_TYPES = new Set(["snmp"]);
// Settings that usually name the target device, for "use each host's
// address" when one form creates checks on several hosts.
const ADDRESS_KEYS = ["host", "ip", "url", "hostname"];

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
                <button key={t.type} onClick={() => onPick(t.type)} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-2.5 text-left hover:border-[var(--border-strong)] hover:bg-[var(--panel-2)]">
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

// What the agent found on the host, as pickable rows for a field.
function inventoryItems(kind: Field["suggest"] | string | undefined, host: HostDetail | null, inv: HostInventory | null): PickItem[] {
  const snap = host?.lastSnapshot;
  const names = (xs: string[] | null | undefined, group?: string) => (xs ?? []).map((x) => ({ id: x, label: x, group }));
  switch (kind) {
    case "services":
      if (inv?.services?.length)
        return inv.services.map((s) => ({ id: s.name, label: s.displayName && s.displayName !== s.name ? `${s.name} — ${s.displayName}` : s.name, group: /running|active/i.test(s.state) ? "Running" : "Not running", sub: [s.state, s.startType].filter(Boolean).join(" · ") }));
      return names(host?.availableServices);
    case "processes": {
      if (inv?.processes?.length) {
        const byName = new Map<string, { n: number; mem: number; user?: string }>();
        for (const p of inv.processes) {
          const e = byName.get(p.name) ?? { n: 0, mem: 0, user: p.user };
          e.n++;
          e.mem += p.memoryMb ?? 0;
          byName.set(p.name, e);
        }
        return [...byName.entries()].sort((a, b) => b[1].mem - a[1].mem).map(([name, e]) => ({ id: name, label: name, sub: `${e.n} running · ${Math.round(e.mem)} MB${e.user ? ` · ${e.user}` : ""}` }));
      }
      return names(host?.availableProcesses);
    }
    case "containers":
      return names(inv?.containers ?? snap?.availableContainers);
    case "scripts":
      return names(inv?.scripts ?? host?.availableScripts);
    case "mounts":
    case "mount":
      return (snap?.disks ?? []).map((d) => ({ id: d.mount, label: d.mount, sub: `${d.fstype ?? ""} · ${d.percent.toFixed(0)}% used` }));
    case "interfaces":
    case "interface":
      return (snap?.net ?? []).map((n) => ({ id: n.name, label: n.name, sub: [n.up ? "up" : "down", n.mac, ...(n.addrs ?? []).slice(0, 2)].filter(Boolean).join(" · ") }));
    case "device":
    case "devices":
      return (snap?.smart ?? []).map((s) => ({ id: s.device, label: s.device, sub: s.model }));
    case "sensor":
      return (snap?.temps ?? []).map((t) => ({ id: t.sensor, label: t.sensor, sub: `${t.celsius}°C` }));
    case "array":
      return (snap?.raid ?? []).map((r) => ({ id: r.name, label: r.name, sub: r.kind }));
    case "port":
      return (snap?.listening ?? []).map((l) => ({ id: String(l.port), label: `${l.port}/${l.proto}`, sub: l.process }));
    default:
      return [];
  }
}

// A text field plus "Browse" into what the agent found. While creating, more
// than one item can be picked — one check is created per item.
function InventoryInput({ field, value, onChange, items, multi, picked, onPick, hostName }: { field: Field; value: string; onChange: (v: string) => void; items: PickItem[]; multi: boolean; picked: string[]; onPick: (ids: string[]) => void; hostName?: string }) {
  const [open, setOpen] = useState(false);
  const listId = `dl-${field.key}`;
  return (
    <Label label={field.label + (field.required ? " *" : "")} help={field.help}>
      <span className="flex gap-2">
        <input value={picked.length > 1 ? `${picked.length} selected` : value} readOnly={picked.length > 1} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} list={items.length ? listId : undefined} className={inputClass} />
        {items.length > 0 && (
          <Button onClick={() => setOpen(true)} className="!px-2 shrink-0 text-xs">
            Browse ({items.length})
          </Button>
        )}
      </span>
      {items.length > 0 && (
        <datalist id={listId}>
          {items.slice(0, 500).map((s) => (
            <option key={s.id} value={s.id} />
          ))}
        </datalist>
      )}
      {open && (
        <Modal title={`${field.label}${hostName ? ` on ${hostName}` : ""}`} onClose={() => setOpen(false)} wide>
          <p className="mb-2 text-xs text-[var(--muted)]">{multi ? "Pick one, or several to create one check for each." : "Pick one."} From the agent&apos;s latest report.</p>
          <MultiPicker items={items} selected={picked.length ? picked : value ? [value] : []} onChange={(ids) => (multi ? onPick(ids) : (onChange(ids[0] ?? ""), onPick([])))} single={!multi} height="max-h-96" groupLabel="State" />
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              onClick={() => {
                if (picked.length === 1) {
                  onChange(picked[0]);
                  onPick([]);
                }
                setOpen(false);
              }}
            >
              Done
            </Button>
          </div>
        </Modal>
      )}
    </Label>
  );
}

function FieldInput({ field, value, onChange, items, checks, editing, multi, picked, onPick, hostName }: { field: Field; value: unknown; onChange: (v: unknown) => void; items: PickItem[]; checks: Check[]; editing: boolean; multi: boolean; picked: string[]; onPick: (ids: string[]) => void; hostName?: string }) {
  const str = value == null ? "" : String(value);
  switch (field.kind) {
    case "checkbox":
      return (
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={value === true || value === "true"} onChange={(e) => onChange(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
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
                  className="accent-[var(--accent)]"
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
    default:
      if (field.suggest) return <InventoryInput field={field} value={str} onChange={(v) => onChange(v)} items={items} multi={multi} picked={picked} onPick={onPick} hostName={hostName} />;
      return (
        <Label label={field.label + (field.required ? " *" : "")} help={field.help}>
          <input type={field.kind === "number" ? "number" : "text"} value={str} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className={inputClass} />
        </Label>
      );
  }
}

function MetricFields({ config, set, host, inv }: { config: Record<string, unknown>; set: (k: string, v: unknown) => void; host: HostDetail | null; inv: HostInventory | null }) {
  const [catalog, setCatalog] = useState<MetricDef[]>([]);
  useEffect(() => {
    loadCatalog().then(setCatalog).catch(() => setCatalog([]));
  }, []);
  const metric = catalog.find((m) => m.key === config.metric);
  const groups = [...new Set(catalog.map((m) => m.group))];
  const suggestions = metric?.instance ? inventoryItems(metric.instance, host, inv) : [];
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
          <select value={String(config.instance ?? "")} onChange={(e) => set("instance", e.target.value)} className={inputClass}>
            <option value="">{metric.instanceRequired ? "Choose…" : `All ${metric.instance}s (worst wins)`}</option>
            {suggestions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label}
                {s.sub ? ` — ${s.sub}` : ""}
              </option>
            ))}
            {config.instance && !suggestions.some((s) => s.id === config.instance) ? <option value={String(config.instance)}>{String(config.instance)}</option> : null}
          </select>
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
      {host && !host.lastSnapshot && <p className="text-xs text-[var(--warn)] sm:col-span-2">This host hasn&apos;t sent a 3.x agent report yet{host.agentVersion ? ` (it reports agent v${host.agentVersion})` : ""} — update its agent on the Hosts page to see real names here.</p>}
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
    <details open={defaultOpen} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <summary className="cursor-pointer select-none text-sm font-medium">{title}</summary>
      <div className="mt-3">{children}</div>
    </details>
  );
}

// Browse every value a device exposes under an OID, and click one to use it.
function SnmpWalkDialog({ config, endpointId, checkId, onPick, onClose }: { config: Record<string, unknown>; endpointId: string; checkId?: string; onPick: (row: WalkRow) => void; onClose: () => void }) {
  const [root, setRoot] = useState(String(config.oid || "1.3.6.1.2.1"));
  const [rows, setRows] = useState<WalkRow[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [filter, setFilter] = useState("");

  async function walk() {
    setRows(null);
    setStatus("Walking…");
    try {
      let res = await api.snmpWalk({ config: { ...config, oid: root }, endpointId, checkId });
      if ("jobId" in res) {
        setStatus("Walking from this endpoint's site collector…");
        const jobId = res.jobId;
        for (let i = 0; i < 40; i++) {
          await new Promise((r) => setTimeout(r, 3000));
          const next = await api.snmpWalkJob(jobId);
          if (!("pending" in next)) {
            res = next;
            break;
          }
        }
        if ("jobId" in res) throw new Error("The site collector didn't answer within 2 minutes");
      }
      setRows(res.rows);
      setTruncated(res.truncated);
      setStatus(null);
    } catch (err) {
      setStatus(err instanceof Error ? err.message : "Walk failed");
    }
  }

  const q = filter.trim().toLowerCase();
  const shown = (rows ?? []).filter((r) => !q || `${r.oid} ${r.type} ${r.value}`.toLowerCase().includes(q));
  return (
    <Modal title={`SNMP walk — ${String(config.host ?? "")}`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex gap-2">
          <input value={root} onChange={(e) => setRoot(e.target.value)} className={`${inputClass} font-mono`} aria-label="Start OID" />
          <Button variant="primary" onClick={walk}>
            Walk
          </Button>
        </div>
        <p className="text-xs text-[var(--muted)]">1.3.6.1.2.1 is the standard MIB-2 tree; 1.3.6.1.4.1 holds vendor values; 1.3.6.1 walks everything (can be slow). Click a row to use its OID.</p>
        {status && <p className="text-xs text-[var(--muted)]">{status}</p>}
        {rows && (
          <>
            <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Filter ${rows.length} values…`} className={inputClass} />
            {truncated && <p className="text-xs text-[var(--warn)]">Showing the first {rows.length} values — start from a deeper OID to see the rest.</p>}
            <div className="max-h-96 overflow-auto rounded border border-[var(--border)]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
                  <tr>
                    <th className="px-2 py-1 font-normal">OID</th>
                    <th className="px-2 py-1 font-normal">Type</th>
                    <th className="px-2 py-1 font-normal">Value</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.slice(0, 2000).map((r) => (
                    <tr key={r.oid} onClick={() => onPick(r)} className="cursor-pointer border-t border-[var(--border)] hover:bg-[var(--accent)]/10">
                      <td className="px-2 py-1 font-mono">{r.oid}</td>
                      <td className="px-2 py-1 text-[var(--muted)]">{r.type}</td>
                      <td className="max-w-xs truncate px-2 py-1" title={r.value}>
                        {r.value}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </Modal>
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
  onSaved: (check: Check, created?: number) => void;
  onCancel: () => void;
  onChangeType?: () => void;
}) {
  const def = TYPE_BY_KEY.get(type)!;
  const editing = Boolean(check);
  const [name, setName] = useState(check?.name ?? "");
  const [endpointId, setEndpointId] = useState(check?.endpointId ?? defaultEndpointId ?? endpoints[0]?.id ?? "");
  const [hostId, setHostId] = useState(check?.hostId ?? defaultHostId ?? "");
  // Creating: several endpoints and/or hosts at once.
  const [endpointIds, setEndpointIds] = useState<string[]>(defaultEndpointId ? [defaultEndpointId] : endpoints[0] ? [endpoints[0].id] : []);
  const [hostIds, setHostIds] = useState<string[]>(defaultHostId ? [defaultHostId] : []);
  const [probeHostId, setProbeHostId] = useState(check?.probeHostId ?? "");
  const [config, setConfig] = useState<Record<string, unknown>>(check ? { ...check.config } : defaultConfigFor(type));
  const [interval, setIntervalSecs] = useState(String(check?.intervalSeconds ?? (type === "heartbeat" || type === "push_value" ? 3600 : 60)));
  const [retry, setRetry] = useState(check?.retryIntervalSeconds != null ? String(check.retryIntervalSeconds) : "");
  const [enabled, setEnabled] = useState(check?.enabled ?? true);
  const [tags, setTags] = useState((check?.tags ?? []).join(", "));
  const [dependsOn, setDependsOn] = useState<string[]>(check?.dependsOn ?? []);
  const [alert, setAlert] = useState<AlertOptionsValue>(emptyAlertOptions());
  const [multiValues, setMultiValues] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [host, setHost] = useState<HostDetail | null>(null);
  const [inv, setInv] = useState<HostInventory | null>(null);
  const [walking, setWalking] = useState(false);

  const endpointName = useMemo(() => new Map(endpoints.map((e) => [e.id, e.name])), [endpoints]);
  const targetHostIds = editing ? (hostId ? [hostId] : []) : hostIds;
  // The host whose inventory feeds the pickers: the (first) chosen host.
  const selectedHostId = targetHostIds[0] || probeHostId;
  useEffect(() => {
    if (!selectedHostId) {
      setHost(null);
      setInv(null);
      return;
    }
    loadHost(selectedHostId).then(setHost).catch(() => setHost(null));
    loadInventory(selectedHostId).then(setInv).catch(() => setInv(null));
  }, [selectedHostId]);

  const set = (key: string, value: unknown) => setConfig((c) => ({ ...c, [key]: value }));
  const visibleFields = def.fields.filter((f) => !f.showIf || f.showIf(config));
  // The metric picker renders its own fields (MetricFields), not via FieldInput.
  const basic = visibleFields.filter((f) => !f.advanced && f.kind !== "metric");
  const advanced = visibleFields.filter((f) => f.advanced);
  const otherChecks = useMemo(() => checks.filter((c) => c.id !== check?.id), [checks, check?.id]);
  const multiTarget = !editing && (def.needsHost ? hostIds.length > 1 : hostIds.length > 1 || (hostIds.length === 0 && endpointIds.length > 1));
  const multiField = Object.entries(multiValues).find(([, v]) => v.length > 1);

  const hostItems: PickItem[] = hosts.map((h) => ({ id: h.id, label: h.name, sub: [h.hostname, h.agentVersion ? `agent ${h.agentVersion}` : "no agent"].filter(Boolean).join(" · "), group: endpointName.get(h.endpointId) }));
  const endpointItems: PickItem[] = endpoints.map((e) => ({ id: e.id, label: e.name, sub: e.description ?? undefined }));

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const normalized = normalizeConfig(type, config);
    const pickedCheck = multiField ? { ...normalized, [multiField[0]]: multiField[1][0] } : normalized;
    const needTarget = editing
      ? (def.needsHost && !hostId ? "Choose the host this check runs on." : null) ?? (!endpointId ? "Choose an endpoint." : null)
      : def.needsHost
        ? hostIds.length
          ? null
          : "Choose at least one host."
        : hostIds.length || endpointIds.length
          ? null
          : "Choose at least one endpoint or host.";
    const invalid = validateConfig(type, pickedCheck) ?? (!name.trim() ? "Name is required." : null) ?? needTarget;
    if (invalid) {
      setError(invalid);
      return;
    }
    const common = {
      probeHostId: def.remoteProbe && probeHostId ? probeHostId : null,
      intervalSeconds: Number(interval) || 60,
      retryIntervalSeconds: retry ? Number(retry) : null,
      enabled,
      tags: tags.split(",").map((t) => t.trim()).filter(Boolean),
      dependsOn,
    };
    setSaving(true);
    try {
      if (check) {
        const saved = await api.updateCheck(check.id, { ...common, name: name.trim(), endpointId, hostId: hostId || null, config: normalized });
        onSaved(saved);
        return;
      }
      const targets = hostIds.length ? hostIds.map((id) => ({ hostId: id })) : endpointIds.map((id) => ({ endpointId: id }));
      const values = multiField ? multiField[1] : [null];
      const created: Check[] = [];
      const errors: string[] = [];
      for (const v of values) {
        const cfg = multiField && v != null ? { ...normalized, [multiField[0]]: v } : normalized;
        const nm = multiField && v != null ? `${name.trim()} — ${v}` : name.trim();
        const res = await api.createChecksBatch({ ...common, type, name: nm, config: cfg, targets, alertRule: alertRulePayload(alert) });
        created.push(...res.created);
        errors.push(...res.errors.map((x) => `${x.target}: ${x.error}`));
      }
      if (!created.length) throw new Error(errors[0] ?? "Nothing was created");
      if (errors.length) setError(`Created ${created.length}; skipped ${errors.length}: ${errors[0]}`);
      onSaved(created[0], created.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const agentHosts = hosts.filter((h) => h.hasAgentKey || h.agentVersion);
  const addressFields = def.fields.filter((f) => ADDRESS_KEYS.includes(f.key));

  return (
    <form onSubmit={handleSubmit} className="space-y-3 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-xs text-[var(--muted)]">
          <span className="font-medium text-[var(--text)]">{def.label}</span> — {def.description}{" "}
          <a href={`/help/checks#${type}`} target="_blank" rel="noreferrer" className="underline hover:text-[var(--text)]">
            How this check works
          </a>
        </p>
        {!editing && onChangeType && (
          <button type="button" onClick={onChangeType} className="text-xs text-[var(--muted)] underline">
            change type
          </button>
        )}
      </div>

      <Section title={editing ? "Basics" : "Basics & where"}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label label="Name *" className="sm:col-span-2" help={!editing ? "With several hosts or endpoints, {{host}}, {{address}} and {{endpoint}} are filled in for each one." : undefined}>
            <input autoFocus={!editing} value={name} onChange={(e) => setName(e.target.value)} placeholder={multiTarget ? `e.g. ${def.label} — {{host}}` : `e.g. ${def.label} — office router`} className={inputClass} />
          </Label>
          {editing ? (
            <>
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
            </>
          ) : (
            <>
              <div className="sm:col-span-2">
                <div className="mb-1 inline-flex items-center text-xs text-[var(--muted)]">
                  {def.needsHost ? "Hosts * — one check per host" : "Hosts (optional) — one check per host"}
                  <Tooltip text={def.needsHost ? "The agent on each chosen host runs its own copy of this check." : "Pick hosts to create one check per host (in that host's endpoint). Leave empty to create per endpoint instead."} />
                </div>
                <MultiPicker items={hostItems} selected={hostIds} onChange={setHostIds} placeholder="Search hosts…" height="max-h-40" groupLabel="Endpoint" />
              </div>
              {!def.needsHost && hostIds.length === 0 && (
                <div className="sm:col-span-2">
                  <div className="mb-1 text-xs text-[var(--muted)]">Endpoints * — one check per endpoint</div>
                  <MultiPicker items={endpointItems} selected={endpointIds} onChange={setEndpointIds} placeholder="Search endpoints…" height="max-h-32" />
                </div>
              )}
              {multiTarget && hostIds.length > 1 && addressFields.length > 0 && (
                <p className="text-xs text-[var(--muted)] sm:col-span-2">
                  Creating {hostIds.length} checks.{" "}
                  <button type="button" className="underline" onClick={() => addressFields.forEach((f) => set(f.key, f.key === "url" ? "https://{{address}}/" : "{{address}}"))}>
                    Target each host&apos;s own address
                  </button>{" "}
                  ({addressFields.map((f) => f.label).join(", ")} → {"{{address}}"}).
                </p>
              )}
            </>
          )}
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
              <MetricFields config={config} set={set} host={host} inv={inv} />
            </div>
          )}
          {basic.map((f) => (
            <div key={f.key} className={f.wide || f.kind === "textarea" || f.kind === "checkbox" ? "sm:col-span-2" : ""}>
              <FieldInput
                field={f}
                value={config[f.key]}
                onChange={(v) => set(f.key, v)}
                items={f.suggest ? inventoryItems(f.suggest, host, inv) : []}
                checks={otherChecks}
                editing={editing}
                multi={!editing}
                picked={multiValues[f.key] ?? []}
                onPick={(ids) => setMultiValues((m) => ({ ...m, [f.key]: ids }))}
                hostName={host?.name}
              />
            </div>
          ))}
          {SNMP_TYPES.has(type) && (
            <div className="sm:col-span-2">
              <Button disabled={!config.host} onClick={() => setWalking(true)} className="text-xs">
                Walk this device…
              </Button>
              <span className="ml-2 text-xs text-[var(--muted)]">See every value it exposes and pick an OID.</span>
            </div>
          )}
          {basic.length === 0 && type !== "host_metric" && <p className="text-xs text-[var(--muted)]">Nothing else to configure.</p>}
          {multiField && (
            <p className="rounded-md bg-[var(--accent)]/10 p-2 text-xs sm:col-span-2">
              {multiField[1].length} {def.fields.find((f) => f.key === multiField[0])?.label.toLowerCase()}s picked — one check each{targetHostIds.length > 1 || endpointIds.length > 1 ? ", on every target" : ""}: {multiField[1].slice(0, 6).join(", ")}
              {multiField[1].length > 6 ? "…" : ""}
            </p>
          )}
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
              <FieldInput field={f} value={config[f.key]} onChange={(v) => set(f.key, v)} items={[]} checks={otherChecks} editing={editing} multi={false} picked={[]} onPick={() => undefined} />
            </div>
          ))}
          <Label label="Retry every (seconds) while failing" help="Re-check sooner while the check isn't up, so recoveries and N-in-a-row alerts land faster. Blank = normal interval.">
            <input type="number" min={5} value={retry} onChange={(e) => setRetry(e.target.value)} className={inputClass} />
          </Label>
          <Label label="Tags" help="Comma-separated. Filter and bulk-select by tag on the Checks page.">
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder="core, lan, backups" className={inputClass} />
          </Label>
          <div className="sm:col-span-2">
            <div className="mb-1 inline-flex items-center text-xs text-[var(--muted)]">
              Depends on
              <Tooltip text="While any of these is down, this check's alerts are held back (e.g. a router everything else sits behind)." />
            </div>
            <MultiPicker items={otherChecks.map((c) => ({ id: c.id, label: c.name, group: endpointName.get(c.endpointId) }))} selected={dependsOn} onChange={setDependsOn} placeholder="Search checks…" height="max-h-32" groupLabel="Endpoint" />
          </div>
          <label className="flex items-center gap-2 text-sm sm:col-span-2">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="h-4 w-4 accent-[var(--accent)]" />
            Enabled
          </label>
        </div>
      </Section>

      {!editing && (
        <Section title="Alerts" defaultOpen={channels.length > 0}>
          <p className="mb-2 text-xs text-[var(--muted)]">Pick channels to add an alert rule to {multiTarget || multiField ? "every check created" : "this check"}. Leave none ticked for no alerts — the check still shows on the dashboard.</p>
          <AlertOptions channels={channels} value={alert} onChange={setAlert} />
        </Section>
      )}

      {error && <p className="text-sm text-[var(--down)]">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? "Saving…" : editing ? "Save changes" : multiTarget || multiField ? "Create checks" : "Create check"}
        </Button>
      </div>

      {walking && (
        <SnmpWalkDialog
          config={config}
          endpointId={editing ? endpointId : (hostIds.length ? hosts.find((h) => h.id === hostIds[0])?.endpointId : endpointIds[0]) ?? ""}
          checkId={check?.id}
          onClose={() => setWalking(false)}
          onPick={(row) => {
            setConfig((c) => ({ ...c, preset: "", oid: row.oid, ...(/Counter/.test(row.type) ? { asRate: true } : {}) }));
            setWalking(false);
          }}
        />
      )}
    </form>
  );
}
