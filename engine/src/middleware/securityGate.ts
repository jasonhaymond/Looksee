// Request-level protection that runs before every route: blocked IP
// addresses, the optional IP allowlist, security headers on every response,
// and counting requests for known exploit paths (a scanner probing for
// WordPress or .env files) as security events.
//
// Where this sits: registered first in app.ts. The health check stays
// reachable for uptime monitors; machine routes (agents, collectors, push
// URLs, install scripts, public status pages) are only covered by the
// allowlist when the admin turns that on.

import type { NextFunction, Request, Response } from "express";
import { buildList, clientIp, listHas } from "../lib/ipMatch.js";
import { getSecuritySettings, isBlocked, looksLikeScan, recordSecurityEvent } from "../services/security.js";

// Machine-to-machine routes: agents, site collectors, heartbeat/push URLs,
// the install scripts agents download, and public status pages. The IP
// allowlist only covers them when "also apply to agents" is on; blocks
// always apply.
const MACHINE_PREFIXES = ["/api/agent", "/api/collector", "/api/hb", "/api/public", "/install"];
/** Whether a path is one of those routes (the prefix itself, or below it). */
const isMachineRoute = (p: string) => MACHINE_PREFIXES.some((pre) => p === pre || p.startsWith(`${pre}/`));

// Health stays reachable for uptime monitors and the update script, even
// from a blocked or non-allowlisted IP — it reveals only up/down + version.
const ALWAYS_OPEN = "/api/health";

let allowCache: { key: string; list: ReturnType<typeof buildList> } | null = null;

// When each blocked address last had a refusal recorded. A blocked agent
// keeps polling every 15–30 seconds; one event a minute per address is
// enough to show on the Security page that (and what) it's still trying,
// without writing a row for every refused request.
const blockedNoted = new Map<string, number>();
const BLOCKED_NOTE_EVERY_MS = 60_000;

/**
 * Records a "blocked_request" security event for this refused request,
 * unless one was already recorded for the same address in the last minute.
 * Without this a block was silent: agents behind a blocked address simply
 * stopped checking in, with nothing in the logs saying why.
 */
async function noteBlocked(req: Request, ip: string) {
  const now = Date.now();
  if (now - (blockedNoted.get(ip) ?? 0) < BLOCKED_NOTE_EVERY_MS) return;
  blockedNoted.set(ip, now);
  // Forget old entries so the map can't grow without limit under a flood
  // of different addresses.
  if (blockedNoted.size > 10_000) for (const [k, t] of blockedNoted) if (now - t > BLOCKED_NOTE_EVERY_MS) blockedNoted.delete(k);
  await recordSecurityEvent("blocked_request", { req, detail: isMachineRoute(req.path) ? "agent/collector/install request" : "dashboard/API request" });
}

export async function securityGate(req: Request, res: Response, next: NextFunction) {
  if (req.path === ALWAYS_OPEN) return next();
  const ip = clientIp(req);
  if (await isBlocked(ip)) {
    await noteBlocked(req, ip);
    res.status(403).json({ error: "Access from your IP address is blocked." });
    return;
  }
  const s = await getSecuritySettings();
  if (s.allowlistEnabled && s.allowlist.length && (s.allowlistAgents || !isMachineRoute(req.path))) {
    const key = s.allowlist.join(",");
    if (allowCache?.key !== key) allowCache = { key, list: buildList(s.allowlist) };
    if (!listHas(allowCache.list, ip)) {
      await recordSecurityEvent("allowlist_denied", { req });
      res.status(403).json({ error: "Your IP address isn't allowed to use this Looksee server." });
      return;
    }
  }
  next();
}

// Runs after every route: anything that reached here matched nothing, and a
// known exploit path is a probe worth counting.
export async function notFoundHandler(req: Request, res: Response) {
  const s = await getSecuritySettings();
  if (s.detectScans && looksLikeScan(req.originalUrl)) await recordSecurityEvent("scan_probe", { req });
  res.status(404).json({ error: "Not found" });
}

// Defense-in-depth headers on every API response (the dashboard sets its
// own in next.config.ts; Caddy adds HSTS).
export function securityHeaders(_req: Request, res: Response, next: NextFunction) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-site");
  res.setHeader("Cache-Control", "no-store");
  next();
}
