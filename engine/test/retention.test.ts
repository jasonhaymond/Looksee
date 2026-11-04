// Tests for data retention and the free-space guard (services/retention.ts,
// routes/retention.ts).
//
// These delete old rows from real tables, so they run in their own throwaway
// database, created here and dropped afterwards, never the shared test database,
// which holds other test files' data and a developer's demo data. Everything is
// real Postgres, including VACUUM; only the disk measurement is faked, because a
// test can't fill a real disk.

import "dotenv/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Client } from "pg";
import request from "supertest";
import { sql } from "drizzle-orm";

const baseUrl = process.env.DATABASE_URL!;
const testDb = `looksee_retention_test_${process.pid}`;

// Must happen before anything imports db/index.ts, which connects to whatever
// DATABASE_URL says when it's first imported.
const admin = new Client({ connectionString: baseUrl });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${testDb}`);
await admin.query(`CREATE DATABASE ${testDb}`);
await admin.end();
const url = new URL(baseUrl);
url.pathname = `/${testDb}`;
process.env.DATABASE_URL = url.toString();

const { db, pool } = await import("../src/db/index.js");
const { migrate } = await import("drizzle-orm/node-postgres/migrator");
await migrate(db, { migrationsFolder: "./drizzle" });
const schema = await import("../src/db/schema.js");
const { app } = await import("../src/app.js");
const { loginWith2fa } = await import("./helpers.js");
const retention = await import("../src/services/retention.js");
const { enforceFreeSpace, pruneData, minFreeBytes, resetFreeSpaceState, getRetention, effectiveDays, DATA_KINDS } = retention;

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(Date.now() - d * DAY);
const GB = 1e9;
// A fake disk with this much free out of 100 GB.
const disk = (freeGb: number) => async () => ({ freeBytes: freeGb * GB, totalBytes: 100 * GB });

const logRows = (n: number, at: Date) => Array.from({ length: n }, (_, i) => ({ level: "info" as const, source: "test", message: `row ${i} ${"x".repeat(200)}`, createdAt: at }));
const flowRows = (n: number, at: Date) => Array.from({ length: n }, (_, i) => ({ exporter: "10.0.0.1", bucket: at, srcAddr: "10.0.0.2", dstAddr: `10.0.1.${i % 250}`, dstPort: i, protocol: 6, bytes: 1000, packets: 10 }));
const count = async (table: import("drizzle-orm/pg-core").PgTable) => Number((await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM ${table}`)).rows[0].n);
// Only this file's log rows: the engine writes its own log lines to the same table
// while these tests run (for example, to say it rolled data over).
const testLogs = async () => Number((await db.execute<{ n: string }>(sql`SELECT count(*) AS n FROM logs WHERE source = 'test'`)).rows[0].n);

let cookie: string;

beforeAll(async () => {
  await db.insert(schema.users).values({ email: "retention@example.com", passwordHash: await bcrypt.hash("TestPass123", 10) });
  cookie = await loginWith2fa("retention@example.com", "TestPass123");
});

beforeEach(async () => {
  resetFreeSpaceState();
  await db.delete(schema.logs);
  await db.delete(schema.flowRecords);
  await db.delete(schema.securityEvents);
  await db.delete(schema.retentionSettings);
});

afterAll(async () => {
  await pool.end();
  const cleanup = new Client({ connectionString: baseUrl });
  await cleanup.connect();
  await cleanup.query(`DROP DATABASE IF EXISTS ${testDb} WITH (FORCE)`);
  await cleanup.end();
});

describe("free-space limit", () => {
  // The default is the 3 GB asked for, and the limit can instead be a percentage.
  it("defaults to 3 GB free and can be a percentage of the disk", async () => {
    const s = await getRetention();
    expect(s.minFreeGb).toBe(3);
    expect(minFreeBytes(s, 100 * GB)).toBe(3 * GB);
    expect(minFreeBytes({ ...s, minFreeMode: "percent", minFreePercent: 10 }, 500 * GB)).toBe(50 * GB);
  });
});

describe("enforceFreeSpace", () => {
  // With room to spare nothing is touched, even data far past its retention period
  // (that's the nightly job's business).
  it("deletes nothing while there's enough free space", async () => {
    await db.insert(schema.logs).values(logRows(50, daysAgo(900)));
    const out = await enforceFreeSpace(disk(50));
    expect(out.action).toBe("ok");
    expect(await testLogs()).toBe(50);
  });

  // The core promise: data still inside its retention period is rolled over anyway
  // when the disk runs low.
  it("rolls over data that's within its retention period when the disk is low", async () => {
    await db.insert(schema.logs).values(logRows(100, daysAgo(5)));
    expect(effectiveDays(DATA_KINDS.find((k) => k.key === "logs")!, await getRetention())).toBeGreaterThan(5);
    const out = await enforceFreeSpace(disk(1));
    expect(out.action).toBe("rolled_over");
    expect(await testLogs()).toBe(0);
    expect((await getRetention()).lastRolloverMessage).toMatch(/rolled over/);
  });

  // Attack on the data itself: however low the disk, recent history survives, so a
  // disk filled by something else can't wipe everything Looksee knows.
  it("never rolls over data newer than the keep window, and says it's stuck", async () => {
    await db.insert(schema.logs).values(logRows(20, daysAgo(0.5)));
    const out = await enforceFreeSpace(disk(1));
    expect(out.action).toBe("at_limit");
    expect(out.message).toMatch(/Something else may be filling/);
    expect(await testLogs()).toBe(20);
  });

  // Attack: fill the disk to make Looksee erase the audit trail of a break-in.
  it("never rolls over the security audit log", async () => {
    await db.insert(schema.securityEvents).values({ kind: "login_failed", createdAt: daysAgo(100) });
    await enforceFreeSpace(disk(1));
    expect(await count(schema.securityEvents)).toBe(1);
  });

  // The most disposable data goes first: a small shortfall, covered by flows, leaves
  // logs alone. The shortfall is sized from the real flow table.
  it("rolls over the most disposable data first", async () => {
    await db.insert(schema.flowRecords).values(flowRows(2000, daysAgo(3)));
    await db.insert(schema.logs).values(logRows(50, daysAgo(10)));
    const flowBytes = async () => Number((await db.execute<{ size: string }>(sql`SELECT pg_total_relation_size('flow_records') AS size`)).rows[0].size);
    const size = await flowBytes();
    // The fake disk gains whatever the real table gives back when it's compacted.
    const out = await enforceFreeSpace(async () => ({ freeBytes: 3 * GB - size / 4 + (size - (await flowBytes())), totalBytes: 100 * GB }));
    expect(out.deleted.map((d) => d.key)).toEqual(["flows"]);
    expect(await testLogs()).toBe(50);
    const left = await count(schema.flowRecords);
    expect(left).toBeGreaterThan(0);
    expect(left).toBeLessThan(2000);
  });

  // The trap this design exists for: DELETE doesn't return space to the disk, so the
  // measured free space doesn't rise. Without counting the reusable room, every pass
  // would delete more until nothing was left. Here the copy VACUUM FULL needs can't
  // fit (only 0.1 GB free), so the table stays large and the disk reads the same.
  it("doesn't keep deleting for space it has already freed inside the database", async () => {
    await db.insert(schema.flowRecords).values(flowRows(2000, daysAgo(3)));
    const { rows } = await db.execute<{ size: string }>(sql`SELECT pg_total_relation_size('flow_records') AS size`);
    const size = Number(rows[0].size);
    const low = async () => ({ freeBytes: 0.1 * GB, totalBytes: 100 * GB });
    await getRetention();
    await db.update(schema.retentionSettings).set({ minFreeGb: (0.1 * GB + size / 2) / GB });

    const first = await enforceFreeSpace(low);
    expect(first.action).toBe("rolled_over");
    const afterFirst = await count(schema.flowRecords);
    expect(afterFirst).toBeLessThan(2000);
    expect(retention.reusableEstimate()).toBeGreaterThan(0);

    const second = await enforceFreeSpace(low);
    expect(second.action).toBe("ok");
    expect(await count(schema.flowRecords)).toBe(afterFirst);
  });

  // When there is room for the copy, VACUUM FULL runs and really shrinks the table,
  // on real Postgres.
  it("gives the space back to the disk when there's room to compact", async () => {
    await db.insert(schema.flowRecords).values(flowRows(3000, daysAgo(3)));
    const size = async () => Number((await db.execute<{ size: string }>(sql`SELECT pg_total_relation_size('flow_records') AS size`)).rows[0].size);
    const before = await size();
    await enforceFreeSpace(disk(2.9));
    expect(await count(schema.flowRecords)).toBe(0);
    expect(await size()).toBeLessThan(before);
    expect(retention.reusableEstimate()).toBe(0);
  });

  // Turning it off is a real off switch.
  it("does nothing when turned off", async () => {
    await db.insert(schema.logs).values(logRows(10, daysAgo(10)));
    await getRetention();
    await db.update(schema.retentionSettings).set({ rolloverEnabled: false });
    expect((await enforceFreeSpace(disk(0.1))).action).toBe("disabled");
    expect(await testLogs()).toBe(10);
  });

  // A disk that can't be read must be reported, not treated as "fine" or "full".
  it("reports an unreadable disk and deletes nothing", async () => {
    await db.insert(schema.logs).values(logRows(10, daysAgo(10)));
    const out = await enforceFreeSpace(async () => {
      throw new Error("no such folder");
    });
    expect(out.action).toBe("disk_unreadable");
    expect(await testLogs()).toBe(10);
  });
});

describe("pruneData", () => {
  // A period set on the page wins over the defaults, for each kind separately.
  it("applies each kind's retention period from the settings", async () => {
    await getRetention();
    await db.update(schema.retentionSettings).set({ days: { logs: 10 } });
    await db.insert(schema.logs).values([...logRows(3, daysAgo(11)), ...logRows(2, daysAgo(9))]);
    await db.insert(schema.flowRecords).values([...flowRows(4, daysAgo(8)), ...flowRows(1, daysAgo(6))]);
    await pruneData();
    expect(await testLogs()).toBe(2);
    expect(await count(schema.flowRecords)).toBe(1);
  });

  // Existing installs keep what their .env says until the page changes it.
  it("falls back to the environment setting, then the default", async () => {
    const kind = DATA_KINDS.find((k) => k.key === "flows")!;
    const s = await getRetention();
    process.env.FLOW_RETENTION_DAYS = "3";
    expect(effectiveDays(kind, s)).toBe(3);
    delete process.env.FLOW_RETENTION_DAYS;
    expect(effectiveDays(kind, s)).toBe(7);
    expect(effectiveDays(kind, { ...s, days: { flows: 21 } })).toBe(21);
  });
});

describe("the API", () => {
  // Attack: deleting monitoring history or weakening the limits without signing in.
  it("requires a session on every route", async () => {
    expect((await request(app).get("/api/retention")).status).toBe(401);
    expect((await request(app).patch("/api/retention").send({ minFreeGb: 5 })).status).toBe(401);
    expect((await request(app).post("/api/retention/run")).status).toBe(401);
  });

  // The page's whole round trip, with the change written to the audit log.
  it("saves settings and reports the disk and each kind of data", async () => {
    const res = await request(app).patch("/api/retention").set("Cookie", cookie).send({ minFreeMode: "percent", minFreePercent: 15, minKeepHours: 48, days: { logs: 14 } });
    expect(res.status).toBe(200);
    expect(res.body.minFreeMode).toBe("percent");
    expect(res.body.minKeepHours).toBe(48);
    expect(res.body.kinds.find((k: { key: string }) => k.key === "logs").days).toBe(14);
    expect(res.body.disk.totalBytes).toBeGreaterThan(0);
    expect(res.body.limitBytes).toBeCloseTo(res.body.disk.totalBytes * 0.15, -3);
    expect(await count(schema.securityEvents)).toBeGreaterThan(0);
  });

  // Values that would delete everything at once, or disable the guard by mistake.
  it("refuses out-of-range values without saving anything", async () => {
    for (const body of [{ minFreeGb: 0 }, { minFreeGb: "lots" }, { minFreePercent: 95 }, { minFreeMode: "bytes" }, { minKeepHours: 0 }, { days: { logs: 0 } }, { days: { logs: 1.5 } }, { storagePath: "relative/folder" }, { storagePath: "/no/such/folder/anywhere" }]) {
      const res = await request(app).patch("/api/retention").set("Cookie", cookie).send(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect((await getRetention()).minFreeGb).toBe(3);
  });

  // Attack: a stolen session uses this page to wipe recent audit history, setting a
  // short period and pressing Apply now. Other kinds of data may still go down to 1 day.
  it("refuses an audit log period under 30 days", async () => {
    const low = await request(app).patch("/api/retention").set("Cookie", cookie).send({ days: { securityEvents: 29 } });
    expect(low.status).toBe(400);
    expect(low.body.error).toMatch(/at least 30/);
    expect((await getRetention()).days).toEqual({});
    expect((await request(app).patch("/api/retention").set("Cookie", cookie).send({ days: { securityEvents: 30 } })).status).toBe(200);
    expect((await request(app).patch("/api/retention").set("Cookie", cookie).send({ days: { logs: 1 } })).status).toBe(200);
  });

  // Even a value already stored below the minimum can't delete recent audit history.
  it("keeps 30 days of audit history whatever is stored", async () => {
    await getRetention();
    await db.update(schema.retentionSettings).set({ days: { securityEvents: 1 } });
    await db.insert(schema.securityEvents).values([{ kind: "login_failed", createdAt: daysAgo(20) }, { kind: "login_failed", createdAt: daysAgo(40) }]);
    await pruneData();
    expect(await count(schema.securityEvents)).toBe(1);
  });

  // Attack: unknown keys in the settings object, including __proto__ from a crafted
  // JSON body, must not end up stored or change anything.
  it("stores only known kinds of data", async () => {
    const res = await request(app).patch("/api/retention").set("Cookie", cookie).set("Content-Type", "application/json").send('{"days":{"__proto__":{"logs":1},"nonsense":5,"logs":20}}');
    expect(res.status).toBe(200);
    expect((await getRetention()).days).toEqual({ logs: 20 });
    expect(({} as Record<string, unknown>).logs).toBeUndefined();
  });

  // Clearing a period goes back to the default rather than storing a blank.
  it("clears a period with null", async () => {
    await request(app).patch("/api/retention").set("Cookie", cookie).send({ days: { logs: 20 } });
    await request(app).patch("/api/retention").set("Cookie", cookie).send({ days: { logs: null } });
    expect((await getRetention()).days).toEqual({});
  });

  // "Run now" applies retention right away.
  it("runs the cleanup on request", async () => {
    await getRetention();
    await db.update(schema.retentionSettings).set({ days: { logs: 5 } });
    await db.insert(schema.logs).values(logRows(3, daysAgo(6)));
    const res = await request(app).post("/api/retention/run").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.outcome.action).toBeDefined();
    expect(await testLogs()).toBe(0);
  });
});
