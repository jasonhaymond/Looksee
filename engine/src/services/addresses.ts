import net from "node:net";
import { and, desc, eq, inArray, or, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { hosts, macIpHistory } from "../db/schema.js";
import { logger } from "../lib/logger.js";
import { normalizeMac } from "./probes/protocols.js";
import type { Snapshot } from "./hostMetrics.js";
import { type Config, type ProbeContext, type ProbeOutcome, numOr, str, up, warn } from "./probes/types.js";

// MAC -> IP sightings from every source that sees both (agent interface
// lists, discovery scans, ARP checks). A MAC that turns up with a new IP is
// an IP change; ip_change checks and the host's address history read this.

const VIRTUAL_IFACE = /^(docker|veth|br-|virbr|vmnet|vEthernet|tun|tap|wg|zt|tailscale|isatap|Teredo|Bluetooth|Local Area Connection\*|lo)/i;
const usableMac = (mac: string) => /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/.test(mac) && mac !== "00:00:00:00:00:00";
const usableIp = (ip: string) => (net.isIPv4(ip) && !ip.startsWith("169.254.") && !ip.startsWith("127.")) || (net.isIPv6(ip) && !/^(fe80|::1)/i.test(ip));

export async function recordSighting(input: { mac: string; ip: string; source: string; hostId?: string | null; endpointId?: string | null }) {
  const mac = normalizeMac(input.mac);
  const ip = input.ip.split("/")[0].trim();
  if (!usableMac(mac) || !usableIp(ip)) return;
  const now = new Date();
  const existing = await db.query.macIpHistory.findFirst({ where: and(eq(macIpHistory.mac, mac), eq(macIpHistory.ip, ip)) });
  if (existing) {
    await db
      .update(macIpHistory)
      .set({ lastSeenAt: now, source: input.source, ...(input.hostId ? { hostId: input.hostId } : {}), ...(input.endpointId ? { endpointId: input.endpointId } : {}) })
      .where(eq(macIpHistory.id, existing.id));
    return;
  }
  const others = await db.query.macIpHistory.findMany({ where: eq(macIpHistory.mac, mac), orderBy: desc(macIpHistory.lastSeenAt), limit: 1 });
  await db.insert(macIpHistory).values({ mac, ip, source: input.source, hostId: input.hostId ?? null, endpointId: input.endpointId ?? null, firstSeenAt: now, lastSeenAt: now }).onConflictDoNothing();
  if (others.length && net.isIPv4(ip) === net.isIPv4(others[0].ip)) {
    logger.info("addresses", `MAC ${mac} seen at new IP ${ip} (was ${others[0].ip}, via ${input.source})`, `Device ${mac} changed IP address from ${others[0].ip} to ${ip}.`, { mac, ip, previous: others[0].ip });
  }
}

// Agent interfaces: written at most every 10 minutes per host, since the
// snapshot arrives every 30 s and addresses rarely change.
const lastAgentWrite = new Map<string, number>();
export async function recordFromSnapshot(host: { id: string; endpointId: string; macAddress: string | null }, snap: Snapshot) {
  if (Date.now() - (lastAgentWrite.get(host.id) ?? 0) < 600_000) return;
  lastAgentWrite.set(host.id, Date.now());
  let primary: string | null = null;
  for (const n of snap.net ?? []) {
    // A disconnected adapter can still list its last address — not a sighting.
    if (!n.mac || !n.up || VIRTUAL_IFACE.test(n.name)) continue;
    for (const addr of n.addrs ?? []) {
      await recordSighting({ mac: n.mac, ip: addr, source: "agent", hostId: host.id, endpointId: host.endpointId });
      if (!primary && n.up && net.isIPv4(addr.split("/")[0]) && usableIp(addr.split("/")[0])) primary = normalizeMac(n.mac);
    }
  }
  // Fill in the host's MAC (Wake-on-LAN, IP tracking) the first time the
  // agent reveals it; never overwrite one entered by hand.
  if (!host.macAddress && primary) await db.update(hosts).set({ macAddress: primary }).where(eq(hosts.id, host.id));
}

export async function addressHistory(hostId: string) {
  const host = await db.query.hosts.findFirst({ where: eq(hosts.id, hostId) });
  const macs = host?.macAddress ? [normalizeMac(host.macAddress)] : [];
  return db.query.macIpHistory.findMany({
    where: macs.length ? or(eq(macIpHistory.hostId, hostId), inArray(macIpHistory.mac, macs)) : eq(macIpHistory.hostId, hostId),
    orderBy: desc(macIpHistory.lastSeenAt),
    limit: 200,
  });
}

// ip_change: warn (or down) for holdMinutes after a MAC shows up at a new
// address. The MAC is the check's own setting, else the host's MAC(s).
export async function probeIpChange(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  let macs = str(config, "mac") ? [normalizeMac(str(config, "mac"))] : [];
  if (!macs.length && ctx.hostId) {
    const host = await db.query.hosts.findFirst({ where: eq(hosts.id, ctx.hostId) });
    const rows = await db.selectDistinct({ mac: macIpHistory.mac }).from(macIpHistory).where(eq(macIpHistory.hostId, ctx.hostId));
    macs = [...new Set([...(host?.macAddress ? [normalizeMac(host.macAddress)] : []), ...rows.map((r) => r.mac)])];
  }
  if (!macs.length) return warn("No MAC address to watch — set one on the check or the host");
  const includeV6 = config.includeIpv6 === true || config.includeIpv6 === "true";
  const hold = numOr(config, "holdMinutes", 60) * 60_000;
  const severity = str(config, "severity", "warn") === "down" ? "down" : "warn";
  const changes: string[] = [];
  const current: string[] = [];
  let changes24h = 0;
  for (const mac of macs) {
    const rows = (await db.query.macIpHistory.findMany({ where: eq(macIpHistory.mac, mac), orderBy: desc(macIpHistory.lastSeenAt), limit: 50 })).filter((r) => includeV6 || net.isIPv4(r.ip));
    if (!rows.length) continue;
    const latest = rows[0];
    current.push(`${mac} at ${latest.ip}`);
    // Every address first seen in the last day is a change, except the
    // MAC's very first sighting.
    const oldest = rows.reduce((a, b) => (b.firstSeenAt < a.firstSeenAt ? b : a));
    changes24h += rows.filter((r) => r !== oldest && Date.now() - r.firstSeenAt.getTime() < 86_400_000).length;
    const previous = rows.slice(1).sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime())[0];
    if (previous && Date.now() - latest.firstSeenAt.getTime() < hold && latest.firstSeenAt > previous.firstSeenAt) changes.push(`${mac} changed from ${previous.ip} to ${latest.ip} (${Math.round((Date.now() - latest.firstSeenAt.getTime()) / 60_000)} min ago)`);
  }
  if (!current.length) return warn("No sightings of this MAC yet — the agent, a discovery scan or an ARP check records them");
  if (changes.length) return { status: severity, latencyMs: null, message: `IP changed: ${changes.join("; ")}`, value: Math.max(1, changes24h) };
  return up(current.join(", "), { value: Math.max(0, changes24h) });
}
