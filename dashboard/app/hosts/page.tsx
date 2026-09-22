"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Site, type Host } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { Tooltip } from "../components/Tooltip";
import { PageHelp } from "../components/PageHelp";

function relativeTime(iso: string | null) {
  if (!iso) return "never";
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--text)]"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function HostRow({
  host,
  siteName,
  onChanged,
  revealed,
  onIssueKey,
  latestAgentVersion,
}: {
  host: Host;
  siteName: string;
  onChanged: () => void;
  revealed: { agentApiKey: string; installCommands: { unix: string; windows: string } } | undefined;
  onIssueKey: () => void;
  latestAgentVersion: string | null;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(host.name);
  const [hostname, setHostname] = useState(host.hostname ?? "");
  const [os, setOs] = useState(host.os ?? "");
  const [platform, setPlatform] = useState<"unix" | "windows">("unix");
  const [updateRequested, setUpdateRequested] = useState(false);
  const updateAvailable = Boolean(host.agentVersion && latestAgentVersion && host.agentVersion !== latestAgentVersion);

  async function handleRequestUpdate() {
    await api.requestHostUpdate(host.id);
    setUpdateRequested(true);
  }

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
            {host.agentVersion && ` · agent v${host.agentVersion}`}
            {updateAvailable && <span className="text-[var(--warn)]"> (v{latestAgentVersion} available)</span>}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button onClick={() => setEditing(true)} className="text-xs text-[var(--muted)] hover:underline">
            Edit
          </button>
          {host.agentVersion && (
            <span className="inline-flex items-center text-xs text-[var(--up)]">
              <button onClick={handleRequestUpdate} disabled={updateRequested} className="hover:underline disabled:opacity-40 disabled:no-underline">
                {updateRequested ? "Update requested" : "Update agent"}
              </button>
              <Tooltip text="Flags this host's agent to download and install the current build on its next check-in (usually within its polling interval). Its version above will change once it's done — no separate progress indicator, since it's the same signal." />
            </span>
          )}
          <span className="inline-flex items-center text-xs text-[var(--up)]">
            <button onClick={onIssueKey} className="hover:underline">
              Generate agent key
            </button>
            <Tooltip text="Creates a fresh credential for this host and a ready-to-run install command. The old key stops working immediately if one already existed." />
          </span>
          <button onClick={handleDelete} className="text-xs text-[var(--down)] hover:underline">
            Delete
          </button>
        </div>
      </div>
      {revealed && (
        <div className="mt-2 space-y-2 rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
          <p className="text-[var(--warn)]">
            Copy this now — it won&apos;t be shown again. Run it on <strong>{host.name}</strong> itself, elevated
            (<code>sudo</code> on Linux/macOS, an Administrator PowerShell on Windows), for the automatic service
            install:
          </p>
          <div className="flex gap-1">
            {(["unix", "windows"] as const).map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPlatform(p)}
                className={`rounded px-2 py-0.5 ${platform === p ? "bg-[var(--warn)]/30 text-[var(--text)]" : "text-[var(--muted)]"}`}
              >
                {p === "unix" ? "Linux / macOS" : "Windows"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-black/30 p-1.5">{revealed.installCommands[platform]}</code>
            <CopyButton text={revealed.installCommands[platform]} />
          </div>
          <details>
            <summary className="cursor-pointer text-[var(--muted)]">Just the raw key (manual setup)</summary>
            <div className="mt-1 flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-black/30 p-1.5">{revealed.agentApiKey}</code>
              <CopyButton text={revealed.agentApiKey} />
            </div>
          </details>
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
  const [revealedKeys, setRevealedKeys] = useState<Record<string, { agentApiKey: string; installCommands: { unix: string; windows: string } }>>({});
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null);

  const load = useCallback(async () => {
    const siteList = await api.sites();
    setSites(siteList);
    if (!selectedSiteId && siteList[0]) setSelectedSiteId(siteList[0].id);
    setHosts(await api.hosts());
    setLatestAgentVersion((await api.health()).agentVersion);
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
    const { agentApiKey, installCommands } = await api.issueAgentKey(hostId);
    setRevealedKeys((prev) => ({ ...prev, [hostId]: { agentApiKey, installCommands } }));
  }

  if (!authChecked) return null;
  const siteName = (id: string) => sites.find((s) => s.id === id)?.name ?? "?";

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/hosts" />
      <h2 className="mb-4 text-lg font-medium">Hosts</h2>
      <PageHelp anchor="hosts">
        A host is a machine with the Looksee agent installed — add one, then use its install command to set up the agent. Hosts unlock service/process/resource checks.
      </PageHelp>

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        {hosts.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No hosts yet — add one below, then run the agent against it (see agent/README.md).</p>
        ) : (
          <ul className="space-y-3">
            {hosts.map((h) => (
              <HostRow key={h.id} host={h} siteName={siteName(h.siteId)} onChanged={load} revealed={revealedKeys[h.id]} onIssueKey={() => handleIssueKey(h.id)} latestAgentVersion={latestAgentVersion} />
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
