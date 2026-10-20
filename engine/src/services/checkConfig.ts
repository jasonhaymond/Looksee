// Prepares a check's config just before it runs or is handed to an agent or
// site collector: adds what the check needs from the database but can't
// look up itself where it runs.
//
//   - exclusions: its own Exclude setting merged with the reusable
//     exclusion lists that apply (services/exclusions.ts);
//   - a referenced check's latest value: an SNMP check with a "Calculate"
//     expression that uses `ref` names another check (config.refCheckId);
//     that check's newest value goes in config.refValue
//     (probes/snmp.ts reads it).
//
// Where this sits: called by scheduler.ts (engine-run checks),
// routes/collector.ts (site collector checks) and routes/agent.ts (agent
// checks). The stored config is never changed — this returns a copy.

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks } from "../db/schema.js";
import { withExclusions } from "./exclusions.js";
import { isUuid } from "../lib/ids.js";

type CheckLike = Pick<typeof checks.$inferSelect, "id" | "type" | "config">;

/**
 * The config a check should run with.
 *
 * @param check the check
 * @param asText exclusions as one-per-line text (agents) instead of a list
 */
export async function prepareConfig(check: CheckLike, asText = false): Promise<Record<string, unknown>> {
  const config = await withExclusions(check, asText);
  const refId = typeof config.refCheckId === "string" ? config.refCheckId : "";
  // Only a well-formed ID (8-4-4-4-12 hex digits) is looked up.
  if (refId && isUuid(refId) && refId !== check.id) {
    const ref = await db.query.checks.findFirst({ where: eq(checks.id, refId), columns: { lastValue: true } });
    return { ...config, refValue: ref?.lastValue ?? null };
  }
  return config;
}
