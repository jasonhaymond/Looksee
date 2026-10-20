"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type AddressRow, type Channel, type Check, type Site, type Endpoint, type EndpointDetail, type EndpointInventory, type Location, type Suggestion } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { PageHelp } from "../components/PageHelp";
import { AlertOptions, BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, FilterChip, Label, Modal, PromptDialog, StatusBadge, Tags, alertRulePayload, emptyAlertOptions, formatBytes, inputClass, relativeTime, useSelection, useToast, type BulkAction } from "../components/ui";
import { displayStatus } from "../components/CheckDetail";
import { collectorState } from "../components/collector";
import { EndpointPanel, endpointState } from "../components/EndpointPanel";
import { AddToGroupDialog } from "../components/NodeViews";
import { pollEvery } from "../lib/poll";

export default function EndpointsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [siteFilter, setSiteFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "delete" | "move" | "tags" | "untag" | "maint" | "suggest" | "group" | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [e, h, c, health, ch, l] = await Promise.all([api.sites(), api.endpoints(), api.checks(), api.health(), api.channels(), api.locations()]);
    setSites(e);
    setEndpoints(h);
    setChecks(c);
    setChannels(ch);
    setLocations(l);
    setLatestAgentVersion(health.agentVersion);
    setLoaded(true);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(() => setAuthChecked(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    load();
    const t = pollEvery(load, 30_000);
    return () => clearInterval(t);
  }, [authChecked, load]);

  const siteName = useMemo(() => new Map(sites.map((e) => [e.id, e.name])), [sites]);
  const collectorSites = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of sites) if (e.collectorEndpointId) m.set(e.collectorEndpointId, [...(m.get(e.collectorEndpointId) ?? []), e.name]);
    return m;
  }, [sites]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const locOf = new Map(sites.map((e) => [e.id, e.locationId]));
    return endpoints.filter((h) => (!siteFilter || h.siteId === siteFilter) && (!locationFilter || locOf.get(h.siteId) === locationFilter) && (!q || `${h.name} ${h.hostname ?? ""} ${h.os ?? ""} ${h.macAddress ?? ""} ${(h.tags ?? []).join(" ")} ${h.agentVersion ?? ""}`.toLowerCase().includes(q)));
  }, [endpoints, search, siteFilter, locationFilter, sites]);
  const sel = useSelection(filtered.map((h) => h.id));

  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Updated") {
    const res = await api.bulkEndpoints(sel.ids, action, params);
    toast.show(res.errors.length ? `${verb} ${res.affected}; ${res.errors.length} skipped: ${res.errors[0].error}` : `${verb} ${res.affected}.`, res.errors.length ? "error" : "info");
    if (action === "delete") sel.clear();
    await load();
  }

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Endpoints</h2>
        <Button variant="primary" onClick={() => setDialog("add")} disabled={!sites.length}>
          + Add host
        </Button>
      </div>
      <PageHelp anchor="endpoints">A host is a machine running the Looksee agent. Open one to see its live state, install or update its agent, and add suggested checks in one click.</PageHelp>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, IP, MAC, OS, tag…" className={`${inputClass} sm:col-span-2`} aria-label="Search endpoints" />
        <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className={inputClass} aria-label="Location filter">
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select value={siteFilter} onChange={(e) => setSiteFilter(e.target.value)} className={inputClass} aria-label="Site filter">
          <option value="">All sites</option>
          {sites.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      {loaded && endpoints.length === 0 ? (
        <EmptyState>No endpoints yet. Add one, then run its install command on that machine.</EmptyState>
      ) : (
        <div className="surface overflow-hidden rounded-xl">
          <div className="hidden grid-cols-[28px_100px_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_110px] gap-3 border-b border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-xs text-[var(--muted)] md:grid">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(filtered.map((h) => h.id), on)} label="Select all endpoints" />
            <span>Agent</span>
            <span>Name</span>
            <span>Address / OS</span>
            <span>Site</span>
            <span>Checks</span>
            <span>Last report</span>
          </div>
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)] md:hidden">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(filtered.map((h) => h.id), on)} label="Select all endpoints" />
            Select all {filtered.length}
          </div>
          {filtered.map((h) => {
            const state = endpointState(h);
            const mine = checks.filter((c) => c.endpointId === h.id);
            const bad = mine.filter((c) => ["down", "warn"].includes(displayStatus(c))).length;
            const outdated = Boolean(h.agentVersion && latestAgentVersion && h.agentVersion !== latestAgentVersion);
            const open = expanded === h.id;
            return (
              <Fragment key={h.id}>
                <div
                  onClick={() => setExpanded(open ? null : h.id)}
                  className={`grid cursor-pointer grid-cols-[28px_1fr] gap-x-3 gap-y-1 border-t border-[var(--border)] px-3 py-2 text-sm first:border-t-0 hover:bg-[var(--panel-2)] md:grid-cols-[28px_100px_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_110px] md:items-center ${sel.selected.has(h.id) ? "bg-[var(--accent)]/10" : ""}`}
                >
                  <span className="row-span-6 md:row-span-1">
                    <Checkbox checked={sel.selected.has(h.id)} onChange={() => sel.toggle(h.id)} label={`Select ${h.name}`} />
                  </span>
                  <span className="text-xs">
                    <StatusBadge status={state === "online" ? "up" : state === "offline" ? "down" : "unknown"} compact /> {state}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{h.name}</span>
                    {collectorSites.has(h.id) && <CollectorLine host={h} sites={collectorSites.get(h.id)!} />}
                    <Tags tags={h.tags} />
                  </span>
                  <span className="min-w-0 truncate text-xs text-[var(--muted)]">
                    {[h.hostname, h.os].filter(Boolean).join(" · ") || "—"}
                    {h.macAddress && <span className="block font-mono">{h.macAddress}</span>}
                    {h.agentVersion && (
                      <span className="block">
                        agent v{h.agentVersion}
                        {outdated && <span className="text-[var(--warn)]"> (update available)</span>}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-[var(--muted)]">{siteName.get(h.siteId)}</span>
                  <span className="text-xs">
                    {mine.length} {bad > 0 && <span className="text-[var(--down)]">· {bad} problem{bad === 1 ? "" : "s"}</span>}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{relativeTime(h.lastSeenAt)}</span>
                </div>
                {open && <EndpointPanel host={h} sites={sites} checks={checks} channels={channels} latestAgentVersion={latestAgentVersion} onChanged={load} />}
              </Fragment>
            );
          })}
        </div>
      )}

      <BulkBar
        count={sel.ids.length}
        noun="host"
        onClear={sel.clear}
        actions={
          [
            { group: "Checks", key: "suggest", label: "Add suggested checks…", hint: "Everything recommended for each host", run: () => setDialog("suggest") },
            { group: "Checks", key: "on", label: "Enable their checks", run: () => bulk("enable_checks", {}, "Enabled checks:") },
            { group: "Checks", key: "off", label: "Disable their checks", run: () => bulk("disable_checks", {}, "Disabled checks:") },
            { group: "Checks", key: "maint", label: "Maintenance…", run: () => setDialog("maint") },
            { group: "Agent", key: "update", label: "Update agents", run: () => bulk("request_update", {}, "Requested an update on") },
            { group: "Agent", key: "wake", label: "Wake (WoL)", run: () => bulk("wake", {}, "Sent wake packet to") },
            { group: "Organize", key: "move", label: "Move to site…", run: () => setDialog("move") },
            { group: "Organize", key: "group", label: "Add to group…", run: () => setDialog("group") },
            { group: "Organize", key: "tags", label: "Add tags…", run: () => setDialog("tags") },
            { group: "Organize", key: "untag", label: "Remove tags…", run: () => setDialog("untag") },
            { key: "delete", label: "Delete…", danger: true, run: () => setDialog("delete") },
          ] as BulkAction[]
        }
      />

      {dialog === "group" && (
        <AddToGroupDialog
          members={sel.ids.map((id) => ({ type: "endpoint" as const, id }))}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.show(`Added ${sel.ids.length} endpoint(s) to the group.`);
            setDialog(null);
          }}
        />
      )}
      {dialog === "suggest" && <BulkSuggestDialog channels={channels} count={sel.ids.length} onClose={() => setDialog(null)} onSubmit={(alertRule) => bulk("apply_suggestions", { alertRule }, "Created checks:")} />}
      {dialog === "add" && <AddEndpointDialog sites={sites} defaultSiteId={siteFilter} onClose={() => setDialog(null)} onCreated={(h) => (load(), setExpanded(h.id))} />}
      {dialog === "delete" && (
        <ConfirmDialog title={`Delete ${sel.ids.length} host(s)?`} message={<p>Deletes the endpoints, every check tied to them, and their metrics history.</p>} confirmWord="delete" actionLabel={`Delete ${sel.ids.length}`} onConfirm={() => bulk("delete", {}, "Deleted")} onClose={() => setDialog(null)} />
      )}
      {dialog === "move" && (
        <PromptDialog
          title={`Move ${sel.ids.length} host(s)`}
          label="Site (their checks move too)"
          options={sites.map((e) => ({ value: e.id, label: e.name }))}
          onClose={() => setDialog(null)}
          onSubmit={(v) => bulk("move", { siteId: v, moveChecks: true }, "Moved")}
        />
      )}
      {(dialog === "tags" || dialog === "untag") && (
        <PromptDialog title={dialog === "tags" ? "Add tags" : "Remove tags"} label="Tags (comma-separated)" onClose={() => setDialog(null)} onSubmit={(v) => bulk(dialog === "tags" ? "add_tags" : "remove_tags", { tags: v })} />
      )}
      {dialog === "maint" && (
        <PromptDialog title="Put in maintenance" label="For how many minutes?" help="Covers every check on these endpoints, including checks run from their agents." type="number" initial="60" onClose={() => setDialog(null)} onSubmit={(v) => bulk("maintenance", { minutes: Number(v) }, "Maintenance started for")} />
      )}
      {toast.node}
    </main>
  );
}

function BulkSuggestDialog({ channels, count, onClose, onSubmit }: { channels: Channel[]; count: number; onClose: () => void; onSubmit: (alertRule: ReturnType<typeof alertRulePayload>) => Promise<void> }) {
  const [alert, setAlert] = useState(emptyAlertOptions());
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Add suggested checks to ${count} host(s)`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-[var(--muted)]">Adds every recommended check each host doesn&apos;t have yet (open a host&apos;s Suggested checks tab to pick individually). Optionally attach an alert rule to all of them:</p>
        <AlertOptions channels={channels} value={alert} onChange={setAlert} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(alertRulePayload(alert));
              onClose();
            }}
          >
            Add checks
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CollectorLine({ host, sites }: { host: Endpoint; sites: string[] }) {
  const state = collectorState(host);
  return (
    <span className={`block text-xs ${state.tone === "bad" ? "text-[var(--down)]" : state.tone === "warn" ? "text-[var(--warn)]" : "text-[var(--muted)]"}`} title={host.collectorError ?? undefined}>
      Site collector for {sites.join(", ")} — {state.label}
    </span>
  );
}

function AddEndpointDialog({ sites, defaultSiteId, onClose, onCreated }: { sites: Site[]; defaultSiteId: string; onClose: () => void; onCreated: (h: Endpoint) => void }) {
  const [form, setForm] = useState({ siteId: defaultSiteId || sites[0]?.id || "", name: "", hostname: "", os: "", macAddress: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Add a host" onClose={onClose}>
      <form
        className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const h = await api.createEndpoint({ siteId: form.siteId, name: form.name, hostname: form.hostname || undefined, os: form.os || undefined, macAddress: form.macAddress || undefined });
            onCreated(h);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed");
          }
        }}
      >
        <Label label="Name *">
          <input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="nas" className={inputClass} />
        </Label>
        <Label label="Site">
          <select value={form.siteId} onChange={(e) => setForm({ ...form, siteId: e.target.value })} className={inputClass}>
            {sites.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Label>
        <Label label="Hostname / IP">
          <input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} className={inputClass} />
        </Label>
        <Label label="OS">
          <input value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })} placeholder="Ubuntu 24.04 / Windows 11" className={inputClass} />
        </Label>
        <Label label="MAC address" help="Optional — enables Wake-on-LAN.">
          <input value={form.macAddress} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} className={inputClass} />
        </Label>
        {error && <p className="text-[var(--down)] sm:col-span-2">{error}</p>}
        <p className="text-xs text-[var(--muted)] sm:col-span-2">After adding, open the host&apos;s Agent tab for its one-line install command.</p>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Add host
          </Button>
        </div>
      </form>
    </Modal>
  );
}
