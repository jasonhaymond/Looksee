import { describe, expect, it } from "vitest";
import { checkType, AGENTLESS_CHECK_TYPES, AGENT_CHECK_TYPES, REPORT_CHECK_TYPES } from "../src/db/schema.js";
import { CHECK_TYPE_META } from "../src/db/checkTypes.js";
import { PROBE_TYPES } from "../src/services/prober.js";

// Regression guard for a real 2.0 bug: snmp was added to the check_type enum
// but the scheduler kept its own hand-written type list, so snmp checks were
// created fine and then silently never ran. Every type now comes from one
// registry (db/checkTypes.ts); these tests lock in that each executor
// actually has an implementation behind it.
describe("check type registry", () => {
  it("the database enum is exactly the registry's types", () => {
    expect(new Set(checkType.enumValues)).toEqual(new Set(Object.keys(CHECK_TYPE_META)));
  });

  it("every engine-executed type has a probe, and nothing else does", () => {
    expect(new Set(AGENTLESS_CHECK_TYPES)).toEqual(new Set(PROBE_TYPES));
    expect(AGENTLESS_CHECK_TYPES).toContain("snmp");
  });

  it("every type has exactly one executor", () => {
    const all = [...AGENTLESS_CHECK_TYPES, ...AGENT_CHECK_TYPES, ...REPORT_CHECK_TYPES];
    expect(all.length).toBe(checkType.enumValues.length);
    expect(new Set(all).size).toBe(all.length);
  });
});
