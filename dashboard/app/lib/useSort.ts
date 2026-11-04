// Sortable lists: a React hook (a reusable piece of component behaviour) that
// remembers which column a list is sorted by and sorts rows accordingly. The headers
// that drive it are SortTh, SortHead and SortPicker in components/ui.tsx.
//
// The choice is remembered per list in this browser (lib/useStoredState.ts), so a
// page keeps its order across visits and the 30-second refreshes. Lists are sorted
// in the browser, so a list the engine sends a page at a time (alert history, logs,
// received events) sorts what's loaded, not everything ever recorded.

import { useCallback } from "react";
import { own } from "./own";
import { compareSortValues, type SortDir, type SortValue } from "./sortValues";
import { useStoredState } from "./useStoredState";

/** A list's current order: a column and a direction, or null for its natural order. */
export type SortState = { key: string; dir: SortDir } | null;

/** Reads a saved choice; anything that isn't one is ignored. */
function parseSort(raw: string): SortState | undefined {
  try {
    const v = JSON.parse(raw) as { key?: unknown; dir?: unknown } | null;
    return v && typeof v.key === "string" && (v.dir === "asc" || v.dir === "desc") ? { key: v.key, dir: v.dir } : undefined;
  } catch {
    return undefined;
  }
}

/** What a sortable header needs from the list it controls. */
export type SortControl = {
  /** The column being sorted by, or null. */
  key: string | null;
  dir: SortDir;
  /** A header was clicked: ascending, then descending, then back to the default. */
  toggle: (key: string) => void;
  /** Sets the column and direction outright (the dropdown on lists with no headers). */
  set: (state: SortState) => void;
};

/**
 * Sorting for one list.
 *
 * @param id names this list in the browser's memory, e.g. "alerts"
 * @param columns how to read each sortable column from a row
 * @param initial the order before anything is chosen; null keeps the order the rows
 *   arrived in (usually newest first, from the engine)
 * @returns the control for the headers, and apply, which returns a sorted copy of
 *   some rows. Rows that tie keep their order, so sorting never shuffles them.
 */
export function useSort<T>(id: string, columns: Record<string, (row: T) => SortValue>, initial: SortState = null): SortControl & { apply: (rows: readonly T[]) => T[] } {
  const [saved, setSaved] = useStoredState<SortState>(`looksee.sort.${id}`, initial, parseSort, JSON.stringify);
  // A saved column that no longer exists falls back to the default. own() ignores
  // inherited names, so a tampered saved value such as "__proto__" can't be called.
  const sort = saved && own(columns, saved.key) ? saved : initial;
  const toggle = useCallback(
    (key: string) => {
      if (sort?.key !== key) setSaved({ key, dir: "asc" });
      else if (sort.dir === "asc") setSaved({ key, dir: "desc" });
      else setSaved(initial?.key === key ? { key, dir: "asc" } : initial);
    },
    [sort, initial, setSaved]
  );
  const apply = (rows: readonly T[]) => {
    const read = sort ? own(columns, sort.key) : undefined;
    if (!sort || !read) return [...rows];
    // Array.prototype.sort keeps tied rows in their original order.
    return [...rows].sort((a, b) => compareSortValues(read(a), read(b), sort.dir));
  };
  return { key: sort?.key ?? null, dir: sort?.dir ?? "asc", toggle, set: setSaved, apply };
}
