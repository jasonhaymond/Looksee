import { db } from "../../db/index.js";
import { events, flowRecords } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";
import type { Flow } from "./flows.js";
import { type EventInput, type FlowRow, FlowAggregator, portFromEnv, sourceAllowed, startListeners, stripMapped, syslogEvent, underRateLimit } from "./core.js";

export { parseSyslog, sourceAllowed } from "./core.js";

// Direct push: sites that send syslog/traps/flows straight to the engine's
// public address are identified by their public IPs (endpoints.publicIps).
// Cached briefly — every received packet consults it.
let siteIps: { at: number; map: Map<string, string> } | null = null;
async function siteByIp(): Promise<Map<string, string>> {
  if (!siteIps || Date.now() - siteIps.at > 60_000) {
    const rows = await db.query.endpoints.findMany();
    const map = new Map<string, string>();
    for (const e of rows) for (const ip of e.publicIps ?? []) map.set(ip.trim(), e.id);
    siteIps = { at: Date.now(), map };
  }
  return siteIps.map;
}
export function invalidateSiteIpCache() {
  siteIps = null;
}
// Synchronous view for the per-packet allow check; refreshed in the background.
let siteIpSnapshot = new Map<string, string>();

export async function storeEvents(list: EventInput[], endpointId: string | null) {
  if (!list.length) return;
  const map = endpointId ? null : await siteByIp();
  const rows = list.map((e) => ({
    source: e.source,
    sourceIp: e.sourceIp,
    severity: e.severity,
    facility: e.facility,
    message: e.message.slice(0, 4000),
    data: e.data,
    receivedAt: new Date(e.receivedAt),
    endpointId: endpointId ?? map!.get(e.sourceIp) ?? null,
  }));
  for (let i = 0; i < rows.length; i += 500) await db.insert(events).values(rows.slice(i, i + 500));
}

export async function storeFlows(rows: FlowRow[], endpointId: string | null) {
  if (!rows.length) return 0;
  const map = endpointId ? null : await siteByIp();
  const values = rows.map((r) => ({ ...r, bucket: new Date(r.bucket), endpointId: endpointId ?? map!.get(r.exporter) ?? null }));
  for (let i = 0; i < values.length; i += 500) await db.insert(flowRecords).values(values.slice(i, i + 500));
  return values.length;
}

// Kept as direct entry points for tests and callers that ingest outside the
// listeners.
export async function ingestSyslog(raw: string, sourceIp: string) {
  const e = syslogEvent(raw, sourceIp);
  if (e && underRateLimit(e.sourceIp)) await storeEvents([e], null);
}

const aggregator = new FlowAggregator();
export function addFlows(exporter: string, flows: Flow[]) {
  aggregator.add(exporter, flows);
}
export async function flushFlows(now = new Date()) {
  return storeFlows(aggregator.drain(now), null);
}

const describe = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function startReceivers() {
  const ports = { syslog: portFromEnv("SYSLOG_PORT", 1514), trap: portFromEnv("SNMP_TRAP_PORT", 1162), flow: portFromEnv("FLOW_PORT", 2055), sflow: portFromEnv("SFLOW_PORT", 6343) };
  const refresh = () =>
    siteByIp()
      .then((m) => (siteIpSnapshot = m))
      .catch(() => undefined);
  void refresh();
  const refresher = setInterval(refresh, 60_000);
  refresher.unref();
  const stop = startListeners({
    ports,
    flows: aggregator,
    allow: (ip) => sourceAllowed(ip) || siteIpSnapshot.has(stripMapped(ip)),
    onEvent: (e) => void storeEvents([e], null).catch(() => undefined),
    onError: (what, err) => logger.error("receivers", `${what} listener error: ${describe(err)}`, `The ${what} receiver stopped working — check that the port isn't already in use.`),
  });
  const flusher = setInterval(() => {
    flushFlows().catch((err) => logger.error("receivers", `Flow flush failed: ${describe(err)}`, "Collected flow data couldn't be saved this minute."));
  }, 60_000);
  flusher.unref();
  logger.info("receivers", `Receivers: syslog ${ports.syslog ?? "off"}, SNMP traps ${ports.trap ?? "off"}, NetFlow/IPFIX ${ports.flow ?? "off"}, sFlow ${ports.sflow ?? "off"}`, "Event and flow receivers started.");
  return () => {
    stop();
    clearInterval(flusher);
    clearInterval(refresher);
  };
}
