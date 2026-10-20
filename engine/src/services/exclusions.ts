// Works out which items each check ignores: its own `exclude` setting plus
// every enabled reusable exclusion list (table `exclusion_lists`) that applies
// to it.
//
// Where this sits: called just before a check runs or is handed out —
// scheduler.ts (engine-run checks), routes/agent.ts (agent checks, and the
// agent-reported host_metric checks), routes/collector.ts (site collector
// checks) — and by GET /api/checks/:id/exclusions, which shows the dashboard
// where each item came from. The matching rules themselves live in
// probes/exclude.ts.
//
// A list applies to a check when the list is enabled, its kind is one the
// check type uses, and it's set to apply to all checks or the check is
// covered by one of its groups. Lists and group membership are cached for
// 15 seconds (like maintenance windows), so a check run doesn't cost extra
// database queries; saving a list clears the cache.

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, exclusionLists } from "../db/schema.js";
import { checkIdsForGroups } from "./groups.js";
import { EXCLUSION_KINDS, excludeItems, kindsForType } from "./probes/exclude.js";
import { METRIC_BY_KEY } from "./endpointMetrics.js";
import { own } from "../lib/own.js";

type ListRow = typeof exclusionLists.$inferSelect;
type CheckLike = Pick<typeof checks.$inferSelect, "id" | "type" | "config">;

/** One excluded item and where it came from (for the dashboard). */
export type ExclusionItem = { value: string; kind: string; source: { type: "check" } | { type: "list"; id: string; name: string } };

const CACHE_MS = 15_000;
let cache: { at: number; lists: ListRow[]; groupChecks: Map<string, Set<string>> } | null = null;

/** Drops the cached lists so the next check sees a change immediately. */
export function invalidateExclusionCache() {
  cache = null;
}

/** The enabled lists and, for those limited to groups, each group's checks. */
async function enabledLists() {
  if (!cache || Date.now() - cache.at > CACHE_MS) {
    const lists = await db.query.exclusionLists.findMany({ where: eq(exclusionLists.enabled, true) });
    const groupIds = [...new Set(lists.filter((l) => !l.applyToAll).flatMap((l) => l.groupIds))];
    cache = { at: Date.now(), lists, groupChecks: await checkIdsForGroups(groupIds) };
  }
  return cache;
}

/**
 * The exclusion kinds a check uses — for host_metric, depending on its
 * chosen metric (a disk metric uses mounts, a network one interfaces).
 */
function kindsOf(check: CheckLike): string[] {
  const config = (check.config as Record<string, unknown>) ?? {};
  const instanceKind = check.type === "host_metric" ? METRIC_BY_KEY.get(String(config.metric ?? ""))?.instance : undefined;
  return kindsForType(check.type, instanceKind);
}

/**
 * Every item a check ignores, with its source: the check's own setting
 * first, then each applicable list. Duplicates (same text, ignoring case)
 * are listed once, under their first source.
 *
 * @param check the check (its id, type and config are needed)
 */
export async function exclusionsFor(check: CheckLike): Promise<ExclusionItem[]> {
  const kinds = kindsOf(check);
  if (!kinds.length) return [];
  const config = (check.config as Record<string, unknown>) ?? {};
  // The check's own items count as the check's first kind; for the types
  // with two kinds (event logs: texts and IDs) the agent tells them apart
  // by shape (all digits = an event ID).
  const ownKind = kinds[0];
  const out: ExclusionItem[] = excludeItems(config.exclude, own(EXCLUSION_KINDS, ownKind)?.match === "name").map((value) => ({ value, kind: ownKind, source: { type: "check" } }));
  const { lists, groupChecks } = await enabledLists();
  for (const list of lists) {
    if (!kinds.includes(list.kind)) continue;
    const covered = list.applyToAll || list.groupIds.some((g) => groupChecks.get(g)?.has(check.id));
    if (!covered) continue;
    for (const value of list.items) out.push({ value, kind: list.kind, source: { type: "list", id: list.id, name: list.name } });
  }
  // Remove repeats, keeping the first source.
  const seen = new Set<string>();
  return out.filter((i) => {
    const key = i.value.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * The check's config with `exclude` replaced by every item it should ignore.
 * Nothing changes for check types without exclusions.
 *
 * @param check the check about to run or be handed out
 * @param asText true to send the items as one-per-line text (for agents and
 *   site collectors — older agents read `exclude` as text); false gives a list
 */
export async function withExclusions(check: CheckLike, asText = false): Promise<Record<string, unknown>> {
  const config = (check.config as Record<string, unknown>) ?? {};
  if (!kindsOf(check).length) return config;
  const items = (await exclusionsFor(check)).map((i) => i.value);
  if (!items.length) return config;
  return { ...config, exclude: asText ? items.join("\n") : items };
}
