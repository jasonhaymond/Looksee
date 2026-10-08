import { applyThresholds } from "../thresholds.js";
import { type Config, type ProbeContext, type ProbeOutcome, warn } from "./types.js";
import { NETWORK_PROBES } from "./network.js";
import { probeAgentHeartbeat, probeAnomaly, probeDiskForecast, probeEventMatch, probePushStaleness } from "./internal.js";

export type { ProbeContext, ProbeOutcome } from "./types.js";

// Network probes (also runnable by a site collector) plus the engine-local
// ones that read the database.
const PROBES: Record<string, (config: Config, ctx: ProbeContext) => Promise<ProbeOutcome> | ProbeOutcome> = {
  ...NETWORK_PROBES,
  trap_match: (c, ctx) => probeEventMatch("snmp_trap", c, ctx),
  syslog_match: (c, ctx) => probeEventMatch("syslog", c, ctx),
  anomaly: probeAnomaly,
  heartbeat: probePushStaleness,
  push_value: probePushStaleness,
  agent_heartbeat: probeAgentHeartbeat,
  disk_forecast: probeDiskForecast,
};

export const PROBE_TYPES = Object.keys(PROBES);

// Thresholds are applied here, once, for every engine-run type. anomaly is
// the exception: its value is a z-score already judged by its own
// sensitivity setting.
export async function runProbe(type: string, config: Config, ctx?: Partial<ProbeContext>): Promise<ProbeOutcome> {
  const fn = PROBES[type];
  if (!fn) return warn(`Unknown agentless check type: ${type}`);
  const full: ProbeContext = { checkId: "", hostId: null, endpointId: null, intervalSeconds: 60, state: {}, ...ctx };
  const result = await fn(config, full);
  if (result.skip || type === "anomaly") return result;
  return applyThresholds(result, config);
}
