import "dotenv/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { app } from "../src/app.js";
import { db } from "../src/db/index.js";
import { users, logs } from "../src/db/schema.js";
import { logger } from "../src/lib/logger.js";

const email = `test-logs-${crypto.randomUUID()}@example.com`;
const password = "TestPass123";
let cookie: string;
const marker = crypto.randomUUID();

beforeAll(async () => {
  const passwordHash = await bcrypt.hash(password, 10);
  await db.insert(users).values({ email, passwordHash });
  const loginRes = await request(app).post("/api/auth/login").send({ email, password });
  cookie = loginRes.headers["set-cookie"]![0];

  logger.debug("test", `debug entry ${marker}`);
  logger.error("test", `error entry ${marker}`, `Human-readable translation ${marker}`);
  // logger writes are fire-and-forget; give the insert a moment to land.
  await new Promise((resolve) => setTimeout(resolve, 200));
});

afterAll(async () => {
  await db.delete(users).where(eq(users.email, email));
  await db.delete(logs).where(eq(logs.source, "test"));
});

describe("logs", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/logs");
    expect(res.status).toBe(401);
  });

  it("rejects an invalid level filter", async () => {
    const res = await request(app).get("/api/logs?level=not_a_level").set("Cookie", cookie);
    expect(res.status).toBe(400);
  });

  it("lists recent logs, newest first, with a human message required for non-debug levels", async () => {
    const res = await request(app).get("/api/logs?limit=1000").set("Cookie", cookie);
    expect(res.status).toBe(200);
    const debugEntry = res.body.find((l: { message: string }) => l.message === `debug entry ${marker}`);
    const errorEntry = res.body.find((l: { message: string }) => l.message === `error entry ${marker}`);
    expect(debugEntry).toBeDefined();
    expect(debugEntry.humanMessage).toBeNull();
    expect(errorEntry).toBeDefined();
    expect(errorEntry.humanMessage).toBe(`Human-readable translation ${marker}`);
  });

  it("filters by level", async () => {
    const res = await request(app).get("/api/logs?level=debug&limit=1000").set("Cookie", cookie);
    expect(res.status).toBe(200);
    expect(res.body.every((l: { level: string }) => l.level === "debug")).toBe(true);
  });
});
