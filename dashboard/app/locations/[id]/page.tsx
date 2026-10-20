// A location's page (/locations/<id>): everything at that physical place —
// its sites, their endpoints, and every check, with status throughout.
//
// Where this sits: opened from the navigation tree or the Sites & locations
// page. The data is the location's branch of GET /api/tree (the same data
// the sidebar shows), so statuses here always agree with the tree. Editing
// the location itself stays on the Sites & locations page.
//
// "use client" makes this a React component that runs in the browser; the
// engine refuses every call without a session, and usePageAuth sends a
// signed-out visitor to the sign-in page.

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { api, type Tree, type TreeLocation } from "../../lib/api";
import { Breadcrumbs, ChecksTable, GroupChips, SummaryLine, type CheckRow } from "../../components/NodeViews";
import { StatusGlyph } from "../../components/Sidebar";
import { usePageAuth } from "../../components/usePageAuth";
import { pollEvery } from "../../lib/poll";

/** The page: loads the tree, finds this location, and lists its contents. */
export default function LocationPage() {
  const authed = usePageAuth();
  const { id } = useParams<{ id: string }>();
  const [tree, setTree] = useState<Tree | null>(null);

  // Load (and refresh every 30 s, like the sidebar) once signed in.
  useEffect(() => {
    if (!authed) return;
    const load = () => api.tree().then(setTree);
    load();
    const t = pollEvery(load, 30_000);
    return () => clearInterval(t);
  }, [authed]);

  if (!authed || !tree) return null;
  const loc: TreeLocation | undefined = tree.locations.find((l) => l.id === id);
  if (!loc) return <main className="mx-auto max-w-5xl p-4 sm:p-6 text-[var(--muted)]">This location doesn&apos;t exist (it may have been deleted).</main>;

  // Every check at the location, with the endpoint and site it belongs to.
  const allChecks: CheckRow[] = loc.sites.flatMap((s) => [
    ...s.endpoints.flatMap((e) => e.children.map((c) => ({ ...c, endpoint: e.name, site: s.name }))),
    ...s.checks.map((c) => ({ ...c, endpoint: null, site: s.name })),
  ]);

  return (
    <main className="mx-auto max-w-5xl space-y-4 p-4 sm:p-6">
      <div>
        <Breadcrumbs trail={[{ label: "Sites & locations", href: "/sites" }, { label: loc.name }]} />
        <h1 className="text-xl font-semibold">{loc.name}</h1>
        <SummaryLine status={loc.status} problems={loc.problems} checkCount={loc.checkCount} />
        <div className="mt-2">
          <GroupChips type="location" id={loc.id} />
        </div>
      </div>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-2 text-sm font-medium">Sites ({loc.sites.length})</h2>
        {loc.sites.length ? (
          <ul className="space-y-2">
            {loc.sites.map((s) => (
              <li key={s.id} className="rounded-lg border border-[var(--border)] p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <StatusGlyph status={s.status} />
                  <Link href={`/sites/${s.id}`} className="font-medium hover:underline">
                    {s.name}
                  </Link>
                  <span className="text-xs text-[var(--muted)]">
                    {s.endpoints.length} endpoint{s.endpoints.length === 1 ? "" : "s"} · {s.checkCount} checks
                    {s.problems ? <span className="text-[var(--down)]"> · {s.problems} with problems</span> : null}
                  </span>
                </div>
                {s.endpoints.length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 pl-5 text-xs">
                    {s.endpoints.map((e) => (
                      <Link key={e.id} href={`/endpoints/${e.id}`} className="inline-flex items-center gap-1 hover:underline">
                        <StatusGlyph status={e.status} />
                        {e.name}
                      </Link>
                    ))}
                  </div>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--muted)]">
            No sites here yet — assign sites to this location on <Link href="/sites" className="underline">Sites &amp; locations</Link>.
          </p>
        )}
      </section>

      <section className="surface rounded-xl p-4">
        <h2 className="mb-2 text-sm font-medium">All checks ({allChecks.length})</h2>
        <ChecksTable checks={allChecks} showWhere empty="No checks at this location yet." />
      </section>
    </main>
  );
}
