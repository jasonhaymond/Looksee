import { describe, expect, it } from "vitest";
import { CHECK_TYPE_META } from "../src/db/checkTypes.js";
import { CHECK_TYPES as DASHBOARD_TYPES } from "../../dashboard/app/lib/checkTypes.js";

// The dashboard describes how to configure each type; the engine decides
// who runs it. A type in one list but not the other is either uncreatable
// from the UI or creatable but never run.
describe("dashboard and engine check-type registries", () => {
  it("list exactly the same types", () => {
    expect(new Set(DASHBOARD_TYPES.map((t) => t.type))).toEqual(new Set(Object.keys(CHECK_TYPE_META)));
  });

  it("agree on which types need a host and which can run on an agent", () => {
    for (const def of DASHBOARD_TYPES) {
      const meta = CHECK_TYPE_META[def.type as keyof typeof CHECK_TYPE_META] as { hostRequired?: boolean; remoteProbe?: boolean };
      expect(Boolean(def.needsHost), `${def.type} needsHost`).toBe(Boolean(meta.hostRequired));
      expect(Boolean(def.remoteProbe), `${def.type} remoteProbe`).toBe(Boolean(meta.remoteProbe));
    }
  });
});
