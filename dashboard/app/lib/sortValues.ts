// How two values compare when a list is sorted. Kept apart from the React hook
// (useSort.ts) so the rules can be tested on their own.

/** Anything a column can sort by. */
export type SortValue = string | number | boolean | Date | null | undefined;
/** Which way a column is sorted. */
export type SortDir = "asc" | "desc";

/** A value with nothing in it: no value, an empty text, or not a number. */
const isBlank = (v: SortValue) => v == null || v === "" || (typeof v === "number" && Number.isNaN(v));

/**
 * Compares two values for sorting.
 *
 * Text compares the way people expect rather than letter by letter: case is
 * ignored and numbers inside it count as numbers, so "server2" comes before
 * "server10" and 10.0.0.2 before 10.0.0.10. Blank values always go last, whichever
 * way the column is sorted, so "—" rows never crowd the top of a list.
 *
 * @param dir the direction, which reverses everything except where blanks go
 * @returns a negative number if a comes first, positive if b does, 0 if equal
 */
export function compareSortValues(a: SortValue, b: SortValue, dir: SortDir = "asc"): number {
  if (isBlank(a) || isBlank(b)) return isBlank(a) ? (isBlank(b) ? 0 : 1) : -1;
  const sign = dir === "asc" ? 1 : -1;
  if (a instanceof Date || b instanceof Date) return sign * (new Date(a as Date).getTime() - new Date(b as Date).getTime());
  if (typeof a === "string" || typeof b === "string") return sign * String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
  return sign * (Number(a) - Number(b));
}
