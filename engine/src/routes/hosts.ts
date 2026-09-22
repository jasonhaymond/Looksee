import { Router } from "express";
import crypto from "node:crypto";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";

export const hostsRouter = Router();
hostsRouter.use(requireAuth);

hostsRouter.get("/", async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const rows = await db.query.hosts.findMany({
    where: siteId ? eq(hosts.siteId, siteId) : undefined,
    orderBy: (h, { asc }) => asc(h.name),
  });
  // agentApiKey is a credential — never returned in a list/read response,
  // only shown once at issuance (see /:id/agent-key below).
  res.json(rows.map(({ agentApiKey, ...rest }) => rest));
});

hostsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const siteId = String(req.body?.siteId ?? "");
  if (!name || !siteId) {
    res.status(400).json({ error: "name and siteId are required" });
    return;
  }
  const hostname = req.body?.hostname ? String(req.body.hostname) : null;
  const os = req.body?.os ? String(req.body.os) : null;
  const [host] = await db.insert(hosts).values({ name, siteId, hostname, os }).returning();
  const { agentApiKey, ...rest } = host;
  res.status(201).json(rest);
});

hostsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof hosts.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.hostname !== undefined) updates.hostname = req.body.hostname ? String(req.body.hostname) : null;
  if (req.body?.os !== undefined) updates.os = req.body.os ? String(req.body.os) : null;
  const [host] = await db.update(hosts).set(updates).where(eq(hosts.id, req.params.id)).returning();
  if (!host) {
    res.status(404).json({ error: "Host not found" });
    return;
  }
  const { agentApiKey, ...rest } = host;
  res.json(rest);
});

// Issues (or reissues) the agent bearer token for this host. Shown exactly
// once in the response, per the global "credentials shown once" standard —
// the plaintext key is never retrievable again after this call, only reset.
hostsRouter.post("/:id/agent-key", async (req, res) => {
  const agentApiKey = crypto.randomBytes(24).toString("hex");
  const [host] = await db
    .update(hosts)
    .set({ agentApiKey })
    .where(eq(hosts.id, req.params.id))
    .returning();
  if (!host) {
    res.status(404).json({ error: "Host not found" });
    return;
  }
  // Copy-pasteable commands per platform: each downloads the right binary,
  // writes its config with this key baked in, and installs it as a real
  // service (systemd/launchd on unix, a Scheduled Task on Windows) — see
  // engine/src/routes/install.ts for what they actually run. The bash
  // bootstrap (agent.sh) already detects Linux vs. macOS itself via `uname`,
  // so one command covers both; Windows needs a separate PowerShell one
  // since bash/curl/sudo aren't available there by default.
  const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4100}`;
  const installCommands = {
    unix: `curl -fsSL ${publicUrl}/install/agent.sh | sudo bash -s -- ${agentApiKey}`,
    windows: `$env:LOOKSEE_ENGINE_URL='${publicUrl}'; $env:LOOKSEE_AGENT_KEY='${agentApiKey}'; iex (irm ${publicUrl}/install/agent.ps1)`,
  };
  res.json({ agentApiKey, installCommands });
});

// Push-to-update: flags this host so its agent updates itself on its next
// config poll (see routes/agent.ts's GET /config, which consumes this flag
// one-shot). Doesn't wait for or confirm the update — the host's
// agentVersion changing on a later report is the real confirmation, shown
// in the dashboard.
hostsRouter.post("/:id/request-update", async (req, res) => {
  const [host] = await db.update(hosts).set({ updateRequested: true }).where(eq(hosts.id, req.params.id)).returning();
  if (!host) {
    res.status(404).json({ error: "Host not found" });
    return;
  }
  res.json({ requested: true });
});

hostsRouter.delete("/:id", async (req, res) => {
  await db.delete(hosts).where(eq(hosts.id, req.params.id));
  res.status(204).end();
});
