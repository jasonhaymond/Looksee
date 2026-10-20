// "Calculated value" checks: a value worked out from other checks' latest
// values — e.g. a UPS's load in watts from its load % and rated capacity, a
// link's utilisation from two SNMP counters, free space across two disks, or
// the difference between two sensors.
//
// Where this sits: an engine-run check type ("calculated", see
// db/checkTypes.ts), run by the scheduler like any other check
// (probes/index.ts). It reads the latest value of up to four other checks
// (variables a, b, c and d) from the checks table and works out the
// expression with probes/expression.ts (a calculator, never code). Its
// value then gets the usual warn/critical thresholds.

import { inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks } from "../db/schema.js";
import { evaluateExpression, expressionNames } from "./probes/expression.js";
import type { ProbeContext, ProbeOutcome } from "./probes/types.js";
import { own, setOwn } from "../lib/own.js";
import { isUuid } from "../lib/ids.js";

/** The variables a calculated check can use, and the setting naming each check. */
export const CALC_VARIABLES = { a: "varA", b: "varB", c: "varC", d: "varD" } as const;


/**
 * Runs a calculated check.
 *
 * @param config expression, varA–varD (check IDs), unit, maxAgeMinutes
 *   (default 15: an input older than this makes the result unknown)
 * @param ctx the check itself (it can't use its own value)
 */
export async function probeCalculated(config: Record<string, unknown>, ctx: ProbeContext): Promise<ProbeOutcome> {
  const expression = String(config.expression ?? "").trim();
  if (!expression) return { status: "warn", latencyMs: null, message: "No expression set" };
  const used = expressionNames(expression);
  // Which variables point at which checks (only the ones the expression uses).
  const wanted = Object.entries(CALC_VARIABLES)
    .filter(([name]) => used.includes(name))
    .map(([name, key]) => ({ name, id: String(own(config, key) ?? "") }));
  const ids = wanted.map((w) => w.id);
  const missing = wanted.filter((w) => !isUuid(w.id) || w.id === ctx.checkId).map((w) => w.name);
  if (missing.length) return { status: "warn", latencyMs: null, message: `Choose a check for ${missing.join(", ")}` };
  const rows = ids.length ? await db.select({ id: checks.id, name: checks.name, value: checks.lastValue, at: checks.lastCheckedAt }).from(checks).where(inArray(checks.id, ids)) : [];
  const maxAge = Number(config.maxAgeMinutes ?? 15) * 60_000;
  const vars: Record<string, number> = {};
  for (const { name, id } of wanted) {
    const row = rows.find((r) => r.id === id);
    if (!row) return { status: "warn", latencyMs: null, message: `The check for ${name} no longer exists` };
    if (row.value == null) return { status: "unknown", latencyMs: null, message: `"${row.name}" (${name}) has no value yet` };
    if (!row.at || Date.now() - row.at.getTime() > maxAge) return { status: "unknown", latencyMs: null, message: `"${row.name}" (${name}) hasn't reported in ${Math.round(maxAge / 60_000)} min` };
    setOwn(vars, name, row.value);
  }
  try {
    const value = evaluateExpression(expression, vars);
    const unit = String(config.unit ?? "");
    const inputs = Object.entries(vars)
      .map(([k, v]) => `${k}=${Math.round(v * 100) / 100}`)
      .join(", ");
    return { status: "up", latencyMs: null, message: `${Math.round(value * 100) / 100}${unit}${inputs ? ` (${inputs})` : ""}`, value };
  } catch (err) {
    return { status: "warn", latencyMs: null, message: `Calculation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}
