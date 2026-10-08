import { Router } from "express";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, collectorJobs, discoveryScans, endpoints, hosts } from "../db/schema.js";
import { COLLECTOR_CHECK_TYPES } from "../db/checkTypes.js";
import { requireAgentAuth } from "../middleware/auth.js";
import { recordCheckResult } from "../services/alerting.js";
import { completeScan, failScan } from "../services/discovery.js";
import { storeEvents, storeFlows } from "../services/receivers/index.js";
import type { EventInput, FlowRow } from "../services/receivers/core.js";
import type { ScannedDevice } from "../services/discoveryCore.js";
import { logger } from "../lib/logger.js";

// The API a site collector calls, authenticated with its host's agent key.
// Everything is a request the collector makes outbound over HTTPS, so a
// remote site needs no inbound ports or VPN to the engine.
export const collectorRouter = Router();
collectorRouter.use(requireAgentAuth);

const STATUSES = new Set(["up", "down", "warn", "unknown"]);

function portSetting(name: string, fallback: number): number | null {
  const raw = process.env[name];
  if (raw === "0" || raw === "off") return null;
  const n = Number(raw ?? fallback);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : fallback;
}

// The endpoints this host collects for; the first is where its received
// events are filed (event matching treats all of them as one site).
async function sitesFor(hostId: string) {
  return db.query.endpoints.findMany({ where: eq(endpoints.collectorHostId, hostId), orderBy: asc(endpoints.createdAt) });
}

collectorRouter.use(async (req, res, next) => {
  const sites = await sitesFor(req.agentHost!.id);
  if (!sites.length) {
    res.status(403).json({ error: "This host isn't the site collector for any endpoint" });
    return;
  }
  res.locals.sites = sites;
  next();
});

const siteIds = (res: { locals: Record<string, unknown> }) => (res.locals.sites as (typeof endpoints.$inferSelect)[]).map((e) => e.id);

// GET /api/collector/config?version=&error=
// Polled every ~15s. Returns the checks to run (with real, unmasked config —
// the collector has to authenticate to the devices), receiver ports, and any
// one-off work: queued discovery scans and Wake-on-LAN jobs, which are marked
// handed-out as they're returned.
collectorRouter.get("/config", async (req, res) => {
  const hostId = req.agentHost!.id;
  const ids = siteIds(res);
  const version = typeof req.query.version === "string" ? req.query.version.slice(0, 40) : null;
  const error = typeof req.query.error === "string" && req.query.error ? req.query.error.slice(0, 1000) : null;
  await db.update(hosts).set({ collectorLastSeenAt: new Date(), collectorVersion: version, collectorError: error }).where(eq(hosts.id, hostId));

  const rows = await db.query.checks.findMany({
    where: and(inArray(checks.endpointId, ids), inArray(checks.type, COLLECTOR_CHECK_TYPES), eq(checks.enabled, true), isNull(checks.probeHostId)),
  });
  const scans = await db.update(discoveryScans).set({ status: "running" }).where(and(inArray(discoveryScans.endpointId, ids), eq(discoveryScans.status, "queued"))).returning();
  const jobs = await db.update(collectorJobs).set({ status: "sent" }).where(and(inArray(collectorJobs.endpointId, ids), eq(collectorJobs.status, "queued"))).returning();

  res.json({
    pollSeconds: 15,
    sites: (res.locals.sites as (typeof endpoints.$inferSelect)[]).map((e) => ({ id: e.id, name: e.name })),
    checks: rows.map((c) => ({
      id: c.id,
      type: c.type,
      config: c.config,
      intervalSeconds: c.intervalSeconds,
      retryIntervalSeconds: c.retryIntervalSeconds,
      lastStatus: c.lastStatus,
      // null asks for an immediate run ("Run now" in the dashboard)
      lastRunAt: c.lastRunAt?.toISOString() ?? null,
      state: c.state ?? {},
      createdAt: c.createdAt.toISOString(),
    })),
    receivers: {
      syslog: portSetting("COLLECTOR_SYSLOG_PORT", 1514),
      trap: portSetting("COLLECTOR_TRAP_PORT", 1162),
      flow: portSetting("COLLECTOR_FLOW_PORT", 2055),
      sflow: portSetting("COLLECTOR_SFLOW_PORT", 6343),
      allowedSources: process.env.COLLECTOR_ALLOWED_SOURCES || null,
    },
    scans: scans.map((s) => ({ id: s.id, cidr: s.cidr, community: s.community ?? "public" })),
    jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, payload: j.payload })),
  });
});

type PostedResult = { checkId?: unknown; status?: unknown; message?: unknown; latencyMs?: unknown; value?: unknown; details?: unknown; state?: unknown; ranAt?: unknown };
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// POST /api/collector/results { results: [...] }
// Results for checks the collector no longer owns (moved, disabled, deleted
// since its last config poll) are ignored, not errors.
collectorRouter.post("/results", async (req, res) => {
  const list: PostedResult[] = Array.isArray(req.body?.results) ? req.body.results.slice(0, 2000) : [];
  const ids = siteIds(res);
  const wanted = [...new Set(list.map((r) => String(r.checkId ?? "")).filter(Boolean))];
  const owned = wanted.length
    ? await db.query.checks.findMany({ where: and(inArray(checks.id, wanted), inArray(checks.endpointId, ids), inArray(checks.type, COLLECTOR_CHECK_TYPES), isNull(checks.probeHostId)) })
    : [];
  const ownedIds = new Set(owned.map((c) => c.id));
  let accepted = 0;
  for (const r of list) {
    const checkId = String(r.checkId ?? "");
    if (!ownedIds.has(checkId) || !STATUSES.has(String(r.status))) continue;
    const ranAt = typeof r.ranAt === "string" && !Number.isNaN(Date.parse(r.ranAt)) ? new Date(r.ranAt) : new Date();
    const update: Partial<typeof checks.$inferInsert> = { lastRunAt: ranAt };
    if (r.state && typeof r.state === "object") update.state = r.state as Record<string, unknown>;
    await db.update(checks).set(update).where(eq(checks.id, checkId));
    await recordCheckResult(checkId, {
      status: r.status as "up" | "down" | "warn" | "unknown",
      message: typeof r.message === "string" ? r.message.slice(0, 4000) : null,
      latencyMs: num(r.latencyMs),
      value: num(r.value),
      details: r.details ?? null,
    });
    accepted++;
  }
  res.json({ accepted });
});

const EVENT_SOURCES = new Set(["syslog", "snmp_trap"]);

// POST /api/collector/events { events: [...], flows: [...] }
// Traps/syslog/flows the collector received on its LAN, filed under its site.
collectorRouter.post("/events", async (req, res) => {
  const site = siteIds(res)[0];
  const evs: EventInput[] = (Array.isArray(req.body?.events) ? req.body.events.slice(0, 5000) : [])
    .filter((e: Partial<EventInput>) => e && EVENT_SOURCES.has(String(e.source)) && typeof e.sourceIp === "string" && typeof e.message === "string")
    .map((e: EventInput) => ({
      source: e.source,
      sourceIp: e.sourceIp.slice(0, 64),
      severity: num(e.severity),
      facility: num(e.facility),
      message: e.message,
      data: e.data && typeof e.data === "object" ? e.data : null,
      receivedAt: typeof e.receivedAt === "string" && !Number.isNaN(Date.parse(e.receivedAt)) ? e.receivedAt : new Date().toISOString(),
    }));
  const flows: FlowRow[] = (Array.isArray(req.body?.flows) ? req.body.flows.slice(0, 20000) : [])
    .filter((f: Partial<FlowRow>) => f && typeof f.exporter === "string" && typeof f.srcAddr === "string" && typeof f.dstAddr === "string" && typeof f.bucket === "string" && !Number.isNaN(Date.parse(f.bucket)))
    .map((f: FlowRow) => ({ bucket: f.bucket, exporter: f.exporter, srcAddr: f.srcAddr, dstAddr: f.dstAddr, protocol: num(f.protocol) ?? 0, dstPort: num(f.dstPort) ?? 0, bytes: num(f.bytes) ?? 0, packets: num(f.packets) ?? 0 }));
  await storeEvents(evs, site);
  await storeFlows(flows, site);
  res.json({ events: evs.length, flows: flows.length });
});

// POST /api/collector/scans/:id { devices?, done?, error? }
// devices without done = progress so far; done = the finished list.
collectorRouter.post("/scans/:id", async (req, res) => {
  const scan = await db.query.discoveryScans.findFirst({ where: and(eq(discoveryScans.id, req.params.id), inArray(discoveryScans.endpointId, siteIds(res))) });
  if (!scan) {
    res.status(404).json({ error: "Scan not found for this collector" });
    return;
  }
  const devices: ScannedDevice[] = Array.isArray(req.body?.devices) ? req.body.devices.slice(0, 1024) : [];
  if (typeof req.body?.error === "string" && req.body.error) await failScan(scan.id, req.body.error.slice(0, 1000));
  else if (req.body?.done) await completeScan(scan.id, scan.cidr, devices);
  else await db.update(discoveryScans).set({ results: devices }).where(eq(discoveryScans.id, scan.id));
  res.json({ ok: true });
});

// POST /api/collector/jobs/:id { ok, message }
collectorRouter.post("/jobs/:id", async (req, res) => {
  const ok = Boolean(req.body?.ok);
  const message = typeof req.body?.message === "string" ? req.body.message.slice(0, 1000) : null;
  const [job] = await db
    .update(collectorJobs)
    .set({ status: ok ? "done" : "error", result: message, finishedAt: new Date() })
    .where(and(eq(collectorJobs.id, req.params.id), inArray(collectorJobs.endpointId, siteIds(res))))
    .returning();
  if (!job) {
    res.status(404).json({ error: "Job not found for this collector" });
    return;
  }
  if (!ok) logger.warn("collector", `Collector job ${job.id} (${job.kind}) failed: ${message}`, `A ${job.kind} request sent through a site collector failed: ${message}`, { jobId: job.id });
  res.json({ ok: true });
});
