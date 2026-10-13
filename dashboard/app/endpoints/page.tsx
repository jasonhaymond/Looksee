"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, type Check, type Endpoint, type Host, type Location } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { ActionMenu, BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, Label, Modal, MultiPicker, PromptDialog, StatusBadge, inputClass, useSelection, useToast } from "../components/ui";
import { displayStatus } from "../components/CheckDetail";
import { collectorState } from "../components/collector";

export default function EndpointsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Endpoint | "new" | null>(null);
  const [editingLocation, setEditingLocation] = useState<Location | "new" | null>(null);
  const [dialog, setDialog] = useState<"delete" | "merge" | "maint" | "location" | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [e, h, c, l] = await Promise.all([api.endpoints(), api.hosts(), api.checks(), api.locations()]);
    setEndpoints(e);
    setHosts(h);
    setChecks(c);
    setLocations(l);
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
    if (authChecked) load();
  }, [authChecked, load]);

  const sel = useSelection(endpoints.map((e) => e.id));
  const stats = useMemo(() => {
    const m = new Map<string, { hosts: number; checks: number; counts: Record<string, number> }>();
    for (const e of endpoints) m.set(e.id, { hosts: 0, checks: 0, counts: {} });
    for (const h of hosts) if (m.has(h.endpointId)) m.get(h.endpointId)!.hosts++;
    for (const c of checks) {
      const s = m.get(c.endpointId);
      if (!s) continue;
      s.checks++;
      const st = displayStatus(c);
      s.counts[st] = (s.counts[st] ?? 0) + 1;
    }
    return m;
  }, [endpoints, hosts, checks]);

  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Updated") {
    const res = await api.bulkEndpoints(sel.ids, action, params);
    toast.show(`${verb} ${res.affected}.`);
    if (action === "delete" || action === "merge") sel.clear();
    await load();
  }

  if (!authChecked) return null;

  // Locations in name order, then endpoints without one.
  const sections: { location: Location | null; items: Endpoint[] }[] = [
    ...locations.map((l) => ({ location: l, items: endpoints.filter((e) => e.locationId === l.id) })),
    { location: null, items: endpoints.filter((e) => !e.locationId || !locations.some((l) => l.id === e.locationId)) },
  ].filter((s) => s.location || s.items.length);
  const sumCounts = (items: Endpoint[]) => {
    const out: Record<string, number> = {};
    for (const e of items) for (const [k, v] of Object.entries(stats.get(e.id)?.counts ?? {})) out[k] = (out[k] ?? 0) + v;
    return out;
  };

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <TopNav active="/endpoints" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Endpoints &amp; locations</h2>
        <div className="flex gap-2">
          <Button onClick={() => setEditingLocation("new")}>+ Add location</Button>
          <Button variant="primary" onClick={() => setEditing("new")}>
            + Add endpoint
          </Button>
        </div>
      </div>
      <PageHelp anchor="endpoints">
        A <strong>location</strong> is a physical place (home, office, church); an <strong>endpoint</strong> is a network at that place. Hosts and checks belong to an endpoint, and through it to its location. For a site the Looksee server can&apos;t reach, pick one of its agent hosts as the <strong>site collector</strong>. Merge, pause, or move several endpoints at once.
      </PageHelp>

      {loaded && endpoints.length === 0 && locations.length === 0 ? (
        <EmptyState>No endpoints yet — add one to start grouping hosts and checks.</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 px-1 text-xs text-[var(--muted)]">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(endpoints.map((e) => e.id), on)} label="Select all endpoints" />
            Select all endpoints
          </div>
          {sections.map(({ location, items }) => {
            const counts = sumCounts(items);
            return (
            <section key={location?.id ?? "none"} className="surface overflow-hidden rounded-xl">
              <div className="flex flex-wrap items-center gap-3 border-b border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
                <div className="min-w-40 flex-1">
                  <div className="font-medium">{location ? location.name : "No location"}</div>
                  {location && (location.address || location.description) && <div className="text-xs text-[var(--muted)]">{[location.address, location.description].filter(Boolean).join(" · ")}</div>}
                </div>
                <div className="flex gap-3 text-xs">
                  {["down", "warn", "up", "maintenance"].map((st) =>
                    counts[st] ? (
                      <span key={st} className="inline-flex items-center gap-1">
                        <StatusBadge status={st} compact /> {counts[st]} {st}
                      </span>
                    ) : null
                  )}
                </div>
                {location && (
                  <ActionMenu
                    label="Location"
                    actions={[
                      { key: "edit", label: "Edit / choose endpoints…", run: () => setEditingLocation(location) },
                      {
                        key: "maint",
                        label: "Maintenance for this location…",
                        run: async () => {
                          const m = Number(prompt(`Maintenance for every check at ${location.name} — how many minutes?`, "60"));
                          if (!m) return;
                          try {
                            const r = await api.locationMaintenance(location.id, m);
                            toast.show(`Maintenance started: ${r.checks} checks across ${r.endpoints} endpoint(s).`);
                          } catch (err) {
                            toast.show(err instanceof Error ? err.message : "Failed", "error");
                          }
                        },
                      },
                      { key: "checks", label: "View its checks", run: () => router.push("/manage") },
                      {
                        key: "delete",
                        label: "Delete location…",
                        danger: true,
                        run: async () => {
                          if (!confirm(`Delete the location "${location.name}"? Its endpoints, hosts and checks stay — they just won't belong to a location.`)) return;
                          await api.deleteLocation(location.id);
                          load();
                        },
                      },
                    ]}
                  />
                )}
              </div>
              {items.length === 0 && <p className="px-3 py-3 text-xs text-[var(--muted)]">No endpoints here yet — edit the location to choose some, or set one in an endpoint&apos;s settings.</p>}
          {items.map((e) => {
            const s = stats.get(e.id)!;
            return (
              <div key={e.id} className={`flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-3 py-3 text-sm first:border-t-0 ${sel.selected.has(e.id) ? "bg-[var(--accent)]/10" : ""}`}>
                <Checkbox checked={sel.selected.has(e.id)} onChange={() => sel.toggle(e.id)} label={`Select ${e.name}`} />
                <div className="min-w-40 flex-1">
                  <div className="font-medium">{e.name}</div>
                  {e.description && <div className="text-xs text-[var(--muted)]">{e.description}</div>}
                  <SiteLine endpoint={e} hosts={hosts} />
                </div>
                <div className="text-xs text-[var(--muted)]">
                  <Link className="underline" href="/hosts">
                    {s.hosts} host{s.hosts === 1 ? "" : "s"}
                  </Link>{" "}
                  ·{" "}
                  <Link className="underline" href="/manage">
                    {s.checks} check{s.checks === 1 ? "" : "s"}
                  </Link>
                </div>
                <div className="flex gap-3 text-xs">
                  {["down", "warn", "up", "maintenance"].map((st) =>
                    s.counts[st] ? (
                      <span key={st} className="inline-flex items-center gap-1">
                        <StatusBadge status={st} compact /> {s.counts[st]}
                      </span>
                    ) : null
                  )}
                </div>
                <button className="text-xs text-[var(--muted)] underline" onClick={() => setEditing(e)}>
                  Edit
                </button>
              </div>
            );
          })}
            </section>
            );
          })}
        </div>
      )}

      <BulkBar
        count={sel.ids.length}
        noun="endpoint"
        onClear={sel.clear}
        actions={[
          { group: "Checks", key: "maint", label: "Maintenance…", run: () => setDialog("maint") },
          { group: "Checks", key: "on", label: "Enable all checks", run: () => bulk("enable_checks", {}, "Enabled checks:") },
          { group: "Checks", key: "off", label: "Disable all checks", run: () => bulk("disable_checks", {}, "Disabled checks:") },
          { group: "Organize", key: "loc", label: "Set location…", run: () => setDialog("location") },
          { group: "Organize", key: "merge", label: "Merge into…", run: () => setDialog("merge") },
          { key: "delete", label: "Delete…", danger: true, run: () => setDialog("delete") },
        ]}
      />

      {dialog === "location" && (
        <PromptDialog
          title={`Set location for ${sel.ids.length} endpoint(s)`}
          label="Location"
          options={[{ value: "", label: "— no location —" }, ...locations.map((l) => ({ value: l.id, label: l.name }))]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => bulk("set_location", { locationId: v || null }, "Moved")}
        />
      )}
      {editingLocation && (
        <LocationDialog
          location={editingLocation === "new" ? null : editingLocation}
          endpoints={endpoints}
          onClose={() => setEditingLocation(null)}
          onSaved={() => {
            setEditingLocation(null);
            load();
          }}
        />
      )}
      {editing && (
        <EndpointDialog
          endpoint={editing === "new" ? null : editing}
          locations={locations}
          hosts={hosts}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${sel.ids.length} endpoint(s)?`}
          message={<p>Also deletes every host and check inside them, with all history. To keep them, use “Merge into…” instead.</p>}
          confirmWord="delete"
          actionLabel={`Delete ${sel.ids.length}`}
          onConfirm={() => bulk("delete", {}, "Deleted")}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog === "merge" && (
        <PromptDialog
          title={`Merge ${sel.ids.length} endpoint(s)`}
          label="Move all their hosts and checks into"
          help="The selected endpoints are deleted afterwards (they'll be empty)."
          options={endpoints.filter((e) => !sel.selected.has(e.id)).map((e) => ({ value: e.id, label: e.name }))}
          actionLabel="Merge"
          onClose={() => setDialog(null)}
          onSubmit={(v) => bulk("merge", { targetId: v }, "Merged")}
        />
      )}
      {dialog === "maint" && <PromptDialog title="Put in maintenance" label="For how many minutes?" type="number" initial="60" onClose={() => setDialog(null)} onSubmit={(v) => bulk("maintenance", { minutes: Number(v) }, "Maintenance started for")} />}
      {toast.node}
    </main>
  );
}

function SiteLine({ endpoint, hosts }: { endpoint: Endpoint; hosts: Host[] }) {
  const collector = hosts.find((h) => h.id === endpoint.collectorHostId);
  if (!endpoint.collectorHostId && !endpoint.publicIps.length) return null;
  const state = collector ? collectorState(collector) : null;
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
      {endpoint.collectorHostId && (
        <span className={state?.tone === "bad" ? "text-[var(--down)]" : state?.tone === "warn" ? "text-[var(--warn)]" : "text-[var(--muted)]"} title={collector?.collectorError ?? undefined}>
          Site collector: {collector?.name ?? "removed host"} — {state?.label ?? "unknown"}
        </span>
      )}
      {endpoint.publicIps.length > 0 && <span className="text-[var(--muted)]">Direct push from {endpoint.publicIps.join(", ")}</span>}
    </div>
  );
}

function LocationDialog({ location, endpoints, onClose, onSaved }: { location: Location | null; endpoints: Endpoint[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(location?.name ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [description, setDescription] = useState(location?.description ?? "");
  const [members, setMembers] = useState<string[]>(location ? endpoints.filter((e) => e.locationId === location.id).map((e) => e.id) : []);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={location ? `Edit ${location.name}` : "Add location"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const body = { name, address: address || null, description: description || null, endpointIds: members };
            if (location) await api.updateLocation(location.id, body);
            else await api.createLocation(body);
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't save");
          }
        }}
      >
        <Label label="Name *">
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Home, Main office, Church" className={inputClass} />
        </Label>
        <Label label="Address">
          <input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Street, city" className={inputClass} />
        </Label>
        <Label label="Notes">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Who to call, where the rack is…" className={inputClass} />
        </Label>
        <div>
          <div className="mb-1 text-xs text-[var(--muted)]">Endpoints (networks) at this location</div>
          <MultiPicker items={endpoints.map((e) => ({ id: e.id, label: e.name, sub: e.description ?? undefined }))} selected={members} onChange={setMembers} placeholder="Search endpoints…" height="max-h-48" />
        </div>
        {error && <p className="text-sm text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function EndpointDialog({ endpoint, locations, hosts, onClose, onSaved }: { endpoint: Endpoint | null; locations: Location[]; hosts: Host[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(endpoint?.name ?? "");
  const [locationId, setLocationId] = useState(endpoint?.locationId ?? "");
  const [description, setDescription] = useState(endpoint?.description ?? "");
  const [collectorHostId, setCollectorHostId] = useState(endpoint?.collectorHostId ?? "");
  const [publicIps, setPublicIps] = useState((endpoint?.publicIps ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  // Agent hosts only — the collector runs under the agent. Hosts already in
  // this endpoint first, since the collector has to be at the site.
  const agentHosts = hosts.filter((h) => h.hasAgentKey).sort((a, b) => Number(b.endpointId === endpoint?.id) - Number(a.endpointId === endpoint?.id) || a.name.localeCompare(b.name));
  const chosen = hosts.find((h) => h.id === collectorHostId);
  const tooOld = chosen && !agentAtLeast(chosen.agentVersion, "3.2.0");
  return (
    <Modal title={endpoint ? `Edit ${endpoint.name}` : "Add endpoint"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const site = { collectorHostId: collectorHostId || null, publicIps: publicIps.split(/[\s,]+/).filter(Boolean), locationId: locationId || null };
          try {
            if (endpoint) await api.updateEndpoint(endpoint.id, { name, description: description || null, ...site });
            else await api.createEndpoint({ name, description: description || null, ...site });
            onSaved();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't save");
          }
        }}
      >
        <Label label="Name *">
          <input autoFocus required value={name} onChange={(e) => setName(e.target.value)} placeholder="Home lab" className={inputClass} />
        </Label>
        <Label label="Description">
          <input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="pfSense VLANs at home" className={inputClass} />
        </Label>
        <Label label="Location" help="The physical place this network is at. Add locations with “+ Add location”.">
          <select value={locationId} onChange={(e) => setLocationId(e.target.value)} className={inputClass}>
            <option value="">No location</option>
            {locations.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
        </Label>
        <Label
          label="Site collector"
          help="For a site the Looksee server can't reach directly. The chosen host's agent runs this endpoint's network checks (ping, SNMP, HTTP…), receives its syslog/traps/flows, and runs its discovery scans and Wake-on-LAN — all sent back over HTTPS, no port forwarding. Leave on 'Looksee server' for the server's own network."
        >
          <select value={collectorHostId} onChange={(e) => setCollectorHostId(e.target.value)} className={inputClass}>
            <option value="">Looksee server (its own network)</option>
            {agentHosts.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.endpointId !== endpoint?.id ? " (in another endpoint)" : ""}
                {h.agentVersion ? ` — agent v${h.agentVersion}` : " — agent not reporting yet"}
              </option>
            ))}
          </select>
        </Label>
        {tooOld && (
          <p className="rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
            {chosen!.name} runs agent {chosen!.agentVersion ? `v${chosen!.agentVersion}` : "(not reporting yet)"}. Site collectors need agent 3.2.0 or newer — use “Update agent” on the Hosts page first, or this site&apos;s checks will show “waiting for the site collector”.
          </p>
        )}
        <Label
          label="Public IPs (direct push)"
          help="This site's public/WAN addresses. Devices there can send syslog, SNMP traps and NetFlow straight to the Looksee server's public address instead of to a collector; events from these IPs are accepted and filed under this endpoint. Needs those ports forwarded to the Looksee server at its own site (see the user guide)."
        >
          <input value={publicIps} onChange={(e) => setPublicIps(e.target.value)} placeholder="203.0.113.10, 2001:db8::1" className={inputClass} />
        </Label>
        {error && <p className="text-sm text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Save
          </Button>
        </div>
      </form>
    </Modal>
  );
}

function agentAtLeast(actual: string | null, required: string) {
  if (!actual) return false;
  if (actual === "dev") return true;
  const a = actual.split(".").map((n) => parseInt(n, 10) || 0);
  const r = required.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (r[i] ?? 0)) return (a[i] ?? 0) > (r[i] ?? 0);
  return true;
}
