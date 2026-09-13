"use client";

import { useState } from "react";
import type { Check, CheckResult } from "../lib/api";
import { AlertRuleManager } from "./AlertRuleManager";
import { CheckHistory } from "./CheckHistory";

const STATUS_COLOR: Record<string, string> = {
  up: "var(--up)",
  down: "var(--down)",
  warn: "var(--warn)",
  unknown: "var(--muted)",
};

// Status is never conveyed by color alone (dataviz skill's status-color
// rule — confirmed by running the palette validator: up/down fail
// colorblind-safe separation on their own). The dot carries color; this
// text label is the required secondary encoding, in a neutral text token,
// not the status color itself.
const STATUS_LABEL: Record<string, string> = {
  up: "UP",
  down: "DOWN",
  warn: "WARN",
  unknown: "UNKNOWN",
};

function relativeTime(iso: string) {
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  return `${Math.round(seconds / 3600)}h ago`;
}

export function StatusTile({ check, latest }: { check: Check; latest: CheckResult | undefined }) {
  const status = latest?.status ?? "unknown";
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <button onClick={() => setExpanded((v) => !v)} className="flex w-full items-center gap-2 text-left">
        <span className="h-2.5 w-2.5 rounded-full" style={{ background: STATUS_COLOR[status] }} />
        <span className="font-medium">{check.name}</span>
        <span className="text-[10px] tracking-wide text-[var(--muted)]">{STATUS_LABEL[status]}</span>
      </button>
      <div className="mt-1 text-xs text-[var(--muted)]">
        {check.type}
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
        <button onClick={() => setExpanded((v) => !v)} className="underline">
          {expanded ? "hide alerts" : "alerts"}
        </button>
      </div>
      <CheckHistory checkId={check.id} currentStatus={status} />
      {expanded && <AlertRuleManager checkId={check.id} />}
    </div>
  );
}
