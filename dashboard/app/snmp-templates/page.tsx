// The SNMP templates page (/snmp-templates): sets of SNMP checks for a kind
// of device — printers (any brand, or per brand), UPS, NAS, Linux hosts,
// switches — that you apply to a device in one step, plus your own.
//
// Where this sits: templates come from the engine (engine/src/routes/
// snmpTemplates.ts); built-in ones are read-only but can be copied. Applying
// a template creates ordinary SNMP checks on the device (one per item), with
// the address and SNMP credentials entered in the Apply dialog.
//
// "use client" makes this a React component that runs in the browser. The
// engine refuses every call without a session; usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, type Endpoint, type Site, type SnmpTemplate, type SnmpTemplateItem } from "../lib/api";
import { PageHelp } from "../components/PageHelp";
import { Button, ConfirmDialog, Label, Modal, inputClass, useToast } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";
import { own } from "../lib/own";

// The built-in SNMP readings an item can use instead of an OID (engine:
// SNMP_PRESETS in services/probes/snmp.ts).
const PRESETS: [string, string][] = [
  ["", "Custom OID"],
  ["printer_supplies", "Printer: lowest toner/ink %"],
  ["printer_status", "Printer: errors"],
  ["printer_jobs", "Printer: failed jobs"],
  ["ups_battery", "UPS: battery %"],
  ["ups_runtime", "UPS: minutes left"],
  ["ups_on_battery", "UPS: on battery?"],
  ["hr_cpu", "CPU %"],
  ["hr_memory", "Memory %"],
  ["hr_storage", "Fullest disk %"],
  ["sensor_temp_max", "Hottest sensor °C"],
  ["uptime_reboot", "Reboot detection"],
];
const MODES: [string, string][] = [
  ["get", "Single value"],
  ["walk_avg", "Walk: average"],
  ["walk_sum", "Walk: sum"],
  ["walk_min", "Walk: minimum"],
  ["walk_max", "Walk: maximum"],
  ["walk_count", "Walk: count"],
];

/** One line describing what an item reads, for the template list. */
function describeItem(i: SnmpTemplateItem) {
  if (i.type === "snmp_interfaces") return "every port (interface table)";
  const what = i.preset ? (PRESETS.find((p) => p[0] === i.preset)?.[1] ?? i.preset) : i.extraOids ? `calculated: ${i.expression}` : `${i.oid}${i.mode && i.mode !== "get" ? ` (${i.mode.replace("walk_", "walk ")})` : ""}${i.expression ? ` → ${i.expression}` : ""}`;
  const limits = [i.warnAbove != null && `warn > ${i.warnAbove}`, i.criticalAbove != null && `critical > ${i.criticalAbove}`, i.warnBelow != null && `warn < ${i.warnBelow}`, i.criticalBelow != null && `critical < ${i.criticalBelow}`].filter(Boolean).join(", ");
  return `${what}${limits ? ` · ${limits}` : ""}`;
}

/** The page: built-in and own templates, with copy/edit/delete/apply. */
export default function SnmpTemplatesPage() {
  const authed = usePageAuth();
  const [templates, setTemplates] = useState<SnmpTemplate[] | null>(null);
  const [editing, setEditing] = useState<SnmpTemplate | "new" | null>(null);
  const [applying, setApplying] = useState<SnmpTemplate | null>(null);
  // Device address handed over by the Discovery page's "SNMP template" link.
  const [applyHost, setApplyHost] = useState("");
  const [deleting, setDeleting] = useState<SnmpTemplate | null>(null);
  const toast = useToast();

  const load = useCallback(() => api.snmpTemplates().then(setTemplates), []);
  useEffect(() => {
    if (!authed) return;
    // First load also honours ?apply=<template id>&address=<ip> from the
    // Discovery page: it opens that template's Apply dialog with the address
    // filled in. Nothing is created until the user clicks Create.
    api.snmpTemplates().then((list) => {
      setTemplates(list);
      const q = new URLSearchParams(window.location.search);
      const wanted = list.find((t) => t.id === q.get("apply"));
      if (wanted) {
        setApplyHost(q.get("address") ?? "");
        setApplying(wanted);
      }
    });
  }, [authed]);

  if (!authed) return null;
  const builtIn = (templates ?? []).filter((t) => t.builtIn);
  const own = (templates ?? []).filter((t) => !t.builtIn);

  const card = (t: SnmpTemplate) => (
    <li key={t.id} className="surface space-y-1.5 rounded-xl p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{t.name}</span>
        {t.matchSysObjectId && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 font-mono text-xs text-[var(--muted)]">{t.matchSysObjectId}</span>}
        <span className="ml-auto flex gap-3 text-xs">
          <button className="underline" onClick={() => setApplying(t)}>
            Apply to a device…
          </button>
          <button className="text-[var(--muted)] underline" onClick={() => setEditing({ ...t, id: "", name: t.builtIn ? `${t.name} (copy)` : `${t.name} (copy)`, builtIn: false })}>
            Copy
          </button>
          {!t.builtIn && (
            <>
              <button className="text-[var(--muted)] underline" onClick={() => setEditing(t)}>
                Edit
              </button>
              <button className="text-[var(--down)] underline" onClick={() => setDeleting(t)}>
                Delete
              </button>
            </>
          )}
        </span>
      </div>
      {t.description && <p className="text-xs text-[var(--muted)]">{t.description}</p>}
      <details className="text-xs">
        <summary className="cursor-pointer text-[var(--muted)]">{t.items.length} check(s)</summary>
        <ul className="mt-1 space-y-0.5 pl-4">
          {t.items.map((i, n) => (
            <li key={n}>
              <strong>{i.name}</strong> — <span className="text-[var(--muted)]">{describeItem(i)}</span>
              {i.note && <span className="text-[var(--muted)]"> ({i.note})</span>}
            </li>
          ))}
        </ul>
      </details>
    </li>
  );

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-lg font-medium">SNMP templates</h1>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + New template
        </Button>
      </div>
      <PageHelp anchor="snmp-templates">
        A template is a set of SNMP checks for one kind of device. Apply it to a device and Looksee creates every check at once, with your thresholds. Start from a built-in one (copy it to change it), or build your own from OIDs — the walk browser in any SNMP check shows what a device offers, with names and readable values.
      </PageHelp>
      <h2 className="mb-2 mt-4 text-sm font-medium">Your templates</h2>
      {own.length ? <ul className="space-y-2">{own.map(card)}</ul> : <p className="text-sm text-[var(--muted)]">None yet — copy a built-in one below, or start a new one.</p>}
      <h2 className="mb-2 mt-6 text-sm font-medium">Built-in</h2>
      <ul className="space-y-2">{builtIn.map(card)}</ul>
      {editing && (
        <TemplateEditor
          template={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            toast.show("Template saved.");
          }}
        />
      )}
      {applying && (
        <ApplyDialog
          template={applying}
          host={applyHost}
          onClose={() => setApplying(null)}
          onDone={(n) => {
            setApplying(null);
            toast.show(`Created ${n} check(s).`);
          }}
        />
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete template"
          message={`Delete "${deleting.name}"? Checks already created from it stay.`}
          actionLabel="Delete"
          onClose={() => setDeleting(null)}
          onConfirm={async () => {
            await api.deleteSnmpTemplate(deleting.id);
            setDeleting(null);
            load();
          }}
        />
      )}
      {toast.node}
    </main>
  );
}

/** A number field's value as a number, or undefined when blank. */
const num = (v: string) => (v.trim() === "" ? undefined : Number(v));
const text = (v: number | undefined) => (v == null ? "" : String(v));

/**
 * Creates or edits a template: name, description, the sysObjectID prefix it
 * suits, and its items (each one check).
 *
 * @param template the template to edit (id "" = a copy, saved as new), or null
 */
function TemplateEditor({ template, onClose, onSaved }: { template: SnmpTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(template?.name ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [match, setMatch] = useState(template?.matchSysObjectId ?? "");
  const [items, setItems] = useState<SnmpTemplateItem[]>(template?.items.map((i) => ({ ...i })) ?? [{ name: "" }]);
  const [error, setError] = useState<string | null>(null);
  const setItem = (n: number, patch: Partial<SnmpTemplateItem>) => setItems((list) => list.map((i, k) => (k === n ? { ...i, ...patch } : i)));

  async function save() {
    setError(null);
    const input = { name, description: description || null, matchSysObjectId: match || null, items };
    try {
      if (template?.id) await api.updateSnmpTemplate(template.id, input);
      else await api.createSnmpTemplate(input);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    }
  }

  return (
    <Modal title={template?.id ? "Edit SNMP template" : "New SNMP template"} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Label label="Name *">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Office MFPs" className={inputClass} />
          </Label>
          <Label label="Suggest for devices whose sysObjectID starts with" help="Optional. An OID prefix like 1.3.6.1.4.1.2435 (Brother); discovery suggests the template for matching devices.">
            <input value={match} onChange={(e) => setMatch(e.target.value)} placeholder="1.3.6.1.4.1.…" className={`${inputClass} font-mono`} />
          </Label>
        </div>
        <Label label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} className={inputClass} />
        </Label>
        <div className="space-y-2">
          {items.map((i, n) => (
            <fieldset key={n} className="space-y-2 rounded-lg border border-[var(--border)] p-2">
              <div className="grid gap-2 sm:grid-cols-3">
                <Label label={`Check ${n + 1} name *`}>
                  <input value={i.name} onChange={(e) => setItem(n, { name: e.target.value })} className={inputClass} />
                </Label>
                <Label label="Reads">
                  <select
                    value={i.type === "snmp_interfaces" ? "__interfaces" : (i.preset ?? "")}
                    onChange={(e) => (e.target.value === "__interfaces" ? setItem(n, { type: "snmp_interfaces", preset: undefined }) : setItem(n, { type: undefined, preset: e.target.value || undefined }))}
                    className={inputClass}
                  >
                    {PRESETS.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                    <option value="__interfaces">Every port (interface table)</option>
                  </select>
                </Label>
                <Label label="Every (seconds)">
                  <input type="number" min={30} value={text(i.intervalSeconds)} onChange={(e) => setItem(n, { intervalSeconds: num(e.target.value) })} placeholder="300" className={inputClass} />
                </Label>
              </div>
              {!i.preset && i.type !== "snmp_interfaces" && (
                <div className="grid gap-2 sm:grid-cols-3">
                  <Label label="OID">
                    <input value={i.oid ?? ""} onChange={(e) => setItem(n, { oid: e.target.value || undefined })} placeholder="1.3.6.1.2.1.1.3.0" className={`${inputClass} font-mono`} />
                  </Label>
                  <Label label="Read as">
                    <select value={i.mode ?? "get"} onChange={(e) => setItem(n, { mode: e.target.value })} className={inputClass}>
                      {MODES.map(([v, l]) => (
                        <option key={v} value={v}>
                          {l}
                        </option>
                      ))}
                    </select>
                  </Label>
                  <Label label="Unit">
                    <input value={i.unit ?? ""} onChange={(e) => setItem(n, { unit: e.target.value || undefined })} placeholder="%" className={inputClass} />
                  </Label>
                  <Label label="Extra OIDs (name = OID)" className="sm:col-span-2">
                    <textarea value={i.extraOids ?? ""} onChange={(e) => setItem(n, { extraOids: e.target.value || undefined })} rows={2} placeholder="used = 1.3.6.1.2.1.25.2.3.1.6.1" className={`${inputClass} font-mono text-xs`} />
                  </Label>
                  <Label label="Calculate">
                    <input value={i.expression ?? ""} onChange={(e) => setItem(n, { expression: e.target.value || undefined })} placeholder="value / 10" className={`${inputClass} font-mono`} />
                  </Label>
                </div>
              )}
              {i.type !== "snmp_interfaces" && (
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                  {(["warnAbove", "criticalAbove", "warnBelow", "criticalBelow"] as const).map((k) => (
                    <Label key={k} label={k.replace(/([A-Z])/g, " $1").toLowerCase()}>
                      <input type="number" value={text(own(i as Record<string, unknown>, k) as number | undefined)} onChange={(e) => setItem(n, { [k]: num(e.target.value) })} className={inputClass} />
                    </Label>
                  ))}
                </div>
              )}
              <button type="button" className="text-xs text-[var(--down)] underline" onClick={() => setItems((list) => list.filter((_, k) => k !== n))} disabled={items.length === 1}>
                Remove this check
              </button>
            </fieldset>
          ))}
          <Button onClick={() => setItems((list) => [...list, { name: "" }])}>+ Add a check</Button>
        </div>
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={save} disabled={!name.trim() || items.some((i) => !i.name.trim())}>
            Save template
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/**
 * Applies a template to a device: pick the site (and optionally the
 * endpoint it is), the address and SNMP credentials, and which checks.
 *
 * @param endpoint pre-selects that endpoint (and its site and hostname)
 * @param host pre-fills the address (from a Discovery link)
 * @param onDone called with how many checks were created
 */
function ApplyDialog({ template, endpoint, host, onClose, onDone }: { template: SnmpTemplate; endpoint?: Endpoint; host?: string; onClose: () => void; onDone: (count: number) => void }) {
  const [sites, setSites] = useState<Site[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [siteId, setSiteId] = useState(endpoint?.siteId ?? "");
  const [endpointId, setEndpointId] = useState(endpoint?.id ?? "");
  const [device, setDevice] = useState<Record<string, string>>({ host: endpoint?.hostname ?? host ?? "", version: "2c", community: "public" });
  const [picked, setPicked] = useState<number[]>(template.items.map((_, i) => i));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    Promise.all([api.sites(), api.endpoints()]).then(([s, e]) => {
      setSites(s);
      setEndpoints(e);
    });
  }, []);
  const set = (k: string, v: string) => setDevice((d) => ({ ...d, [k]: v }));
  const v3 = device.version === "3";

  async function apply() {
    setError(null);
    try {
      const r = await api.applySnmpTemplate(template.id, { siteId, endpointId: endpointId || null, device, items: picked });
      onDone(r.created.length);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't apply");
    }
  }

  return (
    <Modal title={`Apply “${template.name}”`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-2">
          <Label label="Site *">
            <select value={siteId} onChange={(e) => (setSiteId(e.target.value), setEndpointId(""))} className={inputClass}>
              <option value="">Choose…</option>
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </Label>
          <Label label="Endpoint (optional)" help="The device, if it's listed — the checks show on its page and its hostname is used.">
            <select
              value={endpointId}
              onChange={(e) => {
                setEndpointId(e.target.value);
                const ep = endpoints.find((x) => x.id === e.target.value);
                if (ep?.hostname) set("host", ep.hostname);
              }}
              className={inputClass}
            >
              <option value="">None</option>
              {endpoints
                .filter((e) => e.siteId === siteId)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
            </select>
          </Label>
          <Label label="Address *">
            <input value={device.host} onChange={(e) => set("host", e.target.value)} placeholder="10.0.0.20 or printer.lan" className={inputClass} />
          </Label>
          <Label label="SNMP version">
            <select value={device.version} onChange={(e) => set("version", e.target.value)} className={inputClass}>
              <option value="1">1</option>
              <option value="2c">2c</option>
              <option value="3">3</option>
            </select>
          </Label>
          {!v3 ? (
            <Label label="Community">
              <input value={device.community ?? ""} onChange={(e) => set("community", e.target.value)} className={inputClass} />
            </Label>
          ) : (
            <>
              <Label label="v3 username">
                <input value={device.username ?? ""} onChange={(e) => set("username", e.target.value)} className={inputClass} />
              </Label>
              <Label label="Auth protocol / key">
                <div className="flex gap-1">
                  <select value={device.authProtocol ?? "sha"} onChange={(e) => set("authProtocol", e.target.value)} className={`${inputClass} w-24`}>
                    {["md5", "sha", "sha224", "sha256", "sha384", "sha512"].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                  <input type="password" autoComplete="new-password" value={device.authKey ?? ""} onChange={(e) => set("authKey", e.target.value)} className={inputClass} />
                </div>
              </Label>
              <Label label="Privacy protocol / key">
                <div className="flex gap-1">
                  <select value={device.privProtocol ?? "aes"} onChange={(e) => set("privProtocol", e.target.value)} className={`${inputClass} w-24`}>
                    {["des", "aes", "aes256b", "aes256r"].map((p) => (
                      <option key={p}>{p}</option>
                    ))}
                  </select>
                  <input type="password" autoComplete="new-password" value={device.privKey ?? ""} onChange={(e) => set("privKey", e.target.value)} className={inputClass} />
                </div>
              </Label>
            </>
          )}
        </div>
        <div>
          <span className="text-xs text-[var(--muted)]">Create these checks:</span>
          <ul className="mt-1 space-y-0.5">
            {template.items.map((i, n) => (
              <li key={n}>
                <label className="flex items-center gap-2">
                  <input type="checkbox" className="accent-[var(--up)]" checked={picked.includes(n)} onChange={() => setPicked((p) => (p.includes(n) ? p.filter((x) => x !== n) : [...p, n]))} />
                  {i.name} <span className="text-xs text-[var(--muted)]">{describeItem(i)}</span>
                </label>
              </li>
            ))}
          </ul>
        </div>
        <p className="text-xs text-[var(--muted)]">
          Add alert rules afterwards from the Checks page (select them → Add alert rule), or <Link href="/manage" className="underline">open Checks</Link>.
        </p>
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={apply} disabled={!siteId || !device.host || !picked.length}>
            Create {picked.length} check(s)
          </Button>
        </div>
      </div>
    </Modal>
  );
}
