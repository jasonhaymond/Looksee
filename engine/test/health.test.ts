import "dotenv/config";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

// Hits a real Postgres (per the global integration-test standard) rather
// than mocking the pool — run `docker compose up -d` first, see README.
describe("GET /api/health", () => {
  it("reports ok when the database is reachable", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.db).toBe("connected");
    // agent/VERSION exists in this checkout, so this should read a real
    // version string, not just be present-but-null.
    expect(res.body.agentVersion).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("auth", () => {
  it("rejects unauthenticated requests to protected routes", async () => {
    const res = await request(app).get("/api/sites");
    expect(res.status).toBe(401);
  });
});
