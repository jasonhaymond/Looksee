import { describe, expect, it } from "vitest";
import { checkType, AGENTLESS_CHECK_TYPES, HOST_SCOPED_CHECK_TYPES } from "../src/db/schema.js";

// Regression test for a real bug caught during 2.0 testing: adding "snmp" to
// checkType (and prober.ts) wasn't enough on its own — services/scheduler.ts
// kept its own hand-written copy of "which types are agentless" and nobody
// remembered to add snmp there too, so snmp checks got created fine but the
// scheduler silently never ran them. AGENTLESS_CHECK_TYPES is now derived
// from checkType's own value list specifically so this can't happen again —
// this test locks that derivation in.
describe("AGENTLESS_CHECK_TYPES", () => {
  it("includes snmp", () => {
    expect(AGENTLESS_CHECK_TYPES).toContain("snmp");
  });

  it("is exactly every checkType value that isn't host-scoped", () => {
    const expected = checkType.enumValues.filter((t) => !(HOST_SCOPED_CHECK_TYPES as readonly string[]).includes(t));
    expect(new Set(AGENTLESS_CHECK_TYPES)).toEqual(new Set(expected));
  });

  it("doesn't include any host-scoped type", () => {
    for (const type of HOST_SCOPED_CHECK_TYPES) {
      expect(AGENTLESS_CHECK_TYPES).not.toContain(type);
    }
  });
});
