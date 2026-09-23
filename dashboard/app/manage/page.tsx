"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Endpoint, type Check, type CheckResult, type Host } from "../lib/api";
import { StatusTile } from "../components/StatusTile";
import { GroupSummary } from "../components/GroupSummary";
import { AddCheckForm } from "../components/AddCheckForm";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";

// Polling interval for refreshing dashboard data from the browser — separate
// from (and much coarser than) individual checks' own intervalSeconds, which
// control how often the engine itself re-probes each check.
const REFRESH_MS = 15_000;

function EndpointHeader({ endpoint, onChanged }: { endpoint: Endpoint; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(endpoint.name);

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.updateEndpoint(endpoint.id, { name: name.trim() });
    setRenaming(false);
    onChanged();
  }

  async function handleDelete() {
    if (!confirm(`Delete endpoint "${endpoint.name}"? This also deletes its hosts and checks.`)) return;
    await api.deleteEndpoint(endpoint.id);
    onChanged();
  }

  if (renaming) {
    return (
      <form onSubmit={handleRename} className="flex items-center gap-2">
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm outline-none"
        />
        <button type="submit" className="text-sm text-[var(--up)]">
          Save
        </button>
        <button type="button" onClick={() => setRenaming(false)} className="text-sm text-[var(--muted)]">
          Cancel
        </button>
      </form>
    );
  }

  return (
    <>
      <h2 className="font-medium">{endpoint.name}</h2>
      <button onClick={() => setRenaming(true)} className="text-xs text-[var(--muted)] underline hover:text-[var(--text)]">
        rename
      </button>
      <button onClick={handleDelete} className="text-xs text-[var(--down)] underline">
        delete
      </button>
    </>
  );
}

export default function ManagePage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [checksByEndpoint, setChecksByEndpoint] = useState<Map<string, Check[]>>(new Map());
  // Not scoped per-endpoint: a check's hostId has no constraint tying it to
  // the check's own endpoint (see engine/src/routes/checks.ts), and in
  // practice hosts often live under a different endpoint than the checks
  // that reference them (e.g. one endpoint per monitored service, hosts
  // registered under a separate "infrastructure" endpoint) — so the
  // selector offers every host, not just the current endpoint's.
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [latestByCheck, setLatestByCheck] = useState<Map<string, CheckResult>>(new Map());
  const [newEndpointName, setNewEndpointName] = useState("");

  const loadAll = useCallback(async () => {
    const endpointList = await api.endpoints();
    setEndpoints(endpointList);

    const perEndpointChecks = await Promise.all(endpointList.map((e) => api.checks(e.id)));
    const byId = new Map(endpointList.map((e, i) => [e.id, perEndpointChecks[i]]));
    setChecksByEndpoint(byId);

    setAllHosts(await api.hosts());

    const allChecks = perEndpointChecks.flat();
    const latestPairs = await Promise.all(
      allChecks.map(async (c) => {
        const results = await api.checkResults(c.id, 1);
        return [c.id, results[0]] as const;
      })
    );
    setLatestByCheck(new Map(latestPairs.filter(([, r]) => r)));
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
    loadAll();
    const timer = setInterval(loadAll, REFRESH_MS);
    return () => clearInterval(timer);
  }, [authChecked, loadAll]);

  async function handleAddEndpoint(e: React.FormEvent) {
    e.preventDefault();
    if (!newEndpointName.trim()) return;
    await api.createEndpoint(newEndpointName.trim());
    setNewEndpointName("");
    loadAll();
  }

  const endpointNameById = new Map(endpoints.map((e) => [e.id, e.name]));

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/manage" />
      <PageHelp anchor="endpoints-hosts-and-checks">
        Endpoints group your checks by location or network. Add checks here, or click an endpoint to manage its hosts and settings.
      </PageHelp>

      <div className="space-y-6">
        {endpoints.map((endpoint) => {
          const checks = checksByEndpoint.get(endpoint.id) ?? [];
          return (
            <section key={endpoint.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                <EndpointHeader endpoint={endpoint} onChanged={loadAll} />
                <GroupSummary checks={checks} latestByCheck={latestByCheck} />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {checks.map((check) => (
                  <StatusTile key={check.id} check={check} latest={latestByCheck.get(check.id)} hosts={allHosts} endpointNameById={endpointNameById} onChanged={loadAll} />
                ))}
              </div>
              <div className="mt-3">
                <AddCheckForm endpointId={endpoint.id} hosts={allHosts} endpointNameById={endpointNameById} onCreated={loadAll} />
              </div>
            </section>
          );
        })}

        <form onSubmit={handleAddEndpoint} className="flex gap-2">
          <input
            placeholder="New endpoint name"
            value={newEndpointName}
            onChange={(e) => setNewEndpointName(e.target.value)}
            className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
          />
          <button type="submit" className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
            Add endpoint
          </button>
        </form>
      </div>
    </main>
  );
}
