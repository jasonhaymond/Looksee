// Actions that run in the background after you confirm them.
//
// Where this sits: ConfirmDialog, PromptDialog and the bulk-action dialogs
// (components/ui.tsx, the Checks/Endpoints/Sites pages) close the moment you
// confirm, then hand the work to runInBackground() instead of keeping the
// dialog open with "Working…" until the engine answers. The
// BackgroundTasks component (components/BackgroundTasks.tsx, shown on every
// page by AppShell) lists what is still running and any that failed, so a
// slow or failed action is never silent. The pages' own toasts still report
// each action's result ("Deleted 4 checks.").
//
// The list lives in this module (one copy per browser tab), not in React
// state, so it survives moving to another page while an action runs.

export type BackgroundTask = { id: number; label: string; state: "running" | "failed"; error?: string };

let tasks: BackgroundTask[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

/** Tells every subscribed component the list changed. */
function emit() {
  for (const l of listeners) l();
}

/** The current list (a new array after every change, as React expects). */
export const backgroundTasks = () => tasks;

/**
 * Registers a callback run whenever the list changes; returns the
 * unsubscribe function. Shaped for React's useSyncExternalStore.
 */
export function subscribeBackground(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Removes one entry (the ✕ on a failed task, or a finished one). */
export function dismissBackground(id: number) {
  tasks = tasks.filter((t) => t.id !== id);
  emit();
}

/**
 * Starts `work` without waiting for it. While it runs, `label` is shown as
 * "Working…"; when it finishes the entry disappears, and if it throws, the
 * entry stays with the error message until dismissed (or for 15 seconds).
 *
 * @param label what's happening, e.g. "Delete 4 checks"
 * @param work the action itself — usually an engine API call plus a reload
 * @returns a promise that settles when the work does (callers rarely need it)
 */
export function runInBackground(label: string, work: () => Promise<unknown> | unknown): Promise<void> {
  const id = nextId++;
  tasks = [...tasks, { id, label, state: "running" }];
  emit();
  // Promise.resolve().then(work) also catches an error thrown synchronously.
  return Promise.resolve()
    .then(work)
    .then(
      () => dismissBackground(id),
      (err: unknown) => {
        tasks = tasks.map((t) => (t.id === id ? { ...t, state: "failed", error: err instanceof Error ? err.message : String(err) } : t));
        emit();
        setTimeout(() => dismissBackground(id), 15_000);
      }
    );
}
