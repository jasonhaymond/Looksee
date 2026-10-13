import net from "node:net";
import type { Request } from "express";

// The caller's IP as Express resolved it — behind a reverse proxy this is
// only right when TRUST_PROXY names that proxy (see app.ts and .env.example).
export function clientIp(req: Request): string {
  return normalizeIp(req.ip ?? req.socket.remoteAddress ?? "");
}

export function normalizeIp(ip: string): string {
  const s = ip.trim();
  return s.startsWith("::ffff:") && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

// Accepts a bare IP or CIDR, v4 or v6. Returns null if it isn't one.
export function parseIpOrCidr(entry: string): { address: string; prefix: number; family: "ipv4" | "ipv6" } | null {
  const [addr, bits] = entry.trim().split("/");
  const family = net.isIPv4(addr) ? "ipv4" : net.isIPv6(addr) ? "ipv6" : null;
  if (!family) return null;
  const max = family === "ipv4" ? 32 : 128;
  const prefix = bits === undefined ? max : Number(bits);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > max) return null;
  return { address: addr, prefix, family };
}

export function buildList(entries: string[]): net.BlockList {
  const list = new net.BlockList();
  for (const e of entries) {
    const p = parseIpOrCidr(e);
    if (!p) continue;
    if (p.prefix === (p.family === "ipv4" ? 32 : 128)) list.addAddress(p.address, p.family);
    else list.addSubnet(p.address, p.prefix, p.family);
  }
  return list;
}

export function listHas(list: net.BlockList, ip: string): boolean {
  const n = normalizeIp(ip);
  const family = net.isIPv4(n) ? "ipv4" : net.isIPv6(n) ? "ipv6" : null;
  return family ? list.check(n, family) : false;
}

export function ipInList(ip: string, entries: string[]): boolean {
  return listHas(buildList(entries), ip);
}
