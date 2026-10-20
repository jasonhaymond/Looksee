// A site's page (/sites/<id>): one network — its endpoints, its site-level
// checks (URLs, DNS…), and every check on it, with status throughout.
//
// Where this sits: opened from the navigation tree or the Sites & locations
// page. Statuses and structure come from the site's branch of GET /api/tree,
// so they agree with the sidebar; the site's settings (collector, public
// IPs, location) come from GET /api/sites. Editing stays on the Sites &
// locations page.
//
// "use client" makes this a React component that runs in the browser; the
// engine refuses every call without a session, and usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Site, type Tree, type TreeSite } from "../../lib/api";
import { Breadcrumbs, ChecksTable, GroupChips, SummaryLine, type CheckRow, type Crumb } from "../../components/NodeViews";
import { StatusGlyph } from "../../components/Sidebar";
import { usePageAuth } from "../../components/usePageAuth";
import { pollEvery } from "../../lib/poll";

/** The page: loads the tree and the site's settings, then lists its contents. */
export default function SitePage() {
  const authed = usePageAuth();
  const { id } = useParams<{ id: string }>();
  const [tree, setTree] = useState<Tree | null>(null);
  const [site, setSite] = useState<Site | null>(null);

  // Load (and refresh every 30 s, like the sidebar) once signed in.
  useEffect(() => {
    if (!authed) return;
    const load = () => {
      api.tree().then(setTree);
      api.sites().then((list) => setSite(list.find((s) => s.id === id) ?? null));
    };
    load();
    const t = pollEvery(load, 30_000);
    return () => clearInterval(t);
  }, [authed, id]);

  if (!authed || !tree) return null;
  // The site may sit under a location or among the unassigned ones.
  const loc = tree.locations.find((l) => l.sites.some((s) => s.id === id));
  const node: TreeSite | undefined = (loc?.sites ?? tree.unassignedSites).find((s) => s.id === id);
  if (!node) return <main className="mx-auto max-w-5xl p-4 sm:p-6 text-[var(--muted)]">This site doesn&apos;t exist (it may have been deleted).</main>;

  const trail: Crumb[] = [{ label: "Sites & locations", href: "/sites" }];
  if (loc) trail.push({ label: loc.name, href: `/locations/${loc.id}` });
  trail.push({ label: node.name });
  const collector = node.endpoints.find((e) => e.collector);
  // Every check on the site, with the endpoint it belongs to.
  const allChecks: CheckRow[] = [...node.endpoints.flatMap((e) => e.children.map((c) => ({ ...c, endpoint: e.name, site: node.name }))), ...node.checks.map((c) => ({ ...c, endpoint: null, site: node.name }))];

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <Breadcrumbs trail={trail} />
        <h1 className="text-xl font-semibold">{node.name}</h1>
        <SummaryLine status={node.status} problems={node.problems} checkCount={node.checkCount} />
        {site?.description && <p className="mt-1 text-sm text-[var(--muted)]">{site.description}</p>}
        <p className="mt-1 text-xs text-[var(--muted)]">
          {collector ? (
            <>
              Site collector: <Link href={`/endpoints/${collector.id}`} className="underline">{collector.name}</Link> (runs this site&apos;s network checks, receivers and discovery)
            </>
          ) : (
            "Network checks run from the Looksee server"
          )}
          {site?.publicIps.length ? ` · Direct push accepted from ${site.publicIps.join(", ")}` : ""}
          {" · "}
          <Link href="/sites" className="underline">
            Edit site
          </Link>
        </p>
        <div className="mt-2">
          <GroupChips type="site" id={node.id} />
        </div>
      </div>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-2 text-sm font-medium">Endpoints ({node.endpoints.length})</h2>
        {node.endpoints.length ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-[var(--muted)]">
                  <th className="py-1 pr-2 font-normal">Status</th>
                  <th className="py-1 pr-2 font-normal">Endpoint</th>
                  <th className="py-1 pr-2 font-normal">OS</th>
                  <th className="py-1 pr-2 font-normal">Agent</th>
                  <th className="py-1 font-normal">Checks</th>
                </tr>
              </thead>
              <tbody>
                {node.endpoints.map((e) => (
                  <tr key={e.id} className="border-t border-[var(--border)]">
                    <td className="py-1.5 pr-2">
                      <span className="inline-flex items-center gap-1 text-xs">
                        <StatusGlyph status={e.status} />
                        {e.status ?? "no checks"}
                      </span>
                    </td>
                    <td className="py-1.5 pr-2">
                      <Link href={`/endpoints/${e.id}`} className="hover:underline">
                        {e.name}
                      </Link>
                      {e.collector && <span className="ml-1 text-xs text-[var(--muted)]">(site collector)</span>}
                    </td>
                    <td className="py-1.5 pr-2 text-xs text-[var(--muted)]">{e.os ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-xs text-[var(--muted)]">{e.agent ? "yes" : "no"}</td>
                    <td className="py-1.5 text-xs">
                      {e.checkCount}
                      {e.problems ? <span className="text-[var(--down)]"> · {e.problems} with problems</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="text-sm text-[var(--muted)]">
            No endpoints on this site yet — add one on the <Link href="/endpoints" className="underline">Endpoints</Link> page or with <Link href="/discovery" className="underline">Discovery</Link>.
          </p>
        )}
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-2 text-sm font-medium">All checks ({allChecks.length})</h2>
        <ChecksTable checks={allChecks} showWhere empty="No checks on this site yet." />
      </section>
    </main>
  );
}
