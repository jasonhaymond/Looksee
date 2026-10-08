"use client";

import { useState } from "react";
import Link from "next/link";
import type { Check, CheckResult, Host } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { AlertRuleManager } from "./AlertRuleManager";
import { CheckHistory } from "./CheckHistory";
import { StatusBadge, relativeTime } from "./ui";
import { displayStatus } from "./CheckDetail";

// Dashboard tile for one check. Editing lives on the Checks page (one place
// to change a check); the tile links there and keeps the inline alert-rule
// manager for quick tweaks.
export function StatusTile({ check, latest }: { check: Check; latest: CheckResult | undefined; hosts?: Host[]; endpointNameById?: Map<string, string>; onChanged?: () => void }) {
  const status = displayStatus(check);
  const [showAlerts, setShowAlerts] = useState(false);

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <div className="flex items-center gap-2">
        <StatusBadge status={status} compact />
        <span className="truncate font-medium">{check.name}</span>
        <span className="text-[10px] tracking-wide text-[var(--muted)]">{status.toUpperCase()}</span>
      </div>
      <div className="mt-1 text-xs text-[var(--muted)]">
        {typeLabel(check.type)}
        {latest ? (
          <>
            {" · "}
            {latest.latencyMs != null ? `${latest.latencyMs}ms · ` : ""}
            {relativeTime(latest.checkedAt)}
          </>
        ) : (
          " · no results yet"
        )}
        {" · "}
        <button onClick={() => setShowAlerts((v) => !v)} className="underline">
          {showAlerts ? "hide alerts" : "alerts"}
        </button>
        {" · "}
        <Link href="/manage" className="underline">
          manage
        </Link>
      </div>
      {check.lastMessage && status !== "up" && <p className="mt-1 truncate text-xs" title={check.lastMessage}>{check.lastMessage}</p>}
      <CheckHistory checkId={check.id} currentStatus={check.lastStatus ?? "unknown"} />
      {showAlerts && (
        <div className="mt-2 border-t border-[var(--border)] pt-2">
          <AlertRuleManager checkId={check.id} />
        </div>
      )}
    </div>
  );
}
