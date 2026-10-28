// API routes for endpoints (devices: servers, PCs, switches, printers): list,
// details, inventory, IP history, create, edit, delete, agent keys and install
// commands, agent updates, watchdog settings, which sites it collects for,
// metrics, Wake-on-LAN,
// suggestions, role/security templates and bulk actions.
//
// Security: every route requires a signed-in session; an endpoint's agent key
// is shown once when issued and never returned again (only replaced).

import { Router } from "express";
import crypto from "node:crypto";
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import { db } from "../db/index.js";
import { queueCollectorJob, siteCollectorFor } from "../services/sites.js";
import { endpoints, endpointMetrics, checks, sites, maintenanceWindows } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { sendWakeOnLan } from "../services/probes/protocols.js";
import { suggestChecks } from "../services/suggestions.js";
import { invalidateMaintenanceCache } from "../services/maintenance.js";
import { ENDPOINT_METRICS } from "../services/endpointMetrics.js";
import { addressHistory } from "../services/addresses.js";
import { createAlertRule, parseAlertRule, type AlertRuleParams } from "../services/alertRuleFactory.js";
import { parseWatchdog } from "../services/watchdogAgents.js";
import { hostFacts, templatesFor } from "../services/roleTemplates.js";
import { primaryAddress } from "../services/suggestions.js";
import { invalidateSiteIpCache } from "../services/receivers/index.js";
import { isUuid } from "../lib/ids.js";

// The full process/service lists can be thousands of rows — they're served
// by /:id/inventory only, never in list or detail responses.
type EndpointRow = typeof endpoints.$inferSelect;
function publicHost({ agentApiKey, processInventory, serviceInventory, ...rest }: EndpointRow) {
  return {
    ...rest,
    hasAgentKey: Boolean(agentApiKey),
    hasSnapshot: Boolean(rest.lastSnapshot),
    processCount: Array.isArray(processInventory) ? processInventory.length : null,
    serviceCount: Array.isArray(serviceInventory) ? serviceInventory.length : null,
  };
}

export const endpointsRouter = Router();
endpointsRouter.use(requireAuth);

endpointsRouter.get("/", async (req, res) => {
  const siteId = typeof req.query.siteId === "string" ? req.query.siteId : undefined;
  const rows = await db.query.endpoints.findMany({
    where: siteId ? eq(endpoints.siteId, siteId) : undefined,
    orderBy: (h, { asc }) => asc(h.name),
  });
  // agentApiKey is a credential — never returned in a list/read response,
  // only shown once at issuance (see /:id/agent-key below). The full
  // snapshot is left to GET /:id; the list stays small.
  res.json(rows.map((h) => ({ ...publicHost(h), lastSnapshot: undefined })));
});

// The host-metric catalog (label, unit, which instance it filters on) the
// check form builds its metric picker from.
endpointsRouter.get("/metric-catalog", (_req, res) => {
  // Everything except read (a function, not data).
  res.json(
    ENDPOINT_METRICS.map((m) => {
      const def: Partial<typeof m> = { ...m };
      delete def.read;
      return def;
    })
  );
});

endpointsRouter.get("/:id", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json(publicHost(host));
});

// Processes and services the agent last reported, plus the scripts in its
// script_dir — the Endpoints page tabs and the check form's pickers.
endpointsRouter.get("/:id/inventory", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json({
    processes: host.processInventory ?? null,
    services: host.serviceInventory ?? null,
    scripts: host.availableScripts ?? null,
    containers: (host.lastSnapshot as { availableContainers?: string[] } | null)?.availableContainers ?? null,
    updatedAt: host.inventoryUpdatedAt,
    // Older agents only send names.
    processNames: host.availableProcesses ?? null,
    serviceNames: host.availableServices ?? null,
  });
});

endpointsRouter.get("/:id/addresses", async (req, res) => {
  res.json(await addressHistory(req.params.id));
});

endpointsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const siteId = String(req.body?.siteId ?? "");
  if (!name || !siteId) {
    res.status(400).json({ error: "name and siteId are required" });
    return;
  }
  const hostname = req.body?.hostname ? String(req.body.hostname) : null;
  const os = req.body?.os ? String(req.body.os) : null;
  const macAddress = req.body?.macAddress ? String(req.body.macAddress) : null;
  const tags = Array.isArray(req.body?.tags) ? req.body.tags.map(String) : [];
  const [host] = await db.insert(endpoints).values({ name, siteId, hostname, os, macAddress, tags }).returning();
  res.status(201).json(publicHost(host));
});

endpointsRouter.patch("/:id", async (req, res) => {
  const updates: Partial<typeof endpoints.$inferInsert> = {};
  if (req.body?.name !== undefined) updates.name = String(req.body.name).trim();
  if (req.body?.hostname !== undefined) updates.hostname = req.body.hostname ? String(req.body.hostname) : null;
  if (req.body?.os !== undefined) updates.os = req.body.os ? String(req.body.os) : null;
  if (req.body?.macAddress !== undefined) updates.macAddress = req.body.macAddress ? String(req.body.macAddress) : null;
  if (req.body?.siteId !== undefined) updates.siteId = String(req.body.siteId);
  if (Array.isArray(req.body?.tags)) updates.tags = [...new Set(req.body.tags.map(String))] as string[];
  const [host] = await db.update(endpoints).set(updates).where(eq(endpoints.id, req.params.id)).returning();
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json(publicHost(host));
});

// Issues (or reissues) the agent bearer token for this host. Shown exactly
// once in the response, per the global "credentials shown once" standard —
// the plaintext key is never retrievable again after this call, only reset.
endpointsRouter.post("/:id/agent-key", async (req, res) => {
  const agentApiKey = crypto.randomBytes(24).toString("hex");
  const [host] = await db
    .update(endpoints)
    .set({ agentApiKey })
    .where(eq(endpoints.id, req.params.id))
    .returning();
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
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
    // Run inside the Termux app (agent/install-android.sh).
    android: `curl -fsSL ${publicUrl}/install/agent-android.sh | bash -s -- ${publicUrl} ${agentApiKey}`,
  };
  res.json({ agentApiKey, installCommands });
});

// PUT /api/endpoints/:id/watchdog { enabled, afterMinutes, emailTo, channelIds }
// Makes this endpoint's agent a watchdog: if it can't reach Looksee for
// afterMinutes, it alerts the given addresses/channels itself. Its next
// config poll picks the settings up (services/watchdogAgents.ts says what
// the agent receives, including delivery secrets — only ever for an
// endpoint set up here).
endpointsRouter.put("/:id/watchdog", async (req, res) => {
  const { value, error } = await parseWatchdog(req.body ?? {});
  if (error || !value) {
    res.status(400).json({ error: error ?? "Invalid watchdog settings" });
    return;
  }
  const [host] = await db.update(endpoints).set({ watchdog: value }).where(eq(endpoints.id, req.params.id)).returning();
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json(publicHost(host));
});

// POST /api/endpoints/:id/watchdog/test — asks this watchdog agent to send a
// test message to its addresses/channels on its next config poll; its
// result shows in the endpoint's watchdog status after the following report.
endpointsRouter.post("/:id/watchdog/test", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host?.watchdog?.enabled) {
    res.status(400).json({ error: "This endpoint isn't a watchdog agent" });
    return;
  }
  await db.update(endpoints).set({ watchdog: { ...host.watchdog, testRequestedAt: new Date().toISOString() } }).where(eq(endpoints.id, host.id));
  res.json({ requested: true });
});

// PUT /api/endpoints/:id/collector-sites { siteIds: [...] }
// Makes this endpoint's agent the site collector for exactly these sites
// (networks) — one agent can collect for several. Sites in the list get this
// endpoint as their collector (replacing any other); sites that had it and
// aren't in the list go back to the engine. Returns the sites it collects
// for afterwards. The agent starts or stops the collector on its next config
// poll (routes/agent.ts).
//
// Only an endpoint with an agent key can collect (the collector runs under
// the agent and authenticates with its key); unknown site IDs are refused
// rather than ignored so a stale form can't half-apply.
endpointsRouter.put("/:id/collector-sites", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  const raw: unknown[] = Array.isArray(req.body?.siteIds) ? req.body.siteIds : [];
  const siteIds = [...new Set(raw.map(String))];
  if (siteIds.length && !host.agentApiKey) {
    res.status(400).json({ error: "The site collector must be an endpoint with an agent installed" });
    return;
  }
  // Every ID must be a real site (isUuid first: a malformed ID would make
  // PostgreSQL throw instead of simply not matching).
  const found = siteIds.length && siteIds.every(isUuid) ? await db.query.sites.findMany({ where: inArray(sites.id, siteIds), columns: { id: true } }) : [];
  if (found.length !== siteIds.length) {
    res.status(400).json({ error: "siteIds must all be existing sites" });
    return;
  }
  // Release the sites that are no longer wanted, then claim the chosen ones.
  const current = await db.query.sites.findMany({ where: eq(sites.collectorEndpointId, host.id), columns: { id: true } });
  const release = current.map((s) => s.id).filter((id) => !siteIds.includes(id));
  if (release.length) await db.update(sites).set({ collectorEndpointId: null }).where(inArray(sites.id, release));
  if (siteIds.length) await db.update(sites).set({ collectorEndpointId: host.id }).where(inArray(sites.id, siteIds));
  invalidateSiteIpCache();
  res.json(await db.query.sites.findMany({ where: eq(sites.collectorEndpointId, host.id) }));
});

// Push-to-update: flags this host so its agent updates itself on its next
// config poll (see routes/agent.ts's GET /config, which consumes this flag
// one-shot). Doesn't wait for or confirm the update — the host's
// agentVersion changing on a later report is the real confirmation, shown
// in the dashboard.
endpointsRouter.post("/:id/request-update", async (req, res) => {
  const [host] = await db.update(endpoints).set({ updateRequested: true }).where(eq(endpoints.id, req.params.id)).returning();
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json({ requested: true });
});

// Recent metrics history for one host, used by the dashboard's host-metrics
// widget — same clamped-limit/newest-first shape as checks.ts's
// /:id/results.
endpointsRouter.get("/:id/metrics", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 2000);
  const since = typeof req.query.since === "string" ? new Date(req.query.since) : undefined;
  const validSince = since && !Number.isNaN(since.getTime()) ? since : undefined;
  const rows = await db.query.endpointMetrics.findMany({
    where: validSince ? and(eq(endpointMetrics.endpointId, req.params.id), gte(endpointMetrics.recordedAt, validSince)) : eq(endpointMetrics.endpointId, req.params.id),
    orderBy: desc(endpointMetrics.recordedAt),
    limit,
  });
  res.json(rows);
});

endpointsRouter.delete("/:id", async (req, res) => {
  await db.delete(endpoints).where(eq(endpoints.id, req.params.id));
  res.status(204).end();
});

endpointsRouter.post("/:id/wake", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host?.macAddress) {
    res.status(400).json({ error: "Set this endpoint's MAC address first" });
    return;
  }
  try {
    const broadcast = req.body?.broadcast ? String(req.body.broadcast) : undefined;
    // A magic packet only works on the target's own LAN, so a remote site's
    // host is woken by that site's collector.
    if (await siteCollectorFor(host.siteId)) {
      await queueCollectorJob(host.siteId, "wake", { mac: host.macAddress, broadcast });
      res.json({ sent: true, viaCollector: true });
      return;
    }
    await sendWakeOnLan(host.macAddress, broadcast);
    res.json({ sent: true });
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

async function suggestionsFor(endpointId: string) {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) });
  if (!host) return null;
  const existing = await db.query.checks.findMany({ where: eq(checks.endpointId, endpointId) });
  return { host, suggestions: suggestChecks(host, existing) };
}

endpointsRouter.get("/:id/suggestions", async (req, res) => {
  const found = await suggestionsFor(req.params.id);
  if (!found) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  res.json(found.suggestions);
});

// overrides: per-suggestion edits from the UI (name, interval, config).
async function applySuggestions(endpointId: string, keys: string[] | null, opts: { siteId?: string; alertRule?: AlertRuleParams | null; overrides?: Record<string, { name?: string; intervalSeconds?: number; config?: Record<string, unknown> }> } = {}) {
  const found = await suggestionsFor(endpointId);
  if (!found) return 0;
  const chosen = keys ? found.suggestions.filter((s) => keys.includes(s.key)) : found.suggestions;
  if (!chosen.length) return 0;
  const created = await db
    .insert(checks)
    .values(
      chosen.map((s) => {
        const o = opts.overrides?.[s.key] ?? {};
        return {
          name: o.name?.trim() || s.name,
          siteId: opts.siteId ?? found.host.siteId,
          endpointId: s.endpointScoped === false ? null : endpointId,
          type: s.type as typeof checks.$inferInsert.type,
          config: { ...s.config, ...(o.config ?? {}) },
          intervalSeconds: Number(o.intervalSeconds) >= 5 ? Number(o.intervalSeconds) : (s.intervalSeconds ?? 60),
        };
      })
    )
    .returning({ id: checks.id });
  if (opts.alertRule) for (const c of created) await createAlertRule(c.id, opts.alertRule);
  return chosen.length;
}

endpointsRouter.post("/:id/suggestions/apply", async (req, res) => {
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : null;
  const created = await applySuggestions(req.params.id, keys, {
    siteId: req.body?.siteId ? String(req.body.siteId) : undefined,
    alertRule: parseAlertRule(req.body?.alertRule),
    overrides: req.body?.overrides && typeof req.body.overrides === "object" ? req.body.overrides : undefined,
  });
  res.json({ created });
});

// GET /api/endpoints/:id/role-templates — the server-role and security
// templates (services/roleTemplates.ts): whether this endpoint looks like
// each role, and the checks each would add that it doesn't have yet.
endpointsRouter.get("/:id/role-templates", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  const existing = await db.query.checks.findMany({ where: eq(checks.endpointId, host.id) });
  res.json(templatesFor(hostFacts(host, primaryAddress((host.lastSnapshot ?? {}) as never)), existing));
});

// POST /api/endpoints/:id/role-templates/:templateId/apply { keys?, alertRule? }
// Creates the template's missing checks (or only the chosen keys) on this
// endpoint, optionally each with an alert rule.
endpointsRouter.post("/:id/role-templates/:templateId/apply", async (req, res) => {
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, req.params.id) });
  if (!host) {
    res.status(404).json({ error: "Endpoint not found" });
    return;
  }
  const existing = await db.query.checks.findMany({ where: eq(checks.endpointId, host.id) });
  const template = templatesFor(hostFacts(host, primaryAddress((host.lastSnapshot ?? {}) as never)), existing).find((t) => t.id === req.params.templateId);
  if (!template) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const keys = Array.isArray(req.body?.keys) ? req.body.keys.map(String) : null;
  const chosen = keys ? template.checks.filter((c) => keys.includes(c.key)) : template.checks;
  if (!chosen.length) {
    res.json({ created: 0 });
    return;
  }
  const created = await db
    .insert(checks)
    .values(chosen.map((c) => ({ name: c.name, siteId: host.siteId, endpointId: host.id, type: c.type as typeof checks.$inferInsert.type, config: c.config, intervalSeconds: c.intervalSeconds ?? 60, tags: [`role:${template.label}`] })))
    .returning({ id: checks.id });
  const rule = parseAlertRule(req.body?.alertRule);
  if (rule) for (const c of created) await createAlertRule(c.id, rule);
  res.json({ created: created.length });
});

// Multi-select actions from the endpoints table.
endpointsRouter.post("/bulk", async (req, res) => {
  const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
  const action = String(req.body?.action ?? "");
  if (!ids.length) {
    res.status(400).json({ error: "ids is required" });
    return;
  }
  const rows = await db.query.endpoints.findMany({ where: inArray(endpoints.id, ids) });
  const errors: { id: string; error: string }[] = [];
  let affected = 0;
  const endpointChecks = or(inArray(checks.endpointId, ids), inArray(checks.probeEndpointId, ids));
  switch (action) {
    case "delete":
      affected = (await db.delete(endpoints).where(inArray(endpoints.id, ids)).returning({ id: endpoints.id })).length;
      break;
    case "move": {
      const siteId = String(req.body?.siteId ?? "");
      if (!(await db.query.sites.findFirst({ where: eq(sites.id, siteId) }))) {
        res.status(400).json({ error: "siteId not found" });
        return;
      }
      affected = (await db.update(endpoints).set({ siteId }).where(inArray(endpoints.id, ids)).returning({ id: endpoints.id })).length;
      if (req.body?.moveChecks) await db.update(checks).set({ siteId }).where(inArray(checks.endpointId, ids));
      break;
    }
    case "request_update":
      affected = (await db.update(endpoints).set({ updateRequested: true }).where(inArray(endpoints.id, ids)).returning({ id: endpoints.id })).length;
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
        await db.update(endpoints).set({ tags: next }).where(eq(endpoints.id, h.id));
        affected++;
      }
      break;
    }
    case "enable_checks":
    case "disable_checks":
      affected = (await db.update(checks).set({ enabled: action === "enable_checks" }).where(endpointChecks).returning({ id: checks.id })).length;
      break;
    case "apply_suggestions": {
      const alertRule = parseAlertRule(req.body?.alertRule);
      for (const h of rows) affected += await applySuggestions(h.id, null, { alertRule });
      break;
    }
    case "wake":
      for (const h of rows) {
        if (!h.macAddress) {
          errors.push({ id: h.id, error: `${h.name}: no MAC address` });
          continue;
        }
        if (await siteCollectorFor(h.siteId)) {
          await queueCollectorJob(h.siteId, "wake", { mac: h.macAddress });
          affected++;
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
      await db.insert(maintenanceWindows).values({ name: String(req.body?.name || `Maintenance for ${rows.length} host(s)`), scope: "endpoint", targetIds: ids, startsAt: now, endsAt: new Date(now.getTime() + minutes * 60_000) });
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
