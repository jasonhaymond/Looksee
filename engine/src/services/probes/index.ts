import { applyThresholds } from "../thresholds.js";
import { type Config, type ProbeContext, type ProbeOutcome, warn } from "./types.js";
import { probeDns, probePing, probeSslCert, probeTcp } from "./basic.js";
import { probeHttp } from "./http.js";
import { probeArp, probeDhcp, probeDockerRegistry, probeGrpc, probeMqtt, probeNtp, probeProtocol, probeUdp, probeWebsocket } from "./protocols.js";
import { probeBrowser, probeDatabase, probeDomainExpiry, probeEmailRoundtrip, probePublicIp, probeTraceroute } from "./services.js";
import { probeSnmp, probeSnmpInterfaces } from "./snmp.js";
import { probeBmc, probeProxmox, probeVmware } from "./infra.js";
import { probeAppIntegration, probePrometheus, probeWebserverStatus } from "./apps.js";
import { probeAgentHeartbeat, probeAnomaly, probeDiskForecast, probeEventMatch, probePushStaleness } from "./internal.js";

export type { ProbeContext, ProbeOutcome } from "./types.js";

const PROBES: Record<string, (config: Config, ctx: ProbeContext) => Promise<ProbeOutcome> | ProbeOutcome> = {
  ping: probePing,
  tcp: probeTcp,
  http: probeHttp,
  dns: probeDns,
  ssl_cert: probeSslCert,
  snmp: probeSnmp,
  udp: probeUdp,
  protocol: probeProtocol,
  email_roundtrip: probeEmailRoundtrip,
  database: probeDatabase,
  traceroute: probeTraceroute,
  browser: probeBrowser,
  ntp: probeNtp,
  dhcp: probeDhcp,
  grpc: probeGrpc,
  mqtt: probeMqtt,
  websocket: probeWebsocket,
  docker_registry: probeDockerRegistry,
  arp_presence: probeArp,
  domain_expiry: probeDomainExpiry,
  public_ip: probePublicIp,
  snmp_interfaces: probeSnmpInterfaces,
  trap_match: (c) => probeEventMatch("snmp_trap", c),
  syslog_match: (c) => probeEventMatch("syslog", c),
  bmc: probeBmc,
  proxmox: probeProxmox,
  vmware: probeVmware,
  prometheus: probePrometheus,
  webserver_status: probeWebserverStatus,
  app_integration: probeAppIntegration,
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
  const full: ProbeContext = { checkId: "", hostId: null, intervalSeconds: 60, state: {}, ...ctx };
  const result = await fn(config, full);
  if (result.skip || type === "anomaly") return result;
  return applyThresholds(result, config);
}
