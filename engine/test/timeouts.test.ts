// Tests for "timeouts warn first" (services/timeouts.ts): a check that gets
// no answer in time reports WARN, and only goes DOWN after its
// timeoutsBeforeDown run of timeouts in a row. The first block tests the
// pure rule; the second records real results through recordCheckResult
// against the real local test database, the same path the scheduler,
// agents and collectors use. Everything created here is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { desc, eq } from "drizzle-orm";
import { db } from "../src/db/index.js";
import { checkResults, checks, sites } from "../src/db/schema.js";
import { recordCheckResult } from "../src/services/alerting.js";
import { isTimeoutMessage, judgeTimeout, timeoutsBeforeDown } from "../src/services/timeouts.js";

const ping = { type: "ping", config: {} };
const down = (message: string) => ({ status: "down" as const, latencyMs: null, message });

describe("the timeout rule", () => {
  // Proves the wording of every probe's "no answer in time" is recognised,
  // and that other failures (refused, DNS, HTTP status) are not.
  it("recognises timeout messages and nothing else", () => {
    for (const m of ["Timed out connecting to 10.0.0.5:443", "Request timed out", "RequestTimedOutError: Request timed out", "No reply from nas", "No UDP reply from 10.0.0.1:161 within 2000ms", "No response", "read udp 10.0.0.2:5000: i/o timeout", "context deadline exceeded", "connect ETIMEDOUT 10.0.0.9:22"]) {
      expect(isTimeoutMessage(m), m).toBe(true);
    }
    for (const m of ["connect ECONNREFUSED 10.0.0.5:443", "HTTP 500", "getaddrinfo ENOTFOUND nas", "Certificate expires in 3 days", null]) {
      expect(isTimeoutMessage(m), String(m)).toBe(false);
    }
  });

  // Proves the default run is 3, the setting is honoured, and nonsense is
  // clamped so a typo can't make a dead device warn forever.
  it("reads and clamps the setting", () => {
    expect(timeoutsBeforeDown({})).toBe(3);
    expect(timeoutsBeforeDown({ timeoutsBeforeDown: "" })).toBe(3);
    expect(timeoutsBeforeDown({ timeoutsBeforeDown: 5 })).toBe(5);
    expect(timeoutsBeforeDown({ timeoutsBeforeDown: 0 })).toBe(1);
    expect(timeoutsBeforeDown({ timeoutsBeforeDown: 500 })).toBe(20);
    expect(timeoutsBeforeDown({ timeoutsBeforeDown: "abc" })).toBe(3);
  });

  // Proves the counting: warn, warn, then down at the third timeout; an
  // earlier non-timeout result ends the run.
  it("warns until the run is long enough", () => {
    const t = down("No reply from nas");
    expect(judgeTimeout(ping, t, []).status).toBe("warn");
    expect(judgeTimeout(ping, t, []).message).toBe("Timeout 1 of 3 before down — No reply from nas");
    const one = [{ status: "warn", message: "Timeout 1 of 3 before down — No reply from nas" }];
    expect(judgeTimeout(ping, t, one).status).toBe("warn");
    const two = [{ status: "warn", message: "Timeout 2 of 3 before down — No reply from nas" }, ...one];
    const third = judgeTimeout(ping, t, two);
    expect(third.status).toBe("down");
    expect(third.message).toBe("No response 3 times in a row — No reply from nas");
    // An "up" between timeouts restarts the count.
    expect(judgeTimeout(ping, t, [one[0], { status: "up", message: null }, ...one]).message).toMatch(/^Timeout 2 of 3/);
  });

  // Proves non-timeouts, exempt types and a setting of 1 keep the old
  // "down immediately" behaviour.
  it("leaves other failures, exempt types and timeoutsBeforeDown 1 alone", () => {
    expect(judgeTimeout(ping, down("connect ECONNREFUSED 10.0.0.5:22"), []).status).toBe("down");
    expect(judgeTimeout({ type: "agent_script", config: {} }, down("backup timed out"), []).status).toBe("down");
    expect(judgeTimeout({ type: "ping", config: { timeoutsBeforeDown: 1 } }, down("No reply from nas"), []).status).toBe("down");
    expect(judgeTimeout(ping, { status: "warn", latencyMs: null, message: "Timed out" }, []).message).toBe("Timed out");
  });
});

describe("timeouts through recordCheckResult", () => {
  let siteId: string;
  beforeAll(async () => {
    siteId = (await db.insert(sites).values({ name: `timeouts-${crypto.randomUUID()}` }).returning())[0].id;
  });
  afterAll(async () => {
    await db.delete(sites).where(eq(sites.id, siteId));
  });

  /** A disabled check (so a running local engine never schedules it mid-test). */
  const makeCheck = async (config: Record<string, unknown> = {}) => (await db.insert(checks).values({ siteId, name: "timeout test", type: "tcp", config: { host: "192.0.2.1", port: 22, ...config }, enabled: false }).returning())[0];
  const state = async (id: string) => (await db.query.checks.findFirst({ where: eq(checks.id, id) }))!;

  // Proves the stored status and history follow the rule for real results:
  // two WARNs then DOWN, and a refused connection is DOWN at once.
  it("stores warn, warn, down for three timeouts and down for a refusal", async () => {
    const c = await makeCheck();
    await recordCheckResult(c.id, down("Timed out connecting to 192.0.2.1:22"));
    expect((await state(c.id)).lastStatus).toBe("warn");
    await recordCheckResult(c.id, down("Timed out connecting to 192.0.2.1:22"));
    expect((await state(c.id)).lastStatus).toBe("warn");
    await recordCheckResult(c.id, down("Timed out connecting to 192.0.2.1:22"));
    const after = await state(c.id);
    expect(after.lastStatus).toBe("down");
    expect(after.lastMessage).toMatch(/^No response 3 times in a row/);
    const history = await db.select().from(checkResults).where(eq(checkResults.checkId, c.id)).orderBy(desc(checkResults.checkedAt));
    expect(history.map((r) => r.status)).toEqual(["down", "warn", "warn"]);

    const refused = await makeCheck();
    await recordCheckResult(refused.id, down("connect ECONNREFUSED 192.0.2.1:22"));
    expect((await state(refused.id)).lastStatus).toBe("down");
  });

  // Proves the per-check setting is read from the stored config.
  it("goes down at the first timeout when set to 1", async () => {
    const c = await makeCheck({ timeoutsBeforeDown: 1 });
    await recordCheckResult(c.id, down("Timed out connecting to 192.0.2.1:22"));
    expect((await state(c.id)).lastStatus).toBe("down");
  });
});
