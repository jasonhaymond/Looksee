import { applyThresholds } from "../thresholds.js";
import { type Config, type ProbeContext, type ProbeOutcome, warn } from "./types.js";
import { probeDns, probePing, probeSslCert, probeTcp } from "./basic.js";
import { probeHttp } from "./http.js";
import { probeArp, probeDhcp, probeDockerRegistry, probeGrpc, probeMqtt, probeNtp, probeProtocol, probeUdp, probeWebsocket } from "./protocols.js";
import { probeBrowser, probeDatabase, probeDomainExpiry, probeEmailRoundtrip, probePublicIp, probeTraceroute } from "./services.js";
import { probeSnmp, probeSnmpInterfaces } from "./snmp.js";
import { probeBmc, probeProxmox, probeVmware } from "./infra.js";
import { probeAppIntegration, probePrometheus, probeWebserverStatus } from "./apps.js";

// Probes that only talk to the network — no database access — so a site
// collector can run them from inside a remote LAN (collector.ts imports
// only this file, never the engine's DB layer).
export const NETWORK_PROBES: Record<string, (config: Config, ctx: ProbeContext) => Promise<ProbeOutcome> | ProbeOutcome> = {
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
  bmc: probeBmc,
  proxmox: probeProxmox,
  vmware: probeVmware,
  prometheus: probePrometheus,
  webserver_status: probeWebserverStatus,
  app_integration: probeAppIntegration,
};

export async function runNetworkProbe(type: string, config: Config, ctx?: Partial<ProbeContext>): Promise<ProbeOutcome> {
  const fn = NETWORK_PROBES[type];
  if (!fn) return warn(`Unknown network check type: ${type}`);
  const full: ProbeContext = { checkId: "", hostId: null, intervalSeconds: 60, state: {}, ...ctx };
  const result = await fn(config, full);
  return result.skip ? result : applyThresholds(result, config);
}
