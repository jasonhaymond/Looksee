// Removes characters PostgreSQL refuses to store from data sent in by
// agents, site collectors and anything else that posts JSON to the engine.
//
// Why this exists: Windows programs sometimes leave NUL characters (code
// point 0, written "\u0000" in JSON) at the end of registry values — a SHARP
// printer-driver uninstaller writes its display name padded with hundreds of
// them. PostgreSQL can't store that character in a text or jsonb column
// ("unsupported Unicode escape sequence"), so one such value made the whole
// database update for an agent report fail, and the endpoint looked offline
// even though its agent was running. Lone UTF-16 surrogates (half of an emoji,
// left over when a long string is cut in the wrong place) are rejected the
// same way.
//
// Where this sits: app.ts runs stripNulBody on every parsed request body;
// cleanString is also used where values come from a query string or are
// shortened to a length limit (services/software.ts).

import type { NextFunction, Request, Response } from "express";

// The NUL character (U+0000). Removed with a plain text replace (replaceAll)
// rather than a regex, so linters don't flag a control character in a
// pattern. Example: "Tool\u0000\u0000" → "Tool".
const NUL = "\u0000";
// Regex: a high surrogate (U+D800–U+DBFF) not followed by a low one, or a
// low surrogate (U+DC00–U+DFFF) not preceded by a high one — i.e. half of a
// character outside the basic plane, such as an emoji cut in two. The "u"
// flag is left off on purpose so the pattern sees the raw UTF-16 halves.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Returns the string without NUL characters or unpaired surrogate halves —
 * the two things PostgreSQL rejects in text/jsonb. Other characters are
 * untouched.
 */
export function cleanString(s: string): string {
  return s.replaceAll(NUL, "").replace(LONE_SURROGATE, "");
}

/**
 * Cuts a string to at most `max` UTF-16 code units without splitting a
 * surrogate pair (which would leave a lone half PostgreSQL rejects). Also
 * removes NUL characters first, so the limit applies to real text.
 */
export function truncate(s: string, max: number): string {
  const clean = cleanString(s);
  if (clean.length <= max) return clean;
  // If the last kept unit is the first half of a pair, drop it too.
  const code = clean.charCodeAt(max - 1);
  const end = code >= 0xd800 && code <= 0xdbff ? max - 1 : max;
  return clean.slice(0, end);
}

/**
 * Walks any JSON value (string, array, object, number…) and returns a copy
 * with every string cleaned — including object keys, since a key with a NUL
 * in it fails in jsonb just like a value does. Numbers, booleans and null
 * pass through unchanged. Recursion is bounded by express.json's own depth
 * and size limits on what it parsed.
 */
export function stripNul(value: unknown): unknown {
  if (typeof value === "string") return cleanString(value);
  if (Array.isArray(value)) return value.map(stripNul);
  if (value && typeof value === "object") {
    // Object.entries only lists the object's own keys, so nothing inherited
    // (such as __proto__) is copied; Object.fromEntries builds a plain object.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [cleanString(k), stripNul(v)]));
  }
  return value;
}

/**
 * Express middleware (runs before the routes): replaces req.body with a
 * cleaned copy. Registered right after body parsing in app.ts, so every
 * route — the agent report above all — only ever sees storable text.
 */
export function stripNulBody(req: Request, _res: Response, next: NextFunction): void {
  if (req.body !== undefined && req.body !== null) req.body = stripNul(req.body);
  next();
}
