// Suggested checks for a whole site, from its name and description, its
// endpoints, and the checks it already has — the site-level counterpart of
// an endpoint's suggestions (services/suggestions.ts).
//
// Where this sits: GET /api/sites/:id/suggestions and …/suggestions/apply
// (routes/sites.ts), shown on the site's page.
//
// The rules, in plain words:
//   - an office, branch, store, home or remote site (by its name or
//     description), or any site with a site collector, gets an internet
//     check (reaching a public address and resolving a name) and a public-IP
//     change check, unless it already has them;
//   - every endpoint with a known address but no check at all gets a ping;
//   - every endpoint with an agent gets "agent online" if it hasn't one;
//   - an endpoint named or described like a printer (printer, MFP, copier,
//     plotter) without SNMP checks gets the printer toner and error checks;
//   - every HTTPS check without a certificate check for its host gets one.

import { suggestionKey, type Suggestion } from "./suggestions.js";

type SiteLike = { name: string; description: string | null; collectorEndpointId: string | null };
type EndpointLike = { id: string; name: string; hostname: string | null; agentApiKey?: string | null; hasAgentKey?: boolean; tags?: string[] | null };
type CheckLike = { type: string; config: unknown; endpointId: string | null };

// Words that mark a site as somewhere people work or live (needs internet).
const OFFICE_WORDS = new Set(["office", "branch", "store", "shop", "home", "remote", "warehouse", "clinic", "school", "site"]);
// Words that mark an endpoint as a printer (and common printer model names).
const PRINTER_WORDS = new Set(["printer", "mfp", "copier", "plotter", "laserjet", "officejet", "imagerunner", "bizhub", "ecosys", "workcentre", "versalink"]);
/** Whether text contains one of the words (whole words, case ignored). */
const hasWord = (text: string, words: Set<string>) => text.toLowerCase().split(/[^a-z0-9]+/).some((w) => words.has(w));

/**
 * Suggested checks for one site.
 *
 * @param site the site (name, description, whether it has a collector)
 * @param endpoints its endpoints
 * @param existing every check in the site
 * @returns suggestions not already covered, each with a key for "apply"
 */
export function suggestSiteChecks(site: SiteLike, endpoints: EndpointLike[], existing: CheckLike[]): (Suggestion & { endpointId?: string | null })[] {
  const out: (Suggestion & { endpointId?: string | null })[] = [];
  const add = (name: string, type: string, config: Record<string, unknown>, reason: string, group: string, endpointId: string | null = null, intervalSeconds?: number) => {
    const s = { name, type, config, reason, group, endpointId, intervalSeconds, key: "", endpointScoped: Boolean(endpointId) };
    // Endpoint-specific suggestions include the endpoint in their key, so
    // two printers both get theirs.
    s.key = `${suggestionKey(s)}|${endpointId ?? ""}`;
    out.push(s);
  };
  const has = (type: string, pred: (c: Record<string, unknown>, e: CheckLike) => boolean = () => true) => existing.some((e) => e.type === type && pred((e.config ?? {}) as Record<string, unknown>, e));

  const officeLike = hasWord(`${site.name} ${site.description ?? ""}`, OFFICE_WORDS) || Boolean(site.collectorEndpointId);
  if (officeLike) {
    if (!has("ping", (c) => c.host === "1.1.1.1" || c.host === "8.8.8.8" || c.host === "9.9.9.9")) add(`${site.name}: internet reachable`, "ping", { host: "1.1.1.1", count: 3, lossWarnPercent: 20, lossCriticalPercent: 100 }, "Can this site reach the internet? Pings a public resolver.", "Internet");
    if (!has("dns")) add(`${site.name}: DNS resolving`, "dns", { hostname: "example.com", recordType: "A" }, "Names resolve — the first thing to break when the router's DNS fails.", "Internet");
    if (!has("public_ip")) add(`${site.name}: public IP change`, "public_ip", { url: "https://api.ipify.org" }, "Notices when the internet provider changes the site's public address (breaks VPNs and allow-lists).", "Internet", null, 900);
  }

  for (const ep of endpoints) {
    const mine = existing.filter((c) => c.endpointId === ep.id);
    const agent = Boolean(ep.hasAgentKey ?? ep.agentApiKey);
    if (ep.hostname && !mine.length) add(`${ep.name}: reachable (ping)`, "ping", { host: ep.hostname, count: 3, lossWarnPercent: 20, lossCriticalPercent: 100 }, `${ep.name} has no checks yet — at least know when it's offline.`, "Endpoints without checks", ep.id);
    if (agent && !mine.some((c) => c.type === "agent_heartbeat")) add(`${ep.name}: agent online`, "agent_heartbeat", { maxSilenceSeconds: 180 }, "Alerts when the agent stops reporting.", "Agents", ep.id);
    const printer = hasWord(`${ep.name} ${(ep.tags ?? []).join(" ")}`, PRINTER_WORDS);
    if (printer && ep.hostname && !mine.some((c) => c.type === "snmp")) {
      add(`${ep.name}: toner / ink`, "snmp", { host: ep.hostname, version: "2c", community: "public", preset: "printer_supplies", warnBelow: 15, criticalBelow: 5 }, "Looks like a printer: warns before toner or ink runs out (standard Printer-MIB, any brand).", "Printers", ep.id, 900);
      add(`${ep.name}: printer errors`, "snmp", { host: ep.hostname, version: "2c", community: "public", preset: "printer_status" }, "Paper jams, empty trays, open doors.", "Printers", ep.id, 300);
    }
  }

  // HTTPS checks without a certificate check for their host.
  const certHosts = new Set(existing.filter((e) => e.type === "ssl_cert").map((e) => String((e.config as Record<string, unknown>)?.host ?? "").toLowerCase()));
  for (const e of existing.filter((x) => x.type === "http")) {
    try {
      const u = new URL(String((e.config as Record<string, unknown>)?.url ?? ""));
      if (u.protocol === "https:" && !certHosts.has(u.hostname.toLowerCase())) {
        certHosts.add(u.hostname.toLowerCase());
        add(`TLS certificate ${u.hostname}`, "ssl_cert", { host: u.hostname, port: Number(u.port) || 443, warnDays: 14, criticalDays: 3 }, `Your HTTPS check on ${u.hostname} doesn't watch its certificate's expiry yet.`, "Certificates", e.endpointId, 3600);
      }
    } catch {
      // Not a URL — nothing to suggest.
    }
  }
  // One of each.
  const seen = new Set<string>();
  return out.filter((s) => (seen.has(s.key) ? false : (seen.add(s.key), true)));
}
