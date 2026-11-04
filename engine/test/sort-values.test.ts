// The dashboard's sorting rules (dashboard/app/lib/sortValues.ts): the order every
// sortable list in the app uses, tested here because the engine holds the project's
// test runner, as check-types.test.ts does for the check registry.

import { describe, expect, it } from "vitest";
import { compareSortValues, type SortDir, type SortValue } from "../../dashboard/app/lib/sortValues.js";

const sorted = <T extends SortValue>(values: T[], dir: SortDir = "asc") => [...values].sort((a, b) => compareSortValues(a, b, dir));

describe("compareSortValues", () => {
  // A plain letter-by-letter sort puts server10 before server2, which reads as wrong.
  it("sorts numbers inside text by their value", () => {
    expect(sorted(["server10", "server2", "Server1"])).toEqual(["Server1", "server2", "server10"]);
  });

  // IP addresses are the most common text sorted in this app.
  it("sorts IP addresses in address order", () => {
    expect(sorted(["10.0.0.10", "10.0.0.2", "10.0.1.1"])).toEqual(["10.0.0.2", "10.0.0.10", "10.0.1.1"]);
  });

  // Numbers compare as numbers; descending really reverses them.
  it("sorts numbers both ways", () => {
    expect(sorted([10, 2, 33])).toEqual([2, 10, 33]);
    expect(sorted([10, 2, 33], "desc")).toEqual([33, 10, 2]);
  });

  // Blank values stay at the bottom whichever way the column is sorted, so a column
  // of "—" never crowds out the rows that have a value.
  it("always puts blanks last", () => {
    expect(sorted([null, 2, 1, NaN])).toEqual([1, 2, null, NaN]);
    expect(compareSortValues(undefined, 1)).toBeGreaterThan(0);
    expect(compareSortValues(1, undefined, "desc")).toBeLessThan(0);
    expect(sorted(["", "b", null, "a"], "desc")).toEqual(["b", "a", "", null]);
  });

  // Dates compare by time, not by how they print.
  it("sorts dates by time", () => {
    const a = new Date("2026-01-02");
    const b = new Date("2026-11-30");
    expect(sorted([b, a])).toEqual([a, b]);
    expect(sorted([a, b], "desc")).toEqual([b, a]);
  });

  // false before true, used for "enabled first" style columns.
  it("sorts true and false", () => {
    expect(sorted([true, false])).toEqual([false, true]);
  });
});
