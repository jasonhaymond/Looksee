// The small panel in the bottom-right corner listing actions still running
// in the background (lib/background.ts) and any that failed.
//
// Where this sits: AppShell shows it on every signed-in page. Nothing is
// drawn while no action is running.
//
// "use client" makes this run in the browser. useSyncExternalStore is
// React's way to read a value kept outside React (here, the task list) and
// re-draw when it changes.

"use client";

import { useSyncExternalStore } from "react";
import { backgroundTasks, dismissBackground, subscribeBackground } from "../lib/background";

const NONE: never[] = [];

/** Lists running ("Working…") and failed background actions. */
export function BackgroundTasks() {
  // The server render has no tasks; the third argument says so.
  const tasks = useSyncExternalStore(subscribeBackground, backgroundTasks, () => NONE);
  if (!tasks.length) return null;
  return (
    <div className="fixed bottom-3 right-3 z-[60] w-72 max-w-[calc(100vw-1.5rem)] space-y-1.5" aria-live="polite">
      {tasks.map((t) => (
        <div key={t.id} role="status" className={`flex items-start gap-2 rounded-lg border bg-[var(--panel-2)] px-3 py-2 text-xs shadow-xl ${t.state === "failed" ? "border-[var(--down)]" : "border-[var(--border-strong)]"}`}>
          {/* Status in words as well as color (colorblind-safe). */}
          <span className={`min-w-0 flex-1 ${t.state === "failed" ? "text-[var(--down)]" : ""}`}>
            <span className="font-medium">{t.state === "failed" ? "Failed: " : "Working: "}</span>
            {t.label}
            {t.state === "running" && "…"}
            {t.error && <span className="block break-words text-[var(--muted)]">{t.error}</span>}
          </span>
          {t.state === "failed" && (
            <button onClick={() => dismissBackground(t.id)} aria-label="Dismiss" className="text-[var(--muted)] hover:text-[var(--text)]">
              ✕
            </button>
          )}
        </div>
      ))}
    </div>
  );
}
