"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, type Check, type Endpoint, type Host } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, Label, Modal, PromptDialog, StatusBadge, inputClass, useSelection, useToast } from "../components/ui";
import { displayStatus } from "../components/CheckDetail";
import { collectorState } from "../components/collector";

export default function EndpointsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState<Endpoint | "new" | null>(null);
  const [dialog, setDialog] = useState<"delete" | "merge" | "maint" | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [e, h, c] = await Promise.all([api.endpoints(), api.hosts(), api.checks()]);
    setEndpoints(e);
    setHosts(h);
    setChecks(c);
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

  return (
    <main className="mx-auto max-w-5xl p-4 sm:p-6">
      <TopNav active="/endpoints" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Endpoints</h2>
        <Button variant="primary" onClick={() => setEditing("new")}>
          + Add endpoint
        </Button>
      </div>
      <PageHelp anchor="endpoints">
        Endpoints group hosts and checks by location or network (home lab, office, a client site). For a site the Looksee server can&apos;t reach, pick one of its agent hosts as the <strong>site collector</strong> — it runs that site&apos;s network checks and posts results back over HTTPS, so no port forwarding is needed. Merge, pause, or remove several at once.
      </PageHelp>

      {loaded && endpoints.length === 0 ? (
        <EmptyState>No endpoints yet — add one to start grouping hosts and checks.</EmptyState>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]/40">
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)]">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(endpoints.map((e) => e.id), on)} label="Select all endpoints" />
            Select all
          </div>
          {endpoints.map((e) => {
            const s = stats.get(e.id)!;
            return (
              <div key={e.id} className={`flex flex-wrap items-center gap-3 border-t border-[var(--border)] px-3 py-3 text-sm first:border-t-0 ${sel.selected.has(e.id) ? "bg-[var(--up)]/5" : ""}`}>
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
        </div>
      )}

      <BulkBar
        count={sel.ids.length}
        noun="endpoint"
        onClear={sel.clear}
        actions={[
          { key: "maint", label: "Maintenance…", run: () => setDialog("maint") },
          { key: "on", label: "Enable all checks", run: () => bulk("enable_checks", {}, "Enabled checks:") },
          { key: "off", label: "Disable all checks", run: () => bulk("disable_checks", {}, "Disabled checks:") },
          { key: "merge", label: "Merge into…", run: () => setDialog("merge") },
          { key: "delete", label: "Delete…", danger: true, run: () => setDialog("delete") },
        ]}
      />

      {editing && (
        <EndpointDialog
          endpoint={editing === "new" ? null : editing}
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

function EndpointDialog({ endpoint, hosts, onClose, onSaved }: { endpoint: Endpoint | null; hosts: Host[]; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(endpoint?.name ?? "");
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
          const site = { collectorHostId: collectorHostId || null, publicIps: publicIps.split(/[\s,]+/).filter(Boolean) };
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
