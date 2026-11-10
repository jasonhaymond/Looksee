// Tests for the 5.6 maintenance features: repeat types beyond weekly (daily,
// monthly on a day, monthly on a weekday), "every N", date ranges and UTC
// windows (services/maintenance.ts), and editing a window through
// PATCH /api/maintenance/:id (routes/maintenance.ts). The schedule tests are
// pure calculations at fixed instants; the API tests run against the real
// local test database through the real HTTP routes, the same way the
// dashboard does. Everything created is removed in afterAll.

import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { eq, inArray } from "drizzle-orm";
import request from "supertest";
import { app } from "../src/app.js";
import { loginWith2fa } from "./helpers.js";
import { db } from "../src/db/index.js";
import { maintenanceWindows, sites, users } from "../src/db/schema.js";
import { nextStart, occursOn, windowIsActive } from "../src/services/maintenance.js";

const email = `test-v56-${crypto.randomUUID()}@example.com`;
let cookie: string;
let siteId: string;
// IDs of windows the API tests create, deleted at the end.
const created: string[] = [];

beforeAll(async () => {
  await db.insert(users).values({ email, passwordHash: await bcrypt.hash("TestPass123", 10) });
  cookie = await loginWith2fa(email, "TestPass123");
  siteId = (await db.insert(sites).values({ name: `v56-${crypto.randomUUID()}` }).returning())[0].id;
});

afterAll(async () => {
  if (created.length) await db.delete(maintenanceWindows).where(inArray(maintenanceWindows.id, created));
  await db.delete(sites).where(eq(sites.id, siteId));
  await db.delete(users).where(eq(users.email, email));
});

// A repeating window in UTC, so the instants below read the same as the clock.
const base = { startsAt: null, endsAt: null, enabled: true, timeZone: "UTC", startTime: "02:00", durationMinutes: 60, daysOfWeek: null as number[] | null };
const at = (iso: string) => new Date(iso);

describe("repeat types", () => {
  it("daily runs every day, and every 2 days counts from the start date", () => {
    const daily = { ...base, recurrence: "daily" };
    expect(windowIsActive(daily, at("2026-11-09T02:30:00Z"))).toBe(true);
    expect(windowIsActive(daily, at("2026-11-10T02:30:00Z"))).toBe(true);
    expect(windowIsActive(daily, at("2026-11-10T03:00:00Z"))).toBe(false);
    const everyOther = { ...daily, repeatEvery: 2, startDate: "2026-11-09" };
    expect(occursOn(everyOther, "2026-11-09")).toBe(true);
    expect(occursOn(everyOther, "2026-11-10")).toBe(false);
    expect(occursOn(everyOther, "2026-11-11")).toBe(true);
  });

  // "Every 2 weeks on Mon and Thu": both days of an on-week count, then a week off.
  it("weekly every 2 weeks keeps the days of one week together", () => {
    const w = { ...base, recurrence: "weekly", daysOfWeek: [1, 4], repeatEvery: 2, startDate: "2026-11-09" };
    expect(occursOn(w, "2026-11-09")).toBe(true); // Mon, on-week
    expect(occursOn(w, "2026-11-12")).toBe(true); // Thu, same week
    expect(occursOn(w, "2026-11-16")).toBe(false); // Mon, off-week
    expect(occursOn(w, "2026-11-23")).toBe(true); // Mon, on-week again
  });

  it("monthly on day 31 falls on the last day of shorter months", () => {
    const w = { ...base, recurrence: "monthly_day", dayOfMonth: 31 };
    expect(occursOn(w, "2026-01-31")).toBe(true);
    expect(occursOn(w, "2026-02-28")).toBe(true);
    expect(occursOn(w, "2026-04-30")).toBe(true);
    expect(occursOn(w, "2026-04-29")).toBe(false);
    const last = { ...base, recurrence: "monthly_day", dayOfMonth: -1 };
    expect(occursOn(last, "2026-11-30")).toBe(true);
    expect(occursOn(last, "2026-11-29")).toBe(false);
  });

  // Patch Tuesday: the 2nd Tuesday. November 2026 starts on a Sunday, so it's the 10th.
  it("monthly on the 2nd Tuesday and on the last Friday", () => {
    const patchTuesday = { ...base, recurrence: "monthly_weekday", daysOfWeek: [2], weekOfMonth: 2 };
    expect(occursOn(patchTuesday, "2026-11-10")).toBe(true);
    expect(occursOn(patchTuesday, "2026-11-03")).toBe(false);
    expect(occursOn(patchTuesday, "2026-11-17")).toBe(false);
    const lastFriday = { ...base, recurrence: "monthly_weekday", daysOfWeek: [5], weekOfMonth: -1 };
    expect(occursOn(lastFriday, "2026-11-27")).toBe(true);
    expect(occursOn(lastFriday, "2026-11-20")).toBe(false);
  });

  it("every 3 months counts from the start date's month", () => {
    const w = { ...base, recurrence: "monthly_day", dayOfMonth: 1, repeatEvery: 3, startDate: "2026-01-01" };
    expect(occursOn(w, "2026-01-01")).toBe(true);
    expect(occursOn(w, "2026-02-01")).toBe(false);
    expect(occursOn(w, "2026-04-01")).toBe(true);
  });

  // Weekly windows saved before 5.6 have days but no repeat type: still weekly.
  it("treats an unlabeled window with days as weekly", () => {
    expect(windowIsActive({ ...base, daysOfWeek: [1] }, at("2026-11-09T02:30:00Z"))).toBe(true);
  });
});

describe("date ranges, long windows and UTC", () => {
  it("doesn't start outside its date range, but finishes one that started inside it", () => {
    const w = { ...base, recurrence: "daily", startTime: "23:00", durationMinutes: 120, startDate: "2026-11-10", endDate: "2026-11-12" };
    expect(windowIsActive(w, at("2026-11-09T23:30:00Z"))).toBe(false); // before the range
    expect(windowIsActive(w, at("2026-11-12T23:30:00Z"))).toBe(true); // last day
    expect(windowIsActive(w, at("2026-11-13T00:30:00Z"))).toBe(true); // last occurrence running past midnight
    expect(windowIsActive(w, at("2026-11-13T23:30:00Z"))).toBe(false); // after the range
  });

  // The pre-5.6 code only looked back 7 days; a 10-day window must stay active on day 9.
  it("keeps a window longer than a week running to its end", () => {
    const w = { ...base, recurrence: "monthly_day", dayOfMonth: 1, startTime: "00:00", durationMinutes: 10 * 1440 };
    expect(windowIsActive(w, at("2026-11-09T12:00:00Z"))).toBe(true);
    expect(windowIsActive(w, at("2026-11-11T00:00:00Z"))).toBe(false);
  });

  // The same "02:00" means different instants in UTC and in Chicago (UTC-6 in November).
  it("reads the start time in UTC when the window is in UTC", () => {
    const w = { ...base, recurrence: "daily" };
    expect(windowIsActive(w, at("2026-11-09T02:30:00Z"))).toBe(true);
    expect(windowIsActive({ ...w, timeZone: "America/Chicago" }, at("2026-11-09T02:30:00Z"))).toBe(false);
    expect(windowIsActive({ ...w, timeZone: "America/Chicago" }, at("2026-11-09T08:30:00Z"))).toBe(true);
  });

  it("works out the next start, and none after the range ends", () => {
    const w = { ...base, recurrence: "monthly_weekday", daysOfWeek: [2], weekOfMonth: 2 };
    expect(nextStart(w, at("2026-11-09T12:00:00Z"))?.toISOString()).toBe("2026-11-10T02:00:00.000Z");
    expect(nextStart({ ...w, endDate: "2026-11-09" }, at("2026-11-09T12:00:00Z"))).toBeNull();
    expect(nextStart({ ...w, enabled: false }, at("2026-11-09T12:00:00Z"))).toBeNull();
  });
});

describe("maintenance API: creating and editing", () => {
  const post = (body: Record<string, unknown>) => request(app).post("/api/maintenance").set("Cookie", cookie).send(body);
  const patch = (id: string, body: Record<string, unknown>) => request(app).patch(`/api/maintenance/${id}`).set("Cookie", cookie).send(body);

  it("creates a monthly-weekday window in UTC with a date range and returns its next start", async () => {
    const res = await post({ name: "patch tuesday", scope: "site", targetIds: [siteId], recurrence: "monthly_weekday", daysOfWeek: [2], weekOfMonth: 2, startTime: "02:00", durationMinutes: 120, timeZone: "UTC", startDate: "2026-11-01", endDate: "2027-12-31" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    created.push(res.body.id);
    expect(res.body.recurrence).toBe("monthly_weekday");
    expect(typeof res.body.next).toBe("string");
  });

  it("labels a window sent with only days of the week as weekly", async () => {
    const res = await post({ name: "legacy weekly", daysOfWeek: [0], startTime: "02:00", durationMinutes: 60, timeZone: "UTC" });
    expect(res.status).toBe(201);
    created.push(res.body.id);
    expect(res.body.recurrence).toBe("weekly");
  });

  // Switching kinds must clear the other kind's fields, or the old one-off
  // instants would keep deciding when the window runs.
  it("edits a one-time window into a repeating one and back", async () => {
    const res = await post({ name: "edit me", startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-01T02:00:00Z", timeZone: "UTC" });
    created.push(res.body.id);
    const toDaily = await patch(res.body.id, { name: "edited", recurrence: "daily", startTime: "03:00", durationMinutes: 30 });
    expect(toDaily.status, JSON.stringify(toDaily.body)).toBe(200);
    expect(toDaily.body).toMatchObject({ name: "edited", recurrence: "daily", startsAt: null, endsAt: null });
    const toOnce = await patch(res.body.id, { startsAt: "2026-12-05T00:00:00Z", endsAt: "2026-12-05T01:00:00Z" });
    expect(toOnce.status).toBe(200);
    expect(toOnce.body).toMatchObject({ recurrence: null, startTime: null, durationMinutes: null, daysOfWeek: null });
    // Turning it off leaves the schedule alone.
    const off = await patch(res.body.id, { enabled: false });
    expect(off.body).toMatchObject({ enabled: false, startsAt: "2026-12-05T00:00:00.000Z" });
  });

  // An edit that would leave the window without a complete schedule is refused,
  // and nothing is stored.
  it("refuses an edit that leaves an incomplete schedule", async () => {
    const res = await post({ name: "keep me", recurrence: "weekly", daysOfWeek: [1], startTime: "02:00", durationMinutes: 60 });
    created.push(res.body.id);
    const bad = await patch(res.body.id, { recurrence: "monthly_day" });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toMatch(/day of the month/);
    const row = await db.query.maintenanceWindows.findFirst({ where: eq(maintenanceWindows.id, res.body.id) });
    expect(row?.recurrence).toBe("weekly");
  });

  // Malformed values are refused rather than stored, so nothing can be saved
  // that would never end or break the check every result passes through.
  it.each([
    [{ dayOfMonth: 40, recurrence: "monthly_day" }, /dayOfMonth/],
    [{ startTime: "25:00", recurrence: "daily" }, /startTime/],
    [{ startDate: "2026-02-30", recurrence: "daily" }, /startDate/],
    [{ durationMinutes: 99_999_999, recurrence: "daily" }, /durationMinutes/],
    [{ durationMinutes: "abc", recurrence: "daily" }, /durationMinutes/],
    [{ recurrence: "yearly" }, /recurrence/],
    [{ recurrence: "daily", repeatEvery: 2 }, /start date/],
    [{ recurrence: "daily", startDate: "2026-12-01", endDate: "2026-11-01" }, /endDate/],
    [{ startsAt: "not a date", endsAt: "2026-12-01T00:00:00Z" }, /startsAt/],
    [{ scope: "site", targetIds: [], startsAt: "2026-12-01T00:00:00Z", endsAt: "2026-12-01T01:00:00Z" }, /target/],
  ])("refuses %o", async (fields, message) => {
    const res = await post({ name: "invalid", startTime: "02:00", durationMinutes: 60, ...fields });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(message);
  });

  it("returns 404 when editing a window that doesn't exist", async () => {
    const res = await patch(crypto.randomUUID(), { name: "ghost" });
    expect(res.status).toBe(404);
  });

  // Editing a window can pause alerting, so it needs a session.
  it("refuses an edit without a session", async () => {
    const res = await request(app).patch(`/api/maintenance/${crypto.randomUUID()}`).send({ enabled: true });
    expect(res.status).toBe(401);
  });
});
