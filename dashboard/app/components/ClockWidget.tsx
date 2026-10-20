// Dashboard widget: the current date and time, ticking every second
// (lib/useNow.ts).

"use client";

import { useNow } from "../lib/useNow";

// Pure dashboard polish — no data dependency, just a live current-time tile.
export function ClockWidget() {
  // Ticks every second (lib/useNow.ts); 0 during the server render, when
  // nothing is shown so the server's and browser's times can't disagree.
  const ms = useNow();
  const now = ms ? new Date(ms) : null;

  return (
    <div className="flex h-full flex-col items-center justify-center surface rounded-lg p-3">
      {now && (
        <>
          <p className="text-2xl font-semibold tabular-nums">{now.toLocaleTimeString()}</p>
          <p className="text-xs text-[var(--muted)]">{now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
        </>
      )}
    </div>
  );
}
