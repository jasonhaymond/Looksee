"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Site, type Check, type CheckResult, type Host } from "../lib/api";
import { StatusTile } from "../components/StatusTile";
import { GroupSummary } from "../components/GroupSummary";
import { AddCheckForm } from "../components/AddCheckForm";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";

// Polling interval for refreshing dashboard data from the browser — separate
// from (and much coarser than) individual checks' own intervalSeconds, which
// control how often the engine itself re-probes each check.
const REFRESH_MS = 15_000;

function SiteHeader({ site, onChanged }: { site: Site; onChanged: () => void }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(site.name);

  async function handleRename(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    await api.updateSite(site.id, { name: name.trim() });
    setRenaming(false);
    onChanged();
  }

  async function handleDelete() {
    if (!confirm(`Delete site "${site.name}"? This also deletes its hosts and checks.`)) return;
    await api.deleteSite(site.id);
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
      <h2 className="font-medium">{site.name}</h2>
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
  const [sites, setSites] = useState<Site[]>([]);
  const [checksBySite, setChecksBySite] = useState<Map<string, Check[]>>(new Map());
  // Not scoped per-site: a check's hostId has no constraint tying it to the
  // check's own site (see engine/src/routes/checks.ts), and in practice
  // hosts often live under a different "site" than the checks that
  // reference them (e.g. one site per monitored service, hosts registered
  // under a separate "infrastructure" site) — so the selector offers every
  // host, not just the current site's.
  const [allHosts, setAllHosts] = useState<Host[]>([]);
  const [latestByCheck, setLatestByCheck] = useState<Map<string, CheckResult>>(new Map());
  const [newSiteName, setNewSiteName] = useState("");

  const loadAll = useCallback(async () => {
    const siteList = await api.sites();
    setSites(siteList);

    const perSiteChecks = await Promise.all(siteList.map((s) => api.checks(s.id)));
    const byId = new Map(siteList.map((s, i) => [s.id, perSiteChecks[i]]));
    setChecksBySite(byId);

    setAllHosts(await api.hosts());

    const allChecks = perSiteChecks.flat();
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

  async function handleAddSite(e: React.FormEvent) {
    e.preventDefault();
    if (!newSiteName.trim()) return;
    await api.createSite(newSiteName.trim());
    setNewSiteName("");
    loadAll();
  }

  const siteNameById = new Map(sites.map((s) => [s.id, s.name]));

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/manage" />
      <PageHelp anchor="sites-hosts-and-checks">
        Sites group your checks by location or network. Add checks here, or click a site to manage its hosts and settings.
      </PageHelp>

      <div className="space-y-6">
        {sites.map((site) => {
          const checks = checksBySite.get(site.id) ?? [];
          return (
            <section key={site.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                <SiteHeader site={site} onChanged={loadAll} />
                <GroupSummary checks={checks} latestByCheck={latestByCheck} />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {checks.map((check) => (
                  <StatusTile key={check.id} check={check} latest={latestByCheck.get(check.id)} hosts={allHosts} siteNameById={siteNameById} onChanged={loadAll} />
                ))}
              </div>
              <div className="mt-3">
                <AddCheckForm siteId={site.id} hosts={allHosts} siteNameById={siteNameById} onCreated={loadAll} />
              </div>
            </section>
          );
        })}

        <form onSubmit={handleAddSite} className="flex gap-2">
          <input
            placeholder="New site name"
            value={newSiteName}
            onChange={(e) => setNewSiteName(e.target.value)}
            className="flex-1 rounded-md border border-[var(--border)] bg-transparent px-3 py-2 text-sm outline-none"
          />
          <button type="submit" className="rounded-md border border-[var(--border)] px-3 py-2 text-sm">
            Add site
          </button>
        </form>
      </div>
    </main>
  );
}
