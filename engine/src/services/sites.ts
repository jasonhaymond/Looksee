import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { collectorJobs, sites, type checks } from "../db/schema.js";
import { COLLECTOR_CHECK_TYPES } from "../db/checkTypes.js";

const COLLECTOR_TYPES = new Set<string>(COLLECTOR_CHECK_TYPES);

// Where scripts/build-collector.sh puts the collector bundle and the Node
// runtimes the agents download (gitignored, like the agent binaries).
export const collectorDistDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "agent", "bin", "collector");

export type CollectorManifest = {
  version: string;
  node: string;
  bundle: { file: string; sha256: string };
  runtimes: Record<string, { file: string; sha256: string }>;
};

let manifestCache: { at: number; value: CollectorManifest | null } | null = null;
export function collectorManifest(): CollectorManifest | null {
  if (manifestCache && Date.now() - manifestCache.at < 30_000) return manifestCache.value;
  let value: CollectorManifest | null = null;
  try {
    value = JSON.parse(fs.readFileSync(path.join(collectorDistDir, "manifest.json"), "utf-8"));
  } catch {
    value = null;
  }
  manifestCache = { at: Date.now(), value };
  return value;
}

export async function siteCollectorFor(siteId: string): Promise<string | null> {
  const ep = await db.query.sites.findFirst({ where: eq(sites.id, siteId) });
  return ep?.collectorEndpointId ?? null;
}

// Whether a check is run by its endpoint's site collector rather than the engine.
export async function runsOnCollector(check: typeof checks.$inferSelect): Promise<boolean> {
  if (!COLLECTOR_TYPES.has(check.type) || check.probeEndpointId) return false;
  return Boolean(await siteCollectorFor(check.siteId));
}

export async function queueCollectorJob(siteId: string, kind: "wake" | "snmp_walk", payload: Record<string, unknown>) {
  const [job] = await db.insert(collectorJobs).values({ siteId, kind, payload }).returning();
  return job;
}
