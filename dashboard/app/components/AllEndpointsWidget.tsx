"use client";

import type { Endpoint } from "../lib/api";

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

export function AllEndpointsWidget({ endpoints, siteNameById }: { endpoints: Endpoint[]; siteNameById: Map<string, string> }) {
  return (
    <div className="h-full overflow-auto surface rounded-lg p-3">
      <h3 className="mb-2 font-medium">All endpoints</h3>
      {endpoints.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">No endpoints yet — see Endpoints to install the agent somewhere.</p>
      ) : (
        <ul className="space-y-1 text-xs">
          {endpoints.map((h) => {
            const online = h.lastSeenAt != null && Date.now() - new Date(h.lastSeenAt).getTime() < STALE_AFTER_MS;
            return (
              <li key={h.id} className="flex items-center gap-2">
                <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: online ? "var(--up)" : "var(--down)" }} />
                <span className="truncate">{h.name}</span>
                <span className="text-[var(--muted)]">{siteNameById.get(h.siteId) ?? ""}</span>
                <span className="ml-auto shrink-0 text-[var(--muted)]">{timeAgo(h.lastSeenAt)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
