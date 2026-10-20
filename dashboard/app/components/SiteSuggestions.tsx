// "Suggested checks" on a site's page: checks worth adding to the whole site
// — internet and public-IP checks for an office, a ping for endpoints with no
// checks, "agent online" for agents, toner and error checks for printers,
// certificate checks for HTTPS sites.
//
// Where this sits: on app/sites/[id]. The engine works the list out from the
// site's name and description, its endpoints and its existing checks
// (engine/src/services/siteSuggestions.ts); nothing shows when there's
// nothing to suggest.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type SiteSuggestion } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { Button } from "./ui";

/**
 * The suggestion list for one site, all ticked by default.
 *
 * @param siteId the site
 * @param onApplied called after checks were created (to reload the page)
 */
export function SiteSuggestions({ siteId, onApplied }: { siteId: string; onApplied: () => void }) {
  const [list, setList] = useState<SiteSuggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(
    () =>
      api.siteSuggestions(siteId).then((s) => {
        setList(s);
        setPicked(new Set(s.map((x) => x.key)));
      }),
    [siteId]
  );
  useEffect(() => {
    load();
  }, [load]);
  if (!list?.length) return message ? <p className="text-xs text-[var(--up)]">{message}</p> : null;

  return (
    <section className="surface space-y-2 rounded-xl p-4 text-sm">
      <h2 className="text-sm font-medium">Suggested checks ({list.length})</h2>
      <p className="text-xs text-[var(--muted)]">From this site&apos;s name and description, its endpoints and the checks it already has. Untick anything you don&apos;t want.</p>
      {[...new Set(list.map((s) => s.group ?? "Other"))].map((g) => (
        <div key={g}>
          <p className="text-xs font-medium uppercase tracking-wide text-[var(--muted)]">{g}</p>
          {list
            .filter((s) => (s.group ?? "Other") === g)
            .map((s) => (
              <label key={s.key} className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-[var(--panel-2)]">
                <input
                  type="checkbox"
                  className="mt-0.5 accent-[var(--up)]"
                  checked={picked.has(s.key)}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (n.has(s.key)) n.delete(s.key);
                      else n.add(s.key);
                      return n;
                    })
                  }
                />
                <span>
                  <span className="font-medium">{s.name}</span> <span className="text-xs text-[var(--muted)]">— {typeLabel(s.type)}. {s.reason}</span>
                </span>
              </label>
            ))}
        </div>
      ))}
      <Button
        variant="primary"
        disabled={!picked.size}
        onClick={async () => {
          const r = await api.applySiteSuggestions(siteId, [...picked]);
          setMessage(`Added ${r.created} check(s).`);
          load();
          onApplied();
        }}
      >
        Add {picked.size} check{picked.size === 1 ? "" : "s"}
      </Button>
    </section>
  );
}
