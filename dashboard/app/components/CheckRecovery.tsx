// Recovering a check without waiting for its next result: the "Resolve…"
// button, and the recovery URL other systems can call.
//
// Where this sits: shown on a check's page (app/checks/[id]) and in the
// inline check detail on the Checks list (CheckDetail.tsx). Resolving
// records an "up" result, which closes the check's alert incident and sends
// the usual recovery notification; event checks (traps/syslog) then ignore
// events from before that moment. See resolveCheck in
// engine/src/services/alerting.ts.
//
// "use client" makes these React components that run in the browser.

"use client";

import { useState } from "react";
import { api, type Check } from "../lib/api";
import { Button, PromptDialog } from "./ui";

// Check types whose URL receives results (not a recovery URL).
const PUSH_TYPES = new Set(["heartbeat", "push_value"]);

/**
 * "Resolve…" — shown only while the check is down or warn. Asks for an
 * optional note (kept in the result message), then marks it recovered.
 *
 * @param onDone called after the check is resolved, to reload it
 */
export function ResolveButton({ check, onDone, className = "" }: { check: Pick<Check, "id" | "lastStatus" | "enabled">; onDone: () => void; className?: string }) {
  const [open, setOpen] = useState(false);
  if (!check.enabled || (check.lastStatus !== "down" && check.lastStatus !== "warn")) return null;
  return (
    <>
      <Button className={className} onClick={() => setOpen(true)} title="Mark this check recovered now (closes its alert)">
        Resolve…
      </Button>
      {open && (
        <PromptDialog
          title="Resolve this check"
          label="Note (optional)"
          help="Records an “up” result now, closing the alert and sending the usual recovery notification. A check that polls reports its real status on its next run; a trap/syslog check ignores events from before now."
          actionLabel="Resolve"
          onClose={() => setOpen(false)}
          onSubmit={async (note) => {
            await api.resolveCheck(check.id, note);
            setOpen(false);
            onDone();
          }}
        />
      )}
    </>
  );
}

/**
 * The recovery URL for a check that isn't a heartbeat/push check: an
 * external system (a ticketing tool, a repair script) calls it with
 * status=up to mark the check recovered. Off until created; can be
 * regenerated (the old URL stops working) or removed.
 */
export function RecoveryUrl({ check, onChanged }: { check: Pick<Check, "id" | "type" | "pushUrl">; onChanged: () => void }) {
  if (PUSH_TYPES.has(check.type)) return null;
  return (
    <div className="space-y-1.5 rounded-md border border-[var(--border)] p-2 text-xs">
      <p className="text-[var(--muted)]">
        <strong className="text-[var(--text)]">Recovery URL</strong> — lets another system mark this check recovered by calling it with <code>?status=up</code> (optionally <code>&amp;msg=…</code>). It can&apos;t report a failure. The URL is the only credential; treat it like a password.
      </p>
      {check.pushUrl ? (
        <>
          <code className="block break-all rounded bg-[var(--code-bg)] p-1.5">{`curl -fsS "${check.pushUrl}?status=up"`}</code>
          <span className="flex gap-3">
            <button
              onClick={async () => {
                if (!confirm("Create a new URL? The current one stops working immediately.")) return;
                await api.regeneratePushToken(check.id);
                onChanged();
              }}
              className="text-[var(--muted)] underline"
            >
              Regenerate
            </button>
            <button
              onClick={async () => {
                await api.removeCheckToken(check.id);
                onChanged();
              }}
              className="text-[var(--muted)] underline"
            >
              Turn off
            </button>
          </span>
        </>
      ) : (
        <button
          onClick={async () => {
            await api.regeneratePushToken(check.id);
            onChanged();
          }}
          className="text-[var(--muted)] underline"
        >
          Create a recovery URL
        </button>
      )}
    </div>
  );
}
