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
  // One copy-pasteable command: downloads the right binary for the target
  // host's OS/arch, writes its config with this key baked in, and (on
  // Linux, with sudo) installs it as a systemd service — see
  // engine/src/routes/install.ts for what it actually runs.
  const publicUrl = process.env.PUBLIC_URL ?? `http://localhost:${process.env.PORT ?? 4100}`;
  const installCommand = `curl -fsSL ${publicUrl}/install/agent.sh | sudo bash -s -- ${agentApiKey}`;
  res.json({ agentApiKey, installCommand });
});

hostsRouter.delete("/:id", async (req, res) => {
  await db.delete(hosts).where(eq(hosts.id, req.params.id));
  res.status(204).end();
});
