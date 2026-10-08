import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts, hostMetrics, checks, endpoints, maintenanceWindows } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { sendWakeOnLan } from "../services/probes/protocols.js";
import { suggestChecks } from "../services/suggestions.js";
import { invalidateMaintenanceCache } from "../services/maintenance.js";
import { HOST_METRICS } from "../services/hostMetrics.js";

export const hostsRouter = Router();
hostsRouter.use(requireAuth);

hostsRouter.get("/", async (req, res) => {
  const endpointId = typeof req.query.endpointId === "string" ? req.query.endpointId : undefined;
  const rows = await db.query.hosts.findMany({
    where: endpointId ? eq(hosts.endpointId, endpointId) : undefined,
    orderBy: (h, { asc }) => asc(h.name),
  });
  // agentApiKey is a credential — never returned in a list/read response,
  // only shown once at issuance (see /:id/agent-key below). The full
  // snapshot is left to GET /:id; the list stays small.
  res.json(rows.map(({ agentApiKey, lastSnapshot, ...rest }) => ({ ...rest, hasAgentKey: Boolean(agentApiKey), hasSnapshot: Boolean(lastSnapshot) })));
});

// The host-metric catalog (label, unit, which instance it filters on) the
// check form builds its metric picker from.
hostsRouter.get("/metric-catalog", (_req, res) => {
  res.json(HOST_METRICS.map(({ read, ...def }) => def));
});

hostsRouter.get("/:id", async (req, res) => {
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, req.params.id) });
  if (!host) {
    res.status(404).json({ error: "Host not found" });
    return;
  }
  const { agentApiKey, ...rest } = host;
  res.json({ ...rest, hasAgentKey: Boolean(agentApiKey) });
});

hostsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const endpointId = String(req.body?.endpointId ?? "");
  if (!name || !endpointId) {
    res.status(400).json({ error: "name and endpointId are required" });
    return;
  }
  const hostname = req.body?.hostname ? String(req.body.hostname) : null;
  const os = req.body?.os ? String(req.body.os) : null;
  const macAddress = req.body?.macAddress ? String(req.body.macAddress) : null;
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
  const [host] = await db.insert(hosts).values({ name, endpointId, hostname, os, macAddress, tags }).returning();
  const { agentApiKey, ...rest } = host;
  res.status(201).json(rest);
});

hostsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof hosts.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.hostname !== undefined) updates.hostname = req.body.hostname ? String(req.body.hostname) : null;
  if (req.body?.os !== undefined) updates.os = req.body.os ? String(req.body.os) : null;
  if (req.body?.macAddress !== undefined) updates.macAddress = req.body.macAddress ? String(req.body.macAddress) : null;
  if (req.body?.endpointId !== undefined) updates.endpointId = String(req.body.endpointId);
  if (Array.isArray(req.body?.tags)) updates.tags = [...new Set(req.body.tags.map(String))] as string[];
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

// Recent metrics history for one host, used by the dashboard's host-metrics
// widget — same clamped-limit/newest-first shape as checks.ts's
// /:id/results.
hostsRouter.get("/:id/metrics", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 2000);
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const validSince = since && !Number.isNaN(since.getTime()) ? since : undefined;
  const rows = await db.query.hostMetrics.findMany({
    where: validSince ? and(eq(hostMetrics.hostId, req.params.id), gte(hostMetrics.recordedAt, validSince)) : eq(hostMetrics.hostId, req.params.id),
    orderBy: desc(hostMetrics.recordedAt),
    limit,
  });
  res.json(rows);
});

hostsRouter.delete("/:id", async (req, res) => {
  await db.delete(hosts).where(eq(hosts.id, req.params.id));
  res.status(204).end();
});

hostsRouter.post("/:id/wake", async (req, res) => {
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, req.params.id) });
  if (!host?.macAddress) {
    res.status(400).json({ error: "Set this host's MAC address first" });
    return;
  }
  try {
    await sendWakeOnLan(host.macAddress, req.body?.broadcast ? String(req.body.broadcast) : undefined);
    res.json({ sent: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function suggestionsFor(hostId: string) {
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, hostId) });
  if (!host) return null;
  const existing = await db.query.checks.findMany({ where: eq(checks.hostId, hostId) });
  return { host, suggestions: suggestChecks(host, existing) };
}

hostsRouter.get("/:id/suggestions", async (req, res) => {
  const found = await suggestionsFor(req.params.id);
  if (!found) {
    res.status(404).json({ error: "Host not found" });
    return;
  }
  res.json(found.suggestions);
});

async function applySuggestions(hostId: string, keys: string[] | null, endpointId?: string) {
  const found = await suggestionsFor(hostId);
  if (!found) return 0;
  const chosen = keys ? found.suggestions.filter((s) => keys.includes(s.key)) : found.suggestions;
  if (!chosen.length) return 0;
  await db.insert(checks).values(
    chosen.map((s) => ({ name: s.name, endpointId: endpointId ?? found.host.endpointId, hostId, type: s.type as typeof checks.$inferInsert.type, config: s.config, intervalSeconds: s.intervalSeconds ?? 60 }))
  );
  return chosen.length;
}

hostsRouter.post("/:id/suggestions/apply", async (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : null;
  const created = await applySuggestions(req.params.id, keys, req.body?.endpointId ? String(req.body.endpointId) : undefined);
  res.json({ created });
});

// Multi-select actions from the hosts table.
hostsRouter.post("/bulk", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const action = String(req.body?.action ?? "");
  if (!ids.length) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  const rows = await db.query.hosts.findMany({ where: inArray(hosts.id, ids) });
  const errors: { id: string; error: string }[] = [];
  let affected = 0;
  const hostChecks = or(inArray(checks.hostId, ids), inArray(checks.probeHostId, ids));
  switch (action) {
    case "delete":
      affected = (await db.delete(hosts).where(inArray(hosts.id, ids)).returning({ id: hosts.id })).length;
      break;
    case "move": {
      const endpointId = String(req.body?.endpointId ?? "");
      if (!(await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) }))) {
        res.status(400).json({ error: "endpointId not found" });
        return;
      }
      affected = (await db.update(hosts).set({ endpointId }).where(inArray(hosts.id, ids)).returning({ id: hosts.id })).length;
      if (req.body?.moveChecks) await db.update(checks).set({ endpointId }).where(inArray(checks.hostId, ids));
      break;
    }
    case "request_update":
      affected = (await db.update(hosts).set({ updateRequested: true }).where(inArray(hosts.id, ids)).returning({ id: hosts.id })).length;
      break;
    case "add_tags":
    case "remove_tags": {
      const tags: string[] = Array.isArray(req.body?.tags)
        ? req.body.tags.map(String)
        : String(req.body?.tags ?? "")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean);
      for (const h of rows) {
        const next = action === "add_tags" ? [...new Set([...(h.tags ?? []), ...tags])] : (h.tags ?? []).filter((t) => !tags.includes(t));
        await db.update(hosts).set({ tags: next }).where(eq(hosts.id, h.id));
        affected++;
      }
      break;
    }
    case "enable_checks":
    case "disable_checks":
      affected = (await db.update(checks).set({ enabled: action === "enable_checks" }).where(hostChecks).returning({ id: checks.id })).length;
      break;
    case "apply_suggestions":
      for (const h of rows) affected += await applySuggestions(h.id, null);
      break;
    case "wake":
      for (const h of rows) {
        if (!h.macAddress) {
          errors.push({ id: h.id, error: `${h.name}: no MAC address` });
          continue;
        }
        await sendWakeOnLan(h.macAddress)
          .then(() => affected++)
          .catch((e) => errors.push({ id: h.id, error: `${h.name}: ${e instanceof Error ? e.message : String(e)}` }));
      }
      break;
    case "maintenance": {
      const minutes = Math.max(1, Number(req.body?.minutes) || 60);
      const now = new Date();
      await db.insert(maintenanceWindows).values({ name: String(req.body?.name || `Maintenance for ${rows.length} host(s)`), scope: "host", targetIds: ids, startsAt: now, endsAt: new Date(now.getTime() + minutes * 60_000) });
      invalidateMaintenanceCache();
      affected = rows.length;
      break;
    }
    default:
      res.status(400).json({ error: `Unknown action: ${action}` });
      return;
  }
  res.json({ affected, errors });
});
