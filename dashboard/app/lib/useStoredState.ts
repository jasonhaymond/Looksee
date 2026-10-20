// A value remembered in this browser (localStorage) — the theme, which
// sidebar sections are open, how the Checks page groups — read and written
// like React state.
//
// Why not "read it in an effect and copy it into state": that renders once
// with the default and again with the saved value (a flash), and React's
// lint rules flag setting state directly inside an effect. This hook reads
// localStorage through useSyncExternalStore (React's way to read a value
// that lives outside React), so the first browser render already has the
// saved value; the server render uses the fallback. Writes go to
// localStorage and notify every component using the same key. Storage may be
// unavailable (private mode, blocked site data) — then the fallback is used
// and nothing is remembered.

import { useCallback, useMemo, useSyncExternalStore } from "react";

// Same-tab notifications: localStorage's own "storage" event only fires in
// other tabs.
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((l) => l());

/** Subscribes to changes from this tab (notify) and other tabs ("storage"). */
function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

/** The raw stored text for a key, or null (missing or storage unavailable). */
function readRaw(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * A remembered value.
 *
 * @param key the localStorage key
 * @param fallback the value when nothing (valid) is stored
 * @param parse turns the stored text into a value, or returns undefined
 *   when it isn't valid (then the fallback is used)
 * @param serialize turns a value into stored text
 * @returns [value, setValue]
 */
export function useStoredState<T>(key: string, fallback: T, parse: (raw: string) => T | undefined, serialize: (v: T) => string): [T, (v: T) => void] {
  // The raw string is what React compares between renders (a stable value);
  // parsing happens in useMemo below.
  const raw = useSyncExternalStore(
    subscribe,
    () => readRaw(key),
    () => null
  );
  const value = useMemo(() => (raw == null ? fallback : (parse(raw) ?? fallback)), [raw, fallback, parse]);
  const setValue = useCallback(
    (v: T) => {
      try {
        localStorage.setItem(key, serialize(v));
      } catch {
        // Not remembered; the page still works.
      }
      notify();
    },
    [key, serialize]
  );
  return [value, setValue];
}

/** Parses stored JSON into a plain object of booleans (open/closed maps). */
export function parseFlags(raw: string): Record<string, boolean> | undefined {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, b]) => typeof b === "boolean")) as Record<string, boolean>;
  } catch {
    return undefined;
  }
}
