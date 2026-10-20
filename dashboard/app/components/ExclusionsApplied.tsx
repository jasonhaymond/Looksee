// "Ignoring: …" — everything a check excludes, and where each item comes from
// (the check's own Exclude setting, or a named list on the Exclusions page).
//
// Where this sits: shown on a check's page (app/checks/[id]) and in the
// inline check detail on the Checks list (CheckDetail.tsx), so it's always
// visible why something isn't being alerted on. The engine works the list
// out (GET /api/checks/:id/exclusions, engine/src/services/exclusions.ts);
// nothing is shown for checks that ignore nothing.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { api, type Check, type ExclusionItem } from "../lib/api";

/**
 * The list of excluded items for one check, grouped by source.
 *
 * @param check the check; reloads when its settings change
 */
export function ExclusionsApplied({ check }: { check: Pick<Check, "id" | "config"> }) {
  const [items, setItems] = useState<ExclusionItem[]>([]);
  // Re-fetch when the check's settings change (e.g. after editing its
  // Exclude field), not on every re-render.
  const configKey = JSON.stringify(check.config ?? {});
  useEffect(() => {
    api
      .checkExclusions(check.id)
      .then(setItems)
      .catch(() => setItems([]));
  }, [check.id, configKey]);

  if (!items.length) return null;
  // Group by source: "this check" first, then each list by name.
  const bySource = new Map<string, { label: string; listId?: string; values: string[] }>();
  for (const i of items) {
    const key = i.source.type === "check" ? "check" : i.source.id;
    if (!bySource.has(key)) bySource.set(key, { label: i.source.type === "check" ? "this check" : i.source.name, listId: i.source.type === "list" ? i.source.id : undefined, values: [] });
    bySource.get(key)!.values.push(i.value);
  }
  return (
    <div className="space-y-1 rounded-md border border-[var(--border)] p-2 text-xs">
      <p className="text-[var(--muted)]">
        <strong className="text-[var(--text)]">Ignoring {items.length} item{items.length === 1 ? "" : "s"}</strong> — not counted or alerted on.
      </p>
      {[...bySource.values()].map((s) => (
        <p key={s.label} className="flex flex-wrap items-center gap-1">
          <span className="text-[var(--muted)]">
            From{" "}
            {s.listId ? (
              <Link href="/exclusions" className="underline">
                {s.label}
              </Link>
            ) : (
              s.label
            )}
            :
          </span>
          {s.values.slice(0, 20).map((v) => (
            <code key={v} className="rounded bg-[var(--code-bg)] px-1 py-0.5">
              {v}
            </code>
          ))}
          {s.values.length > 20 && <span className="text-[var(--muted)]">+{s.values.length - 20} more</span>}
        </p>
      ))}
    </div>
  );
}
