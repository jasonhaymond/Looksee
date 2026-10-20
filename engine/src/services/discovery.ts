import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { discoveryScans } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { normalizeMac } from "./probes/protocols.js";
import { recordSighting } from "./addresses.js";
import { type DiscoveredDevice, type ScannedDevice, scanNetwork, suggestForDevice } from "./discoveryCore.js";

export { DISCOVERY_PORTS, MAX_SCAN_ADDRESSES, expandCidr, suggestForDevice, type DiscoveredDevice } from "./discoveryCore.js";

// Adds what only the engine knows (which devices are already endpoints) plus the
// suggested checks, and stores the finished scan.
export async function completeScan(scanId: string, cidr: string, devices: ScannedDevice[]) {
  const knownEndpoints = await db.query.endpoints.findMany();
  const scan = await db.query.discoveryScans.findFirst({ where: eq(discoveryScans.id, scanId) });
  const sameMac = (a: string | null, b: string | null) => Boolean(a && b && normalizeMac(a) === normalizeMac(b));
  const results: DiscoveredDevice[] = devices.map((d) => ({
    ...d,
    // A known MAC identifies the host even after its IP changed.
    knownEndpointId: knownEndpoints.find((h) => sameMac(h.macAddress, d.mac) || (h.hostname && (h.hostname === d.ip || (d.hostname && h.hostname.toLowerCase() === d.hostname.toLowerCase()))))?.id ?? null,
    suggestedChecks: suggestForDevice(d),
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
