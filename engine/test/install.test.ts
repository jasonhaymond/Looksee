import "dotenv/config";
import { describe, expect, it } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

// This route group is intentionally unauthenticated (a host bootstrapping
// the agent for the first time has no session yet) — no login step here.
describe("install routes", () => {
  it("serves the bootstrap script with the agent-key usage baked in", async () => {
    const res = await request(app).get("/install/agent.sh");
    expect(res.status).toBe(200);
    expect(res.text).toContain("#!/usr/bin/env bash");
    expect(res.text).toContain("Usage: curl -fsSL");
    expect(res.text).toContain("/install/agent/$PLATFORM");
  });

  it("serves install.sh and the systemd unit verbatim", async () => {
    const installSh = await request(app).get("/install/install.sh");
    expect(installSh.status).toBe(200);
    expect(installSh.text).toContain("systemd service");

    const unit = await request(app).get("/install/looksee-agent.service");
    expect(unit.status).toBe(200);
    expect(unit.text).toContain("[Service]");
  });

  it("rejects an unknown platform", async () => {
    const res = await request(app).get("/install/agent/not-a-real-platform");
    expect(res.status).toBe(400);
  });
});
