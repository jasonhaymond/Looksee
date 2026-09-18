"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Site, type Host } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { Tooltip } from "../components/Tooltip";

function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function HostRow({
  host,
  siteName,
  onChanged,
  revealedKey,
  onIssueKey,
}: {
  host: Host;
  siteName: string;
  onChanged: () => void;
  revealedKey: string | undefined;
  onIssueKey: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(host.name);
  const [hostname, setHostname] = useState(host.hostname ?? "");
  const [os, setOs] = useState(host.os ?? "");

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    await api.updateHost(host.id, { name, hostname: hostname || null, os: os || null });
    setEditing(false);
    onChanged();
  }

  async function handleDelete() {
    if (!confirm(`Delete host "${host.name}"? Any checks tied to it (e.g. agent service checks) are deleted too.`)) return;
    await api.deleteHost(host.id);
    onChanged();
  }

  if (editing) {
    return (
      <li className="rounded-md border border-[var(--border)] p-3 text-sm">
        <form onSubmit={handleSave} className="space-y-2">
          <input value={name} onChange={(e) => setName(e.target.value)} required className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" placeholder="Name" />
          <input value={hostname} onChange={(e) => setHostname(e.target.value)} className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" placeholder="Hostname/IP (optional, for your reference)" />
          <input value={os} onChange={(e) => setOs(e.target.value)} className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none" placeholder="OS (optional, e.g. Ubuntu 24.04)" />
          <div className="flex gap-2">
            <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1 font-medium text-black">
              Save
            </button>
            <button type="button" onClick={() => setEditing(false)} className="text-[var(--muted)]">
              Cancel
            </button>
          </div>
        </form>
      </li>
    );
  }

  return (
    <li className="rounded-md border border-[var(--border)] p-3 text-sm">
      <div className="flex items-center justify-between">
        <div>
          <span className="font-medium">{host.name}</span>{" "}
          <span className="text-[var(--muted)]">
            ({siteName}){host.hostname ? ` · ${host.hostname}` : ""}
            {host.os ? ` · ${host.os}` : ""} · last report: {relativeTime(host.lastSeenAt)}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing(true)} className="text-xs text-[var(--muted)] hover:underline">
            Edit
          </button>
          <span className="inline-flex items-center text-xs text-[var(--up)]">
            <button onClick={onIssueKey} className="hover:underline">
              Generate agent key
            </button>
            <Tooltip text="Creates a fresh credential for the Looksee agent running on this host. The old key stops working immediately — only paste this into one place, the host's own looksee-agent.yaml." />
          </span>
          <button onClick={handleDelete} className="text-xs text-[var(--down)] hover:underline">
            Delete
          </button>
        </div>
      </div>
      {revealedKey && (
        <div className="mt-2 rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
          <p className="mb-1 text-[var(--warn)]">
            Copy this now — it won&apos;t be shown again. Paste it as <code>agent_key</code> in this host&apos;s
            <code> looksee-agent.yaml</code>.
          </p>
          <code className="break-all">{revealedKey}</code>
        </div>
      )}
    </li>
  );
}

export default function HostsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [name, setName] = useState("");
  const [hostname, setHostname] = useState("");
  const [os, setOs] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [revealedKeys, setRevealedKeys] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    const siteList = await api.sites();
    setSites(siteList);
    if (!selectedSiteId && siteList[0]) setSelectedSiteId(siteList[0].id);
    setHosts(await api.hosts());
  }, [selectedSiteId]);

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

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedSiteId) {
      setError("Choose a site first");
      return;
    }
    try {
      await api.createHost({ siteId: selectedSiteId, name, hostname: hostname || undefined, os: os || undefined });
      setName("");
      setHostname("");
      setOs("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create host");
    }
  }

  async function handleIssueKey(hostId: string) {
    const { agentApiKey } = await api.issueAgentKey(hostId);
    setRevealedKeys((prev) => ({ ...prev, [hostId]: agentApiKey }));
  }

  if (!authChecked) return null;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "?";

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/hosts" />
      <h2 className="mb-4 text-lg font-medium">Hosts</h2>

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        {hosts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No hosts yet — add one below, then run the agent against it (see agent/README.md).</p>
        ) : (
          <ul className="space-y-3">
            {hosts.map((h) => (
              <HostRow key={h.id} host={h} siteName={siteName(h.siteId)} onChanged={load} revealedKey={revealedKeys[h.id]} onIssueKey={() => handleIssueKey(h.id)} />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <h2 className="mb-3 font-medium">Add a host</h2>
        <form onSubmit={handleCreate} className="space-y-2 text-sm">
          <div className="flex flex-wrap gap-2">
            <select
              value={selectedSiteId}
              onChange={(e) => setSelectedSiteId(e.target.value)}
              className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1"
            >
              {sites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Host name (e.g. nas)"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <span className="inline-flex flex-1 items-center gap-1">
              <input
                placeholder="Hostname/IP (optional)"
                value={hostname}
                onChange={(e) => setHostname(e.target.value)}
                className="w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
              />
              <Tooltip text="Just for your own reference in this list — not used by any check. A host's actual reachability is set up separately as a check (ping/TCP/etc.) pointing at this address." />
            </span>
            <input
              placeholder="OS (optional, e.g. Ubuntu 24.04)"
              value={os}
              onChange={(e) => setOs(e.target.value)}
              className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
            />
          </div>
          <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1.5 font-medium text-black">
            Add host
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-[var(--down)]">{error}</p>}
      </section>
    </main>
  );
}
