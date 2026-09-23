"use client";

import type { Host } from "../lib/api";

// A host has no single "check" of its own — online/offline here is a
// last-seen recency heuristic (default agent report interval is 30s; 3
// minutes gives real slack for a slower configured interval or a blip
// before flagging a host as gone), distinct from any individual check's
// up/down status.
const STALE_AFTER_MS = 3 * 60 * 1000;

function timeAgo(iso: string | null): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return `${Math.floor(ms / 86_400_000)}d ago`;
}

export function AllHostsWidget({ hosts, endpointNameById }: { hosts: Host[]; endpointNameById: Map<string, string> }) {
  return (
    <div className="h-full overflow-auto rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <h3 className="mb-2 font-medium">All hosts</h3>
      {hosts.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No hosts yet — see Hosts to install the agent somewhere.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {hosts.map((h) => {
            const online = h.lastSeenAt != null && Date.now() - new Date(h.lastSeenAt).getTime() < STALE_AFTER_MS;
            return (
              <li key={h.id} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: online ? "var(--up)" : "var(--down)" }} />
                <span className="truncate">{h.name}</span>
                <span className="text-[var(--muted)]">{endpointNameById.get(h.endpointId) ?? ""}</span>
                <span className="ml-auto shrink-0 text-[var(--muted)]">{timeAgo(h.lastSeenAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
