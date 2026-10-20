// Tests for time-zone handling: the lib/timeZone.ts helpers, weekly
// maintenance windows that run on the saving browser's wall clock, the
// maintenance API's zone validation, and status-page day bars bucketed in the
// visitor's zone. Runs against the real local test database (see README →
// Local development); each test cleans up the rows it creates.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { and, eq, gte } from "drizzle-orm";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { users, sites, checks, checkResults, maintenanceWindows, statusPages, logs } from "../src/db/schema.js";
import { isValidTimeZone, localMidnight, recentDates, wallClock } from "../src/lib/timeZone.js";
import { windowIsActive } from "../src/services/maintenance.js";

const email = `test-tz-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
let siteId: string;

// One signed-in admin and one endpoint shared by the API tests below.
beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash(password, 10) });
  cookie = await loginWith2fa(email, password);
  siteId = (await db.insert(sites).values({ name: `tz-${crypto.randomUUID()}` }).returning())[0].id;
});

// Deleting the endpoint cascades to its checks and their results.
afterAll(async () => {
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

describe("time zone helpers", () => {
  // Zone names reach SQL and the maintenance logic, so anything that isn't a
  // real zone — including an injection attempt — must be refused.
  it("accepts real IANA zones and rejects everything else", () => {
    expect(isValidTimeZone("America/Los_Angeles")).toBe(true);
    expect(isValidTimeZone("UTC")).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("UTC'; DROP TABLE checks; --")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
    expect(isValidTimeZone(42)).toBe(false);
    expect(isValidTimeZone("A".repeat(100))).toBe(false);
  });

  // The same instant reads as a different day and time in different zones.
  it("reads the wall clock of a zone", () => {
    const at = new Date("2026-10-11T06:30:00Z");
    expect(wallClock(at, "UTC")).toEqual({ date: "2026-10-11", weekday: 0, minuteOfDay: 6 * 60 + 30 });
    // Los Angeles is UTC-7 in October: still Saturday evening there.
    expect(wallClock(at, "America/Los_Angeles")).toEqual({ date: "2026-10-10", weekday: 6, minuteOfDay: 23 * 60 + 30 });
  });

  // Across the March clock change (a 23-hour day in the US) every calendar
  // date appears exactly once — no skipped or doubled day bar.
  it("lists consecutive dates across a daylight-saving change", () => {
    const dates = recentDates(5, "America/New_York", new Date("2026-03-10T03:30:00Z"));
    expect(dates).toEqual(["2026-03-05", "2026-03-06", "2026-03-07", "2026-03-08", "2026-03-09"]);
  });
});

describe("local midnight", () => {
  // Each zone's midnight as an absolute instant, including half- and
  // quarter-hour offsets and legacy names browsers still send.
  it("finds the instant a date starts in a zone", () => {
    expect(localMidnight("2026-10-13", "UTC").toISOString()).toBe("2026-10-13T00:00:00.000Z");
    expect(localMidnight("2026-10-13", "America/Los_Angeles").toISOString()).toBe("2026-10-13T07:00:00.000Z");
    expect(localMidnight("2026-10-13", "Asia/Calcutta").toISOString()).toBe("2026-10-12T18:30:00.000Z");
    expect(localMidnight("2026-10-13", "Asia/Kathmandu").toISOString()).toBe("2026-10-12T18:15:00.000Z");
  });

  // On a daylight-saving change day the offset before and after midnight
  // differs; both sides of the change must be right.
  it("handles days on either side of a clock change", () => {
    // US clocks spring forward at 02:00 on 8 Mar 2026: midnight that day is
    // still UTC-5 in New York, the next day's midnight is UTC-4.
    expect(localMidnight("2026-03-08", "America/New_York").toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(localMidnight("2026-03-09", "America/New_York").toISOString()).toBe("2026-03-09T04:00:00.000Z");
  });
});

describe("weekly maintenance windows in a time zone", () => {
  const base = { startsAt: null, endsAt: null, enabled: true };
  // "Sunday 02:00 for an hour", saved from a browser in Los Angeles.
  const sunday2am = { ...base, daysOfWeek: [0], startTime: "02:00", durationMinutes: 60 };

  it("runs at the saving browser's local time, whatever the server's zone", () => {
    // 09:30 UTC on Sunday 11 Oct 2026 = 02:30 in Los Angeles (UTC-7).
    const at = new Date("2026-10-11T09:30:00Z");
    expect(windowIsActive({ ...sunday2am, timeZone: "America/Los_Angeles" }, at)).toBe(true);
    // The same instant is 11:30 in Berlin, so a Berlin window isn't running.
    expect(windowIsActive({ ...sunday2am, timeZone: "Europe/Berlin" }, at)).toBe(false);
    // And 08:59 UTC (01:59 in LA) is just before it starts.
    expect(windowIsActive({ ...sunday2am, timeZone: "America/Los_Angeles" }, new Date("2026-10-11T08:59:00Z"))).toBe(false);
  });

  // A window that starts late Saturday and runs past midnight is still
  // active early Sunday in its own zone.
  it("spans midnight in its own zone", () => {
    const sat11pm = { ...base, daysOfWeek: [6], startTime: "23:00", durationMinutes: 120, timeZone: "Asia/Tokyo" };
    // 15:30 UTC Saturday = 00:30 Sunday in Tokyo (UTC+9).
    expect(windowIsActive(sat11pm, new Date("2026-10-10T15:30:00Z"))).toBe(true);
    // 17:00 UTC = 02:00 Sunday in Tokyo: the two hours are over.
    expect(windowIsActive(sat11pm, new Date("2026-10-10T17:00:00Z"))).toBe(false);
  });

  // A stored zone that's no longer valid must not throw (which would break
  // every check result) — it falls back to the server's zone.
  it("falls back to the server's zone for an unknown stored zone", () => {
    expect(() => windowIsActive({ ...sunday2am, timeZone: "Not/AZone" }, new Date())).not.toThrow();
  });
});

describe("maintenance API time zones", () => {
  it("stores the zone sent with a weekly window", async () => {
    const res = await request(app).post("/api/maintenance").set("Cookie", cookie).send({ name: "tz window", scope: "site", targetIds: [siteId], daysOfWeek: [0], startTime: "02:00", durationMinutes: 60, timeZone: "America/Chicago" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.timeZone).toBe("America/Chicago");
    await db.delete(maintenanceWindows).where(eq(maintenanceWindows.id, res.body.id));
  });

  // A bogus zone is rejected with a 400 rather than saved, so a window can't
  // be silently shifted or made to crash the maintenance check.
  it("refuses an unknown zone", async () => {
    const res = await request(app).post("/api/maintenance").set("Cookie", cookie).send({ name: "bad tz", daysOfWeek: [0], startTime: "02:00", durationMinutes: 60, timeZone: "Nowhere/Land" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/time zone/i);
  });

  // Maintenance windows pause alerting, so creating one needs a session.
  it("requires a session", async () => {
    const res = await request(app).post("/api/maintenance").send({ name: "anon", daysOfWeek: [0], startTime: "02:00", durationMinutes: 60, timeZone: "UTC" });
    expect(res.status).toBe(401);
  });
});

describe("status page day bars in the visitor's zone", () => {
  it("buckets results by the visitor's calendar day and ignores bad zones", async () => {
    const check = (await db.insert(checks).values({ siteId, name: "tz status", type: "heartbeat", config: {} }).returning())[0];
    // A result just before the last UTC midnight: "yesterday" in UTC, but
    // already "today" in Tokyo (UTC+9).
    const utcMidnight = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
    const at = new Date(utcMidnight.getTime() - 60 * 60_000);
    await db.insert(checkResults).values({ checkId: check.id, status: "up", checkedAt: at });
    const slug = `tz-${crypto.randomUUID().slice(0, 8)}`;
    const page = (await db.insert(statusPages).values({ slug, title: "TZ", checkIds: [check.id] }).returning())[0];
    try {
      // Returns the day key that has data on the page as seen from `tz`.
      const dayWithData = async (tz: string) => {
        const res = await request(app).get(`/api/public/status/${slug}?tz=${encodeURIComponent(tz)}`);
        expect(res.status).toBe(200);
        return { zone: res.body.timeZone as string, days: (res.body.checks[0].days as { day: string; uptime: number | null }[]).filter((d) => d.uptime != null).map((d) => d.day) };
      };
      expect(await dayWithData("UTC")).toEqual({ zone: "UTC", days: [wallClock(at, "UTC").date] });
      expect(await dayWithData("Asia/Tokyo")).toEqual({ zone: "Asia/Tokyo", days: [wallClock(at, "Asia/Tokyo").date] });
      // Legacy and fractional-offset zones work too (Postgres doesn't know
      // "Asia/Calcutta", but the engine no longer asks it), and an anonymous
      // visitor's request writes nothing to the log.
      const before = new Date();
      expect(await dayWithData("Asia/Calcutta")).toEqual({ zone: "Asia/Calcutta", days: [wallClock(at, "Asia/Calcutta").date] });
      expect(await dayWithData("Asia/Kathmandu")).toEqual({ zone: "Asia/Kathmandu", days: [wallClock(at, "Asia/Kathmandu").date] });
      const logged = await db.select().from(logs).where(and(eq(logs.source, "status-page"), gte(logs.createdAt, before)));
      expect(logged).toHaveLength(0);
      // An injection attempt in ?tz= is never used: the page answers in UTC.
      expect((await dayWithData("UTC'; DROP TABLE checks; --")).zone).toBe("UTC");
    } finally {
      await db.delete(statusPages).where(eq(statusPages.id, page.id));
    }
  });
});
