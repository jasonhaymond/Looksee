// Makes the memory section of an agent's report safe to display on the endpoint page.
// Reports are stored as the agent sent them, so a faulty or hostile agent could send
// text where a number belongs, which would crash the page while formatting it. Kept
// apart from the page so the engine's test runner can check it
// (engine/test/memory-detail.test.ts).

const NUMBER_FIELDS = new Set(["swapUsed", "commitUsed", "commitLimit", "kernelNonpaged", "kernelPaged", "processPrivate", "nonProcess", "pagesInPerSec", "pagesOutPerSec", "privateUnread"]);

/** True for a real number: not text, not missing, and not NaN or infinity. */
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * Removes anything unusable from a report's memory section. The page already leaves
 * out figures that are missing, so a bad one simply doesn't show.
 * @param mem the memory section as the agent reported it
 * @returns a copy with bad figures removed and only well-formed entries in topPrivate
 */
export function cleanMemory<T extends object>(mem: T): T {
  // Keeps every field except a number field that doesn't hold a number.
  const kept = Object.entries(mem).filter(([key, value]) => !NUMBER_FIELDS.has(key) || isNumber(value));
  const top = (mem as { topPrivate?: unknown }).topPrivate;
  const topPrivate = Array.isArray(top) ? top.filter((p) => p && typeof p.name === "string" && isNumber(p.bytes)) : [];
  return { ...Object.fromEntries(kept), topPrivate } as T;
}
