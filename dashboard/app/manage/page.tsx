"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Site, type Check, type CheckResult } from "../lib/api";
import { StatusTile } from "../components/StatusTile";
import { GroupSummary } from "../components/GroupSummary";
import { AddCheckForm } from "../components/AddCheckForm";
import { TopNav } from "../components/TopNav";

// Polling interval for refreshing dashboard data from the browser — separate
// from (and much coarser than) individual checks' own intervalSeconds, which
// control how often the engine itself re-probes each check.
const REFRESH_MS = 15_000;

export default function ManagePage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [checksBySite, setChecksBySite] = useState<Map<string, Check[]>>(new Map());
  const [latestByCheck, setLatestByCheck] = useState<Map<string, CheckResult>>(new Map());
  const [newSiteName, setNewSiteName] = useState("");

  const loadAll = useCallback(async () => {
    const siteList = await api.sites();
    setSites(siteList);

    const perSiteChecks = await Promise.all(siteList.map((s) => api.checks(s.id)));
    const byId = new Map(siteList.map((s, i) => [s.id, perSiteChecks[i]]));
    setChecksBySite(byId);

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

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/manage" />

      <div className="space-y-6">
        {sites.map((site) => {
          const checks = checksBySite.get(site.id) ?? [];
          return (
            <section key={site.id} className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
              <div className="mb-3 flex items-center gap-2">
                <h2 className="font-medium">{site.name}</h2>
                <GroupSummary checks={checks} latestByCheck={latestByCheck} />
              </div>
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                {checks.map((check) => (
                  <StatusTile key={check.id} check={check} latest={latestByCheck.get(check.id)} />
                ))}
              </div>
              <div className="mt-3">
                <AddCheckForm siteId={site.id} onCreated={loadAll} />
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
