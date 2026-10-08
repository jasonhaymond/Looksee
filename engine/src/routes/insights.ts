import { Router } from "express";
import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { discoveryScans, events, endpoints, hosts, checks } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { MAX_SCAN_ADDRESSES, expandCidr, runDiscoveryScan } from "../services/discovery.js";

// ?site= on events/flows: "local" = received on the engine's own network,
// an endpoint id = that remote site (its collector or direct push).
const UUID_RE = /^[0-9a-f-]{36}$/i;
function siteFilter(site: unknown) {
  if (site === "local") return sql`endpoint_id IS NULL`;
  if (typeof site === "string" && UUID_RE.test(site)) return sql`endpoint_id = ${site}`;
  return null;
}

// Read-mostly views over collected data: SLA reports (L7), received
// traps/syslog (H3/H5), flow top talkers (H6), and network discovery (H7).
export const insightsRouter = Router();
insightsRouter.use(requireAuth);

type SlaRow = {
  check_id: string;
  name: string;
  type: string;
  endpoint_id: string;
  total_s: number | null;
  down_s: number | null;
  warn_s: number | null;
  maint_s: number | null;
  avg_latency: number | null;
  incidents: number;
  results: number;
};

// Time-weighted: each result "owns" the time until the next one (capped at
// twice the check interval, so a gap in data isn't counted as uptime or
// downtime). Maintenance time is reported separately and excluded.
insightsRouter.get("/reports/sla", async (req, res) => {
  const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 400);
  const endpointId = typeof req.query.endpointId === "string" && req.query.endpointId ? req.query.endpointId : null;
  const since = new Date(Date.now() - days * 86_400_000);
  const rows = (
    await db.execute<SlaRow>(sql`
      WITH r AS (
        SELECT cr.check_id, cr.status, cr.latency_ms, cr.in_maintenance,
               LEAST(EXTRACT(EPOCH FROM (COALESCE(LEAD(cr.checked_at) OVER w, now()) - cr.checked_at)), c.interval_seconds * 2) AS dur,
               LAG(cr.status) OVER w AS prev
        FROM check_results cr JOIN checks c ON c.id = cr.check_id
        WHERE cr.checked_at >= ${since} ${endpointId ? sql`AND c.endpoint_id = ${endpointId}` : sql``}
        WINDOW w AS (PARTITION BY cr.check_id ORDER BY cr.checked_at)
      )
      SELECT r.check_id, c.name, c.type::text AS type, c.endpoint_id,
             sum(dur) FILTER (WHERE NOT in_maintenance)::float AS total_s,
             sum(dur) FILTER (WHERE status = 'down' AND NOT in_maintenance)::float AS down_s,
             sum(dur) FILTER (WHERE status = 'warn' AND NOT in_maintenance)::float AS warn_s,
             sum(dur) FILTER (WHERE in_maintenance)::float AS maint_s,
             avg(latency_ms)::float AS avg_latency,
             count(*) FILTER (WHERE status = 'down' AND (prev IS NULL OR prev <> 'down') AND NOT in_maintenance)::int AS incidents,
             count(*)::int AS results
      FROM r JOIN checks c ON c.id = r.check_id
      GROUP BY r.check_id, c.name, c.type, c.endpoint_id
      ORDER BY c.name`)
  ).rows;
  const report = rows.map((r) => {
    const total = r.total_s ?? 0;
    const down = r.down_s ?? 0;
    return {
      checkId: r.check_id,
      name: r.name,
      type: r.type,
      endpointId: r.endpoint_id,
      uptimePercent: total > 0 ? Math.round(((total - down) / total) * 100000) / 1000 : null,
      downtimeMinutes: Math.round(down / 60),
      degradedMinutes: Math.round((r.warn_s ?? 0) / 60),
      maintenanceMinutes: Math.round((r.maint_s ?? 0) / 60),
      incidents: r.incidents,
      avgLatencyMs: r.avg_latency != null ? Math.round(r.avg_latency) : null,
      results: r.results,
    };
  });
  if (req.query.format === "csv") {
    const header = "check,type,uptime_percent,downtime_minutes,degraded_minutes,maintenance_minutes,incidents,avg_latency_ms,results";
    const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
    const lines = report.map((r) => [esc(r.name), r.type, r.uptimePercent ?? "", r.downtimeMinutes, r.degradedMinutes, r.maintenanceMinutes, r.incidents, r.avgLatencyMs ?? "", r.results].join(","));
    res.type("text/csv").setHeader("Content-Disposition", `attachment; filename="looksee-sla-${days}d.csv"`).send([header, ...lines].join("\n"));
    return;
  }
  res.json({ days, since: since.toISOString(), checks: report });
});

insightsRouter.get("/events", async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 200, 1000);
  const conds = [];
  if (req.query.source === "snmp_trap" || req.query.source === "syslog") conds.push(eq(events.source, req.query.source));
  if (typeof req.query.sourceIp === "string" && req.query.sourceIp) conds.push(eq(events.sourceIp, req.query.sourceIp));
  if (typeof req.query.q === "string" && req.query.q) conds.push(sql`${events.message} ILIKE ${`%${req.query.q}%`}`);
  if (req.query.maxSeverity !== undefined && req.query.maxSeverity !== "") conds.push(sql`${events.severity} <= ${Number(req.query.maxSeverity)}`);
  const site = siteFilter(req.query.site);
  if (site) conds.push(site);
  const rows = await db.select().from(events).where(conds.length ? and(...conds) : undefined).orderBy(desc(events.receivedAt)).limit(limit);
  res.json(rows);
});

insightsRouter.get("/flows/top", async (req, res) => {
  const minutes = Math.min(Math.max(Number(req.query.minutes) || 60, 1), 7 * 1440);
  const limit = Math.min(Number(req.query.limit) || 20, 200);
  const by = String(req.query.by ?? "pair");
  const exporter = typeof req.query.exporter === "string" && req.query.exporter ? req.query.exporter : null;
  const site = siteFilter(req.query.site);
  const group =
    by === "src" ? sql`src_addr AS label` : by === "dst" ? sql`dst_addr AS label` : by === "port" ? sql`(CASE protocol WHEN 6 THEN 'tcp/' WHEN 17 THEN 'udp/' ELSE protocol::text || '/' END) || dst_port AS label` : sql`src_addr || ' → ' || dst_addr AS label`;
  const rows = (
    await db.execute<{ label: string; bytes: number; packets: number }>(sql`
      SELECT ${group}, sum(bytes)::float AS bytes, sum(packets)::float AS packets
      FROM flow_records
      WHERE bucket > now() - (${minutes} || ' minutes')::interval ${exporter ? sql`AND exporter = ${exporter}` : sql``} ${site ? sql`AND ${site}` : sql``}
      GROUP BY 1 ORDER BY bytes DESC LIMIT ${limit}`)
  ).rows;
  const seconds = minutes * 60;
  res.json(rows.map((r) => ({ label: r.label, bytes: r.bytes, packets: r.packets, avgMbps: Math.round(((r.bytes * 8) / seconds / 1e6) * 1000) / 1000 })));
});

insightsRouter.get("/flows/exporters", async (_req, res) => {
  const rows = (await db.execute<{ exporter: string; last: string }>(sql`SELECT exporter, max(bucket) AS last FROM flow_records GROUP BY exporter ORDER BY exporter`)).rows;
  res.json(rows);
});

insightsRouter.get("/discovery/scans", async (_req, res) => {
  res.json(await db.query.discoveryScans.findMany({ orderBy: desc(discoveryScans.startedAt), limit: 20 }));
});

insightsRouter.get("/discovery/scans/:id", async (req, res) => {
  const scan = await db.query.discoveryScans.findFirst({ where: eq(discoveryScans.id, req.params.id) });
  if (!scan) {
    res.status(404).json({ error: "Scan not found" });
    return;
  }
  res.json(scan);
});

insightsRouter.post("/discovery/scans", async (req, res) => {
  const cidr = String(req.body?.cidr ?? "").trim();
  try {
    if (expandCidr(cidr).length > MAX_SCAN_ADDRESSES) throw new Error("Range too large");
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const community = String(req.body?.community || "public");
  // A scan for an endpoint with a site collector runs on that site's LAN.
  const endpointId = typeof req.body?.endpointId === "string" && req.body.endpointId ? req.body.endpointId : null;
  const site = endpointId ? await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) }) : null;
  if (endpointId && !site) {
    res.status(400).json({ error: "endpointId not found" });
    return;
  }
  const viaCollector = Boolean(site?.collectorHostId);
  // One scan at a time per network: the engine's own LAN, or each collector site.
  const active = await db.query.discoveryScans.findMany({ where: and(inArray(discoveryScans.status, ["running", "queued"]), gte(discoveryScans.startedAt, new Date(Date.now() - 30 * 60_000))) });
  const collectorSites = new Set((await db.query.endpoints.findMany()).filter((e) => e.collectorHostId).map((e) => e.id));
  const running = active.find((s) => (viaCollector ? s.endpointId === endpointId : !s.endpointId || !collectorSites.has(s.endpointId)));
  if (running) {
    res.status(409).json({ error: `A scan of ${running.cidr} is already running` });
    return;
  }
  const [scan] = await db.insert(discoveryScans).values({ cidr, endpointId, community, status: viaCollector ? "queued" : "running" }).returning();
  if (!viaCollector) void runDiscoveryScan(scan.id, cidr, community);
  res.status(202).json(scan);
});

// Adds chosen devices from a finished scan: optionally a host row each
// (with its MAC for Wake-on-LAN), plus whichever suggested checks were ticked.
insightsRouter.post("/discovery/scans/:id/add", async (req, res) => {
  const endpointId = String(req.body?.endpointId ?? "");
  if (!(await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) }))) {
    res.status(400).json({ error: "endpointId not found" });
    return;
  }
  const devices: { ip: string; name?: string; mac?: string | null; createHost?: boolean; checks?: { type: string; name: string; config: Record<string, unknown> }[] }[] = Array.isArray(req.body?.devices) ? req.body.devices : [];
  let hostsCreated = 0;
  let checksCreated = 0;
  for (const d of devices) {
    let hostId: string | null = null;
    if (d.createHost) {
      const [h] = await db.insert(hosts).values({ endpointId, name: d.name || d.ip, hostname: d.ip, macAddress: d.mac ?? null }).returning();
      hostId = h.id;
      hostsCreated++;
    }
    for (const c of d.checks ?? []) {
      await db.insert(checks).values({ endpointId, hostId, name: c.name, type: c.type as typeof checks.$inferInsert.type, config: c.config ?? {} });
      checksCreated++;
    }
  }
  res.json({ hostsCreated, checksCreated });
});
