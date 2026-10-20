// An endpoint's page (/endpoints/<id>): one device — its status, checks,
// live metrics, processes, services, IP history, agent and settings.
//
// Where this sits: opened from the navigation tree, a site page, or the
// Endpoints list. The tabs are the same EndpointPanel the Endpoints list
// opens inline (components/EndpointPanel.tsx); this page adds where the
// endpoint lives (breadcrumbs), its status summary and its groups.
//
// "use client" makes this a React component that runs in the browser; the
// engine refuses every call without a session, and usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { api, ApiError, type Channel, type Check, type EndpointDetail, type Location, type Site, type Tree } from "../../lib/api";
import { EndpointPanel, endpointState } from "../../components/EndpointPanel";
import { Breadcrumbs, GroupChips, SummaryLine, type Crumb } from "../../components/NodeViews";
import { relativeTime } from "../../components/ui";
import { usePageAuth } from "../../components/usePageAuth";
import { pollEvery } from "../../lib/poll";

/** The page: loads the endpoint and what its panel needs. */
export default function EndpointPage() {
  const authed = usePageAuth();
  const { id } = useParams<{ id: string }>();
  const [endpoint, setEndpoint] = useState<EndpointDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [tree, setTree] = useState<Tree | null>(null);
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null);

  // Everything the page shows, in parallel. A 404 means the endpoint was deleted.
  const load = useCallback(
    () =>
      api
        .endpoint(id)
        .then((ep) => {
          setEndpoint(ep);
          return Promise.all([api.sites(), api.locations(), api.checks(ep.siteId), api.channels(), api.tree(), api.health()]);
        })
        .then(([s, l, c, ch, t, health]) => {
          setSites(s);
          setLocations(l);
          setChecks(c);
          setChannels(ch);
          setTree(t);
          setLatestAgentVersion(health.agentVersion);
        })
        .catch((err) => {
          if (err instanceof ApiError && err.status === 404) setMissing(true);
        }),
    [id]
  );

  // Load once signed in, then refresh every 30 s.
  useEffect(() => {
    if (!authed) return;
    load();
    const t = pollEvery(load, 30_000);
    return () => clearInterval(t);
  }, [authed, load]);

  if (!authed) return null;
  if (missing) return <main className="mx-auto max-w-6xl p-4 sm:p-6 text-[var(--muted)]">This endpoint doesn&apos;t exist (it may have been deleted).</main>;
  if (!endpoint) return null;

  const site = sites.find((s) => s.id === endpoint.siteId);
  const loc = site?.locationId ? locations.find((l) => l.id === site.locationId) : undefined;
  const trail: Crumb[] = [{ label: "Endpoints", href: "/endpoints" }];
  if (loc) trail.push({ label: loc.name, href: `/locations/${loc.id}` });
  if (site) trail.push({ label: site.name, href: `/sites/${site.id}` });
  trail.push({ label: endpoint.name });
  // Status summary from the tree, so it matches the sidebar.
  const node = tree ? [...tree.locations.flatMap((l) => l.sites), ...tree.unassignedSites].flatMap((s) => s.endpoints).find((e) => e.id === endpoint.id) : undefined;
  const state = endpointState(endpoint);

  return (
    <main className="mx-auto max-w-6xl space-y-3 p-4 sm:p-6">
      <div>
        <Breadcrumbs trail={trail} />
        <h1 className="text-xl font-semibold">{endpoint.name}</h1>
        {node && <SummaryLine status={node.status} problems={node.problems} checkCount={node.checkCount} />}
        <p className="mt-1 text-xs text-[var(--muted)]">
          {[endpoint.hostname, endpoint.os, endpoint.macAddress].filter(Boolean).join(" · ")}
          {" · agent "}
          {state === "no agent" ? "not installed" : `${state}${endpoint.agentVersion ? ` (v${endpoint.agentVersion})` : ""}, last report ${relativeTime(endpoint.lastSeenAt)}`}
        </p>
        <div className="mt-2">
          <GroupChips type="endpoint" id={endpoint.id} />
        </div>
      </div>
      <div className="surface overflow-hidden rounded-xl">
        <EndpointPanel host={endpoint} sites={sites} checks={checks} channels={channels} latestAgentVersion={latestAgentVersion} onChanged={load} />
      </div>
    </main>
  );
}
