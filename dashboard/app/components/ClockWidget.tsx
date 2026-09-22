"use client";

import { useEffect, useState } from "react";

// Pure dashboard polish — no data dependency, just a live current-time tile.
export function ClockWidget() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="flex h-full flex-col items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      {now && (
        <>
          <p className="text-2xl font-semibold tabular-nums">{now.toLocaleTimeString()}</p>
          <p className="text-xs text-[var(--muted)]">{now.toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
        </>
      )}
    </div>
  );
}
