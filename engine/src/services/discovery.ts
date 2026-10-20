// Network discovery run by the engine itself: scans a subnet in the
// background (services/discoveryCore.ts does the probing) and stores what it
// finds, marking devices that are already endpoints. Site collectors run the
// same scan on their own network and report back through routes/collector.ts.

import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { discoveryScans } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { normalizeMac } from "./probes/protocols.js";
import { recordSighting } from "./addresses.js";
import { type DiscoveredDevice, type ScannedDevice, scanNetwork, suggestForDevice } from "./discoveryCore.js";
import { BUILTIN_TEMPLATES, type SnmpTemplate, type TemplateItem, templatesForDevice } from "./snmpTemplates.js";

export { DISCOVERY_PORTS, MAX_SCAN_ADDRESSES, expandCidr, suggestForDevice, type DiscoveredDevice } from "./discoveryCore.js";

/**
 * Finishes a scan (the engine's own, or one a site collector reported):
 * adds what only the engine knows — which devices are already endpoints,
 * and which SNMP templates fit each device — plus the suggested checks,
 * records every MAC/IP pair seen, and stores the result.
 *
 * @param scanId the discovery_scans row to complete
 * @param cidr the subnet scanned (for the log line)
 * @param devices what the scan found
 */
export async function completeScan(scanId: string, cidr: string, devices: ScannedDevice[]) {
  const knownEndpoints = await db.query.endpoints.findMany();
  // Built-in plus the admin's own SNMP templates, for "suggest for" matching.
  const ownTemplates = await db.query.snmpTemplates.findMany();
  const templates: SnmpTemplate[] = [
    ...ownTemplates.map((t) => ({ id: t.id, name: t.name, description: t.description, matchSysObjectId: t.matchSysObjectId, items: t.items as TemplateItem[], builtIn: false })),
    ...BUILTIN_TEMPLATES,
  ];
  const scan = await db.query.discoveryScans.findFirst({ where: eq(discoveryScans.id, scanId) });
  const sameMac = (a: string | null, b: string | null) => Boolean(a && b && normalizeMac(a) === normalizeMac(b));
  const results: DiscoveredDevice[] = devices.map((d) => ({
    ...d,
    // A known MAC identifies the host even after its IP changed.
    knownEndpointId: knownEndpoints.find((h) => sameMac(h.macAddress, d.mac) || (h.hostname && (h.hostname === d.ip || (d.hostname && h.hostname.toLowerCase() === d.hostname.toLowerCase()))))?.id ?? null,
    suggestedChecks: suggestForDevice(d),
    snmpTemplates: templatesForDevice(d.snmp?.sysObjectId, templates),
  }));
  for (const d of results) if (d.mac) await recordSighting({ mac: d.mac, ip: d.ip, source: "discovery", endpointId: d.knownEndpointId, siteId: scan?.siteId ?? null });
  await db.update(discoveryScans).set({ results, status: "done", error: null, finishedAt: new Date() }).where(eq(discoveryScans.id, scanId));
  logger.info("discovery", `Scan of ${cidr} found ${results.length} device(s)`, `Network scan of ${cidr} finished: ${results.length} device(s) found.`, { scanId });
}

export async function failScan(scanId: string, message: string) {
  await db.update(discoveryScans).set({ status: "error", error: message, finishedAt: new Date() }).where(eq(discoveryScans.id, scanId));
}

export async function runDiscoveryScan(scanId: string, cidr: string, community = "public") {
  try {
    const devices = await scanNetwork(cidr, community, async (found) => {
      await db.update(discoveryScans).set({ results: found }).where(eq(discoveryScans.id, scanId));
    });
    await completeScan(scanId, cidr, devices);
  } catch (err) {
    await failScan(scanId, err instanceof Error ? err.message : String(err));
  }
}
