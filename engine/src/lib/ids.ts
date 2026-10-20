// Checks for IDs and network names that arrive in requests.
//
// Every ID in Looksee is a UUID: 8-4-4-4-12 hexadecimal digits, e.g.
// "3f2b8c1e-0a4d-4c5e-9f00-123456789abc". Routes check an ID's shape before
// using it in a database query, so a malformed one gets a clean "not found"
// or 400 instead of a database error. These checks are plain character
// tests (no regular expressions), so their cost is fixed whatever is sent.

const HEX = "0123456789abcdefABCDEF";

/**
 * Whether text is a UUID (8-4-4-4-12 hexadecimal digits with dashes).
 *
 * @param text anything; non-strings are never UUIDs
 */
export function isUuid(text: unknown): text is string {
  if (typeof text !== "string" || text.length !== 36) return false;
  for (let i = 0; i < 36; i++) {
    const c = text.charAt(i);
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      if (c !== "-") return false;
    } else if (!HEX.includes(c)) return false;
  }
  return true;
}

/**
 * An IPv4-mapped IPv6 address ("::ffff:10.0.0.5", how Node reports IPv4
 * senders on a dual-stack socket) as plain IPv4; anything else unchanged.
 */
export function stripMappedIp(ip: string): string {
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}
