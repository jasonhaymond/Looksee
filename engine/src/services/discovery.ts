import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { discoveryScans } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { type DiscoveredDevice, type ScannedDevice, scanNetwork, suggestForDevice } from "./discoveryCore.js";

export { DISCOVERY_PORTS, MAX_SCAN_ADDRESSES, expandCidr, suggestForDevice, type DiscoveredDevice } from "./discoveryCore.js";

// Adds what only the engine knows (which devices are already hosts) plus the
// suggested checks, and stores the finished scan.
export async function completeScan(scanId: string, cidr: string, devices: ScannedDevice[]) {
  const knownHosts = await db.query.hosts.findMany();
  const results: DiscoveredDevice[] = devices.map((d) => ({
    ...d,
    knownHostId: knownHosts.find((h) => h.hostname && (h.hostname === d.ip || (d.hostname && h.hostname.toLowerCase() === d.hostname.toLowerCase())))?.id ?? null,
    suggestedChecks: suggestForDevice(d),
  }));
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
