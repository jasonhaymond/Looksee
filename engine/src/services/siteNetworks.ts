// Site address ranges (sites.networks): checking that a range is written
// correctly, and finding which site an address belongs to.
//
// Where this sits: routes/sites.ts validates ranges when a site is saved;
// routes/collector.ts files the syslog/traps/flows a collector receives under
// the right site when that collector serves several sites; the engine's own
// receivers (receivers/index.ts) do the same for sites without a collector.
// No database access here — callers pass the sites in.
//
// A range is CIDR notation: an address, a slash, and how many leading bits
// are the network part. "10.20.0.0/24" is 10.20.0.0–10.20.0.255; a bare
// address ("10.20.0.5") means that one address. IPv6 works the same way
// ("fd00:1::/64"). Matching uses Node's built-in net.BlockList, which
// compares the numbers rather than the text, so "10.20.0.05"-style tricks and
// IPv4-mapped IPv6 addresses ("::ffff:10.20.0.5") can't slip past it.

import net from "node:net";

/** A site as this module needs it: its ID and its address ranges. */
export type SiteRanges = { id: string; networks: string[] };

/** One parsed range: the address family, network address and prefix length. */
type ParsedRange = { family: "ipv4" | "ipv6"; address: string; prefix: number };

/**
 * Parses one range ("10.20.0.0/24", "fd00::/64", or a single address).
 *
 * @param text the range as typed
 * @returns the parsed range, or null if it isn't valid CIDR notation
 */
export function parseRange(text: string): ParsedRange | null {
  const [address, bits, extra] = text.trim().split("/");
  // More than one "/" can't be a range.
  if (extra !== undefined || !address) return null;
  const version = net.isIP(address);
  if (version === 0) return null;
  const max = version === 4 ? 32 : 128;
  // No "/n" means a single address (/32 or /128). Otherwise the prefix must
  // be a plain whole number in range — /^\d{1,3}$/ matches "24" but not "24x"
  // or "-1".
  if (bits !== undefined && !/^\d{1,3}$/.test(bits)) return null;
  const prefix = bits === undefined ? max : Number(bits);
  if (prefix > max) return null;
  return { family: version === 4 ? "ipv4" : "ipv6", address, prefix };
}

/**
 * Cleans a site's ranges from a form or API body: one per line or separated
 * by commas/spaces, duplicates removed.
 *
 * @param value an array of strings, or text
 * @returns the ranges, or an error naming the first one that isn't valid
 */
export function cleanRanges(value: unknown): { ranges: string[] } | { error: string } {
  const raw = Array.isArray(value) ? value.map(String) : String(value ?? "").split(/[\s,]+/);
  const ranges = [...new Set(raw.map((r) => r.trim()).filter(Boolean))];
  // A site with hundreds of ranges is a typo or an abuse of the field.
  if (ranges.length > 100) return { error: "At most 100 address ranges per site" };
  const bad = ranges.find((r) => !parseRange(r));
  if (bad) return { error: `"${bad}" isn't an address range — use CIDR notation like 10.20.0.0/24` };
  return { ranges };
}

/**
 * Turns an IPv4-mapped IPv6 address ("::ffff:10.0.0.5", how a dual-stack
 * socket reports an IPv4 sender) into the plain IPv4 address, so it matches
 * IPv4 ranges. Anything else is returned trimmed and unchanged.
 */
function plainAddress(ip: string): string {
  const trimmed = ip.trim();
  // "::ffff:" followed by a dotted IPv4 address (checked by net.isIPv4, no
  // regular expression needed).
  const rest = trimmed.slice(7);
  return trimmed.toLowerCase().startsWith("::ffff:") && net.isIPv4(rest) ? rest : trimmed;
}

/**
 * Which of the given sites an address belongs to, by their ranges. When
 * ranges overlap (a /16 on one site, a /24 inside it on another), the most
 * specific range — the longest prefix — wins, like a router's routing table.
 *
 * @param ip the sender's address
 * @param sites candidate sites with their ranges
 * @returns the matching site's ID, or null when no range holds the address
 */
export function siteForAddress(ip: string, sites: SiteRanges[]): string | null {
  const address = plainAddress(ip);
  const version = net.isIP(address);
  if (version === 0) return null;
  const family = version === 4 ? "ipv4" : "ipv6";
  let best: { id: string; prefix: number } | null = null;
  for (const site of sites) {
    for (const text of site.networks ?? []) {
      const range = parseRange(text);
      // Skip ranges of the other family, and ones that can't beat the best
      // match so far.
      if (!range || range.family !== family || (best && range.prefix <= best.prefix)) continue;
      // A BlockList holding just this range answers "is the address inside?".
      const list = new net.BlockList();
      list.addSubnet(range.address, range.prefix, family);
      if (list.check(address, family)) best = { id: site.id, prefix: range.prefix };
    }
  }
  return best?.id ?? null;
}
