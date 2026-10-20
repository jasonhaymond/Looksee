// "Templates" on an endpoint's Suggested checks tab: server-role templates
// (web, database, DNS, mail, file server, domain controller, hypervisor,
// Docker host, backup, print server) and security baselines (Windows, Linux,
// macOS), each adding the checks that role should have.
//
// Where this sits: under the suggestions in EndpointPanel's "Suggested
// checks" tab. The engine works out which roles the endpoint looks like and
// which of each template's checks it's missing (engine/src/services/
// roleTemplates.ts); "Apply" creates them.
//
// "use client" makes this a React component that runs in the browser.

"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Endpoint, type RoleTemplate } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { Button } from "./ui";

/**
 * The template list for one endpoint. Detected roles first.
 *
 * @param host the endpoint
 * @param onApplied reloads the endpoint's checks after an apply
 */
export function RoleTemplates({ host, onApplied }: { host: Endpoint; onApplied: () => void }) {
  const [templates, setTemplates] = useState<RoleTemplate[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const load = useCallback(() => api.roleTemplates(host.id).then(setTemplates), [host.id]);
  useEffect(() => {
    load();
  }, [load]);
  if (!templates) return null;
  // Detected first, then security baselines, then the rest.
  const sorted = [...templates].sort((a, b) => Number(b.detected) - Number(a.detected) || (a.kind === b.kind ? 0 : a.kind === "security" ? -1 : 1));

  return (
    <div className="space-y-2 border-t border-[var(--border)] pt-3 text-sm">
      <p className="font-medium">Templates</p>
      <p className="text-xs text-[var(--muted)]">Ready-made sets of checks for what this endpoint does. &ldquo;Looks like&rdquo; means its agent found the matching software; any template can be applied anyway.</p>
      {message && <p className="text-xs text-[var(--up)]">{message}</p>}
      <ul className="space-y-1.5">
        {sorted.map((t) => (
          <li key={t.id} className="rounded-md border border-[var(--border)] p-2">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{t.label}</span>
              {t.detected && <span className="rounded-full bg-[var(--up)]/15 px-2 py-0.5 text-xs text-[var(--up)]">✓ looks like this</span>}
              {t.kind === "security" && <span className="rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--muted)]">security</span>}
              <span className="text-xs text-[var(--muted)]">
                {t.checks.length ? `${t.checks.length} check(s) to add` : "all added"}
                {t.alreadyHave ? ` · ${t.alreadyHave} already here` : ""}
              </span>
              {t.checks.length > 0 && (
                <Button
                  className="ml-auto !py-0.5 text-xs"
                  disabled={busy === t.id}
                  onClick={async () => {
                    setBusy(t.id);
                    const r = await api.applyRoleTemplate(host.id, t.id);
                    setBusy(null);
                    setMessage(`${t.label}: added ${r.created} check(s).`);
                    load();
                    onApplied();
                  }}
                >
                  Apply
                </Button>
              )}
            </div>
            <p className="mt-0.5 text-xs text-[var(--muted)]">{t.description}</p>
            {t.checks.length > 0 && (
              <details className="mt-1 text-xs">
                <summary className="cursor-pointer text-[var(--muted)]">What it adds</summary>
                <ul className="mt-1 space-y-0.5 pl-4">
                  {t.checks.map((c) => (
                    <li key={c.key}>
                      <strong>{c.name.replace(`${host.name}: `, "")}</strong> <span className="text-[var(--muted)]">— {typeLabel(c.type)}. {c.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
