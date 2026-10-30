// The Sites & locations page (/sites): sites grouped by location with status
// counts, create/edit (collector, public IPs), and bulk actions. "use client"
// makes this a React component that runs in the browser; the engine refuses
// every call without a session.

"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, type Check, type Site, type Endpoint, type Location } from "../lib/api";
import { PageHelp } from "../components/PageHelp";
import { ActionMenu, BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, Label, Modal, MultiPicker, PromptDialog, StatusBadge, inputClass, useSelection, useToast } from "../components/ui";
import { displayStatus } from "../components/CheckDetail";
import { collectorState } from "../components/collector";
import { own, setOwn } from "../lib/own";

export default function SitesPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Site | "new" | null>(null);
  const [editingLocation, setEditingLocation] = useState<Location | "new" | null>(null);
  const [dialog, setDialog] = useState<"delete" | "merge" | "maint" | "location" | null>(null);
  // The location whose "Delete location…" confirmation is open.
  const [deletingLocation, setDeletingLocation] = useState<Location | null>(null);
  const toast = useToast();

  const load = useCallback(() =>
    Promise.all([api.sites(), api.endpoints(), api.checks(), api.locations()]).then(([e, h, c, l]) => {
    setSites(e);
    setEndpoints(h);
    setChecks(c);
    setLocations(l);
    setLoaded(true);
  }), []);

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

  const sel = useSelection(sites.map((e) => e.id));
  const stats = useMemo(() => {
    const m = new Map<string, { endpoints: number; checks: number; counts: Record<string, number> }>();
    for (const e of sites) m.set(e.id, { endpoints: 0, checks: 0, counts: {} });
    for (const h of endpoints) if (m.has(h.siteId)) m.get(h.siteId)!.endpoints++;
    for (const c of checks) {
      const s = m.get(c.siteId);
      if (!s) continue;
      s.checks++;
      const st = displayStatus(c);
      setOwn(s.counts, st, (own(s.counts, st) ?? 0) + 1);
    }
    return m;
  }, [sites, endpoints, checks]);

  /**
   * Runs one bulk action on the selected sites (POST /api/sites/bulk), shows
   * how many were affected, and reloads. The selection is read when the
   * action starts — it usually runs in the background after its dialog
   * closes — and cleared straight away for delete/merge, whose sites are gone.
   */
  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Updated") {
    const ids = sel.ids;
    if (action === "delete" || action === "merge") sel.clear();
    const res = await api.bulkSites(ids, action, params);
    toast.show(`${verb} ${res.affected}.`);
    await load();
  }

  if (!authChecked) return null;

  // Locations in name order, then sites without one.
  const sections: { location: Location | null; items: Site[] }[] = [
    ...locations.map((l) => ({ location: l, items: sites.filter((e) => e.locationId === l.id) })),
    { location: null, items: sites.filter((e) => !e.locationId || !locations.some((l) => l.id === e.locationId)) },
  ].filter((s) => s.location || s.items.length);
  const sumCounts = (items: Site[]) => {
    const out: Record<string, number> = {};
    for (const e of items) for (const [k, v] of Object.entries(stats.get(e.id)?.counts ?? {})) setOwn(out, k, (own(out, k) ?? 0) + v);
    return out;
  };

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Sites &amp; locations</h2>
        <div className="flex gap-2">
          <Button onClick={() => setEditingLocation("new")}>+ Add location</Button>
          <Button variant="primary" onClick={() => setEditing("new")}>
            + Add site
          </Button>
        </div>
      </div>
      <PageHelp anchor="sites">
        A <strong>location</strong> is a physical place (home, office, church); a <strong>site</strong> is a network at that place. Endpoints and checks belong to a site, and through it to its location. For a site the Looksee server can&apos;t reach, pick one of its agent endpoints as the <strong>site collector</strong>. Merge, pause, or move several sites at once.
      </PageHelp>

      {loaded && sites.length === 0 && locations.length === 0 ? (
        <EmptyState>No sites yet — add one to start grouping endpoints and checks.</EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex items-center gap-3 px-1 text-xs text-[var(--muted)]">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(sites.map((e) => e.id), on)} label="Select all sites" />
            Select all sites
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
                    own(counts, st) ? (
                      <span key={st} className="inline-flex items-center gap-1">
                        <StatusBadge status={st} compact /> {own(counts, st)} {st}
                      </span>
                    ) : null
                  )}
                </div>
                {location && (
                  <ActionMenu
                    label="Location"
                    actions={[
                      { key: "edit", label: "Edit / choose sites…", run: () => setEditingLocation(location) },
                      {
                        key: "maint",
                        label: "Maintenance for this location…",
                        run: async () => {
                          const m = Number(prompt(`Maintenance for every check at ${location.name} — how many minutes?`, "60"));
                          if (!m) return;
                          try {
                            const r = await api.locationMaintenance(location.id, m);
                            toast.show(`Maintenance started: ${r.checks} checks across ${r.sites} site(s).`);
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
                        run: () => setDeletingLocation(location),
                      },
                    ]}
                  />
                )}
              </div>
              {items.length === 0 && <p className="px-3 py-3 text-xs text-[var(--muted)]">No sites here yet — edit the location to choose some, or set one in a site&apos;s settings.</p>}
          {items.map((e) => {
            const s = stats.get(e.id)!;
            return (
              <div key={e.id} className={`flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-3 py-3 text-sm first:border-t-0 ${sel.selected.has(e.id) ? "bg-[var(--accent)]/10" : ""}`}>
                <Checkbox checked={sel.selected.has(e.id)} onChange={() => sel.toggle(e.id)} label={`Select ${e.name}`} />
                <div className="min-w-40 flex-1">
                  <div className="font-medium">{e.name}</div>
                  {e.description && <div className="text-xs text-[var(--muted)]">{e.description}</div>}
                  <SiteLine site={e} endpoints={endpoints} />
                </div>
                <div className="text-xs text-[var(--muted)]">
                  <Link className="underline" href="/endpoints">
                    {s.endpoints} host{s.endpoints === 1 ? "" : "s"}
                  </Link>{" "}
                  ·{" "}
                  <Link className="underline" href="/manage">
                    {s.checks} check{s.checks === 1 ? "" : "s"}
                  </Link>
                </div>
                <div className="flex gap-3 text-xs">
                  {["down", "warn", "up", "maintenance"].map((st) =>
                    own(s.counts, st) ? (
                      <span key={st} className="inline-flex items-center gap-1">
                        <StatusBadge status={st} compact /> {own(s.counts, st)}
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
        noun="site"
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
          title={`Set location for ${sel.ids.length} site(s)`}
          label="Location"
          options={[{ value: "", label: "— no location —" }, ...locations.map((l) => ({ value: l.id, label: l.name }))]}
          onClose={() => setDialog(null)}
          onSubmit={(v) => bulk("set_location", { locationId: v || null }, "Moved")}
        />
      )}
      {editingLocation && (
        <LocationDialog
          location={editingLocation === "new" ? null : editingLocation}
          sites={sites}
          onClose={() => setEditingLocation(null)}
          onSaved={() => {
            setEditingLocation(null);
            load();
          }}
        />
      )}
      {editing && (
        <SiteDialog
          site={editing === "new" ? null : editing}
          locations={locations}
          endpoints={endpoints}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {dialog === "delete" && (
        <ConfirmDialog
          title={`Delete ${sel.ids.length} site(s)?`}
          message={<p>Also deletes every endpoint and check inside them, with all history. To keep them, use “Merge into…” instead.</p>}
          confirmWord="delete"
          actionLabel={`Delete ${sel.ids.length}`}
          onConfirm={() => bulk("delete", {}, "Deleted")}
          onClose={() => setDialog(null)}
        />
      )}
      {deletingLocation && (
        // Typed confirmation: deleting a location is one of the three deletes
        // (with sites and endpoints) that still asks for the word "delete".
        <ConfirmDialog
          title={`Delete the location "${deletingLocation.name}"?`}
          message={<p>Its sites, endpoints and checks stay — they just won&apos;t belong to a location.</p>}
          confirmWord="delete"
          actionLabel="Delete location"
          onClose={() => setDeletingLocation(null)}
          onConfirm={async () => {
            await api.deleteLocation(deletingLocation.id);
            toast.show(`Deleted the location "${deletingLocation.name}".`);
            await load();
          }}
        />
      )}
      {dialog === "merge" && (
        <PromptDialog
          title={`Merge ${sel.ids.length} site(s)`}
          label="Move all their endpoints and checks into"
          help="The selected sites are deleted afterwards (they'll be empty)."
          options={sites.filter((e) => !sel.selected.has(e.id)).map((e) => ({ value: e.id, label: e.name }))}
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

function SiteLine({ site, endpoints }: { site: Site; endpoints: Endpoint[] }) {
  const collector = endpoints.find((h) => h.id === site.collectorEndpointId);
  if (!site.collectorEndpointId && !site.publicIps.length && !site.networks?.length) return null;
  const state = collector ? collectorState(collector) : null;
  return (
    <div className="mt-0.5 flex flex-wrap gap-x-3 text-xs">
      {site.collectorEndpointId && (
        <span className={state?.tone === "bad" ? "text-[var(--down)]" : state?.tone === "warn" ? "text-[var(--warn)]" : "text-[var(--muted)]"} title={collector?.collectorError ?? undefined}>
          Site collector: {collector?.name ?? "removed endpoint"} — {state?.label ?? "unknown"}
        </span>
      )}
      {site.networks?.length > 0 && <span className="text-[var(--muted)]">Ranges {site.networks.join(", ")}</span>}
      {site.publicIps.length > 0 && <span className="text-[var(--muted)]">Direct push from {site.publicIps.join(", ")}</span>}
    </div>
  );
}

function LocationDialog({ location, sites, onClose, onSaved }: { location: Location | null; sites: Site[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(location?.name ?? "");
  const [address, setAddress] = useState(location?.address ?? "");
  const [description, setDescription] = useState(location?.description ?? "");
  const [members, setMembers] = useState<string[]>(location ? sites.filter((e) => e.locationId === location.id).map((e) => e.id) : []);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={location ? `Edit ${location.name}` : "Add location"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const body = { name, address: address || null, description: description || null, siteIds: members };
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
          <div className="mb-1 text-xs text-[var(--muted)]">Sites (networks) at this location</div>
          <MultiPicker items={sites.map((e) => ({ id: e.id, label: e.name, sub: e.description ?? undefined }))} selected={members} onChange={setMembers} placeholder="Search sites…" height="max-h-48" />
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

function SiteDialog({ site, locations, endpoints, onClose, onSaved }: { site: Site | null; locations: Location[]; endpoints: Endpoint[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(site?.name ?? "");
  const [locationId, setLocationId] = useState(site?.locationId ?? "");
  const [description, setDescription] = useState(site?.description ?? "");
  const [collectorEndpointId, setCollectorEndpointId] = useState(site?.collectorEndpointId ?? "");
  const [publicIps, setPublicIps] = useState((site?.publicIps ?? []).join(", "));
  const [networks, setNetworks] = useState((site?.networks ?? []).join(", "));
  const [error, setError] = useState<string | null>(null);
  // Agent endpoints only — the collector runs under the agent. Endpoints already in
  // this site first, since the collector has to be at the site.
  const agentEndpoints = endpoints.filter((h) => h.hasAgentKey).sort((a, b) => Number(b.siteId === site?.id) - Number(a.siteId === site?.id) || a.name.localeCompare(b.name));
  const chosen = endpoints.find((h) => h.id === collectorEndpointId);
  const tooOld = chosen && !agentAtLeast(chosen.agentVersion, "3.2.0");
  return (
    <Modal title={site ? `Edit ${site.name}` : "Add site"} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          const siteFields = { collectorEndpointId: collectorEndpointId || null, publicIps: publicIps.split(/[\s,]+/).filter(Boolean), networks: networks.split(/[\s,]+/).filter(Boolean), locationId: locationId || null };
          try {
            if (site) await api.updateSite(site.id, { name, description: description || null, ...siteFields });
            else await api.createSite({ name, description: description || null, ...siteFields });
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
          help="For a site the Looksee server can't reach directly. The chosen endpoint's agent runs this site's network checks (ping, SNMP, HTTP…), receives its syslog/traps/flows, and runs its discovery scans and Wake-on-LAN — all sent back over HTTPS, no port forwarding. Leave on 'Looksee server' for the server's own network."
        >
          <select value={collectorEndpointId} onChange={(e) => setCollectorEndpointId(e.target.value)} className={inputClass}>
            <option value="">Looksee server (its own network)</option>
            {agentEndpoints.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
                {h.siteId !== site?.id ? " (in another site)" : ""}
                {h.agentVersion ? ` — agent v${h.agentVersion}` : " — agent not reporting yet"}
              </option>
            ))}
          </select>
        </Label>
        {tooOld && (
          <p className="rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
            {chosen!.name} runs agent {chosen!.agentVersion ? `v${chosen!.agentVersion}` : "(not reporting yet)"}. Site collectors need agent 3.2.0 or newer — use “Update agent” on the Endpoints page first, or this site&apos;s checks will show “waiting for the site collector”.
          </p>
        )}
        <Label
          label="Address ranges"
          help="This network's own ranges in CIDR form (10.20.0.0/24). Needed when one collector serves several sites: syslog, traps and flows it receives are filed under the site whose range holds the sender (otherwise under the collector's first site). Also used for sites the Looksee server receives from directly."
        >
          <input value={networks} onChange={(e) => setNetworks(e.target.value)} placeholder="10.20.0.0/24, 10.20.10.0/24" className={inputClass} />
        </Label>
        <Label
          label="Public IPs (direct push)"
          help="This site's public/WAN addresses. Devices there can send syslog, SNMP traps and NetFlow straight to the Looksee server's public address instead of to a collector; events from these IPs are accepted and filed under this site. Needs those ports forwarded to the Looksee server at its own site (see the user guide)."
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
  for (let i = 0; i < 3; i++) if ((a.at(i) ?? 0) !== (r.at(i) ?? 0)) return (a.at(i) ?? 0) > (r.at(i) ?? 0);
  return true;
}
