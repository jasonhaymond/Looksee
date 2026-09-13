"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Site, type Host } from "../lib/api";
import { TopNav } from "../components/TopNav";

function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export default function HostsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [selectedSiteId, setSelectedSiteId] = useState("");
  const [name, setName] = useState("");
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
      await api.createHost(selectedSiteId, name);
      setName("");
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create host");
    }
  }

  async function handleIssueKey(hostId: string) {
    const { agentApiKey } = await api.issueAgentKey(hostId);
    setRevealedKeys((prev) => ({ ...prev, [hostId]: agentApiKey }));
  }

  async function handleDelete(hostId: string) {
    await api.deleteHost(hostId);
    load();
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
              <li key={h.id} className="rounded-md border border-[var(--border)] p-3 text-sm">
                <div className="flex items-center justify-between">
                  <div>
                    <span className="font-medium">{h.name}</span>{" "}
                    <span className="text-[var(--muted)]">
                      ({siteName(h.siteId)}) · last report: {relativeTime(h.lastSeenAt)}
                    </span>
                  </div>
                  <div className="flex items-center gap-3">
                    <button onClick={() => handleIssueKey(h.id)} className="text-xs text-[var(--up)] hover:underline">
                      Generate agent key
                    </button>
                    <button onClick={() => handleDelete(h.id)} className="text-xs text-[var(--down)] hover:underline">
                      Delete
                    </button>
                  </div>
                </div>
                {revealedKeys[h.id] && (
                  <div className="mt-2 rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
                    <p className="mb-1 text-[var(--warn)]">
                      Copy this now — it won&apos;t be shown again. Paste it as <code>agent_key</code> in this host&apos;s
                      <code> looksee-agent.yaml</code>.
                    </p>
                    <code className="break-all">{revealedKeys[h.id]}</code>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <h2 className="mb-3 font-medium">Add a host</h2>
        <form onSubmit={handleCreate} className="flex flex-wrap gap-2 text-sm">
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
          <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1.5 font-medium text-black">
            Add host
          </button>
        </form>
        {error && <p className="mt-2 text-xs text-[var(--down)]">{error}</p>}
      </section>
    </main>
  );
}
