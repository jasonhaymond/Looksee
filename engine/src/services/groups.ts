// Groups: resolving who is in a group, and the hierarchy snapshot the
// navigation tree and groups both read.
//
// Where this sits: routes/groups.ts (the Groups pages), routes/tree.ts (the
// left navigation tree) and services/maintenance.ts (maintenance windows
// scoped to a group) call into here. A group is either "manual" (members
// listed in group_members) or "filter" (saved rules evaluated against the
// current inventory every time, so newly added matching objects join on
// their own). See the groups/group_members tables in db/schema.ts.
//
// Resolution works on a single in-memory snapshot of the inventory
// (`loadUniverse`): locations, sites, endpoints and checks with just the
// columns filters need. A homelab-to-small-business install has at most a
// few thousand of these, so one snapshot per request is cheap and keeps
// every filter evaluation in plain TypeScript rather than generated SQL.
//
// Security: filter rules come from the (authenticated) admin, but are still
// validated against fixed lists of fields and operators before saving
// (validateRules), and matching uses plain string comparisons — no regular
// expressions built from user input, so a rule can't be crafted to hang the
// server.

import { db } from "../db/index.js";
import { checks, endpoints, groupMembers, groups, locations, sites, type GroupRules } from "../db/schema.js";
import { eq, inArray } from "drizzle-orm";
import { own } from "../lib/own.js";

// The kinds of object a group can contain or a filter can select.
export const MEMBER_TYPES = ["location", "site", "endpoint", "check"] as const;
export type MemberType = (typeof MEMBER_TYPES)[number];

// Comparison operators a filter condition may use. All compare text,
// case-insensitively.
export const FILTER_OPS = ["is", "is_not", "contains", "not_contains", "starts_with", "ends_with"] as const;

// The fields each kind of object can be filtered on, with a label and a hint
// for the filter builder in the dashboard. "status" is the worst status of
// the object's checks (or the check's own status).
export const FILTER_FIELDS: Record<MemberType, { field: string; label: string; hint?: string }[]> = {
  location: [
    { field: "name", label: "Name" },
    { field: "description", label: "Description" },
  ],
  site: [
    { field: "name", label: "Name" },
    { field: "description", label: "Description" },
    { field: "location", label: "Location name" },
    { field: "collector", label: "Has a site collector", hint: "yes / no" },
    { field: "status", label: "Status", hint: "up, warn, down, unknown" },
  ],
  endpoint: [
    { field: "name", label: "Name" },
    { field: "hostname", label: "Hostname / IP" },
    { field: "os", label: "Operating system" },
    { field: "tag", label: "Tag" },
    { field: "site", label: "Site name" },
    { field: "location", label: "Location name" },
    { field: "agent", label: "Runs the agent", hint: "yes / no" },
    { field: "agentVersion", label: "Agent version" },
    { field: "status", label: "Status", hint: "up, warn, down, unknown" },
  ],
  check: [
    { field: "name", label: "Name" },
    { field: "type", label: "Check type", hint: "e.g. ping, http, agent_service" },
    { field: "tag", label: "Tag" },
    { field: "status", label: "Status", hint: "up, warn, down, unknown" },
    { field: "enabled", label: "Enabled", hint: "yes / no" },
    { field: "endpoint", label: "Endpoint name" },
    { field: "site", label: "Site name" },
    { field: "location", label: "Location name" },
  ],
};

// Status words ordered from best to worst, for "the worst status of …".
const STATUS_RANK: Record<string, number> = { up: 0, unknown: 1, warn: 2, down: 3 };

/**
 * The worse of two statuses (down > warn > unknown > up); null counts as
 * "nothing known yet".
 */
export function worseStatus(a: string | null, b: string | null): string | null {
  if (!a) return b;
  if (!b) return a;
  return (own(STATUS_RANK, b) ?? 1) > (own(STATUS_RANK, a) ?? 1) ? b : a;
}

// One row of each kind with the columns filters and the tree need.
type LocationRow = { id: string; name: string; description: string | null };
type SiteRow = { id: string; name: string; description: string | null; locationId: string | null; collectorEndpointId: string | null };
type EndpointRow = { id: string; name: string; siteId: string; hostname: string | null; os: string | null; tags: string[]; agentApiKey: string | null; agentVersion: string | null; lastSeenAt: Date | null };
type CheckRow = { id: string; name: string; type: string; siteId: string; endpointId: string | null; tags: string[]; lastStatus: string | null; enabled: boolean };

/** A snapshot of the whole inventory, with lookup maps. */
export type Universe = {
  locations: LocationRow[];
  sites: SiteRow[];
  endpoints: EndpointRow[];
  checks: CheckRow[];
  locationById: Map<string, LocationRow>;
  siteById: Map<string, SiteRow>;
  endpointById: Map<string, EndpointRow>;
  // Worst status of each site's / endpoint's enabled checks.
  siteStatus: Map<string, string | null>;
  endpointStatus: Map<string, string | null>;
};

/**
 * Reads the inventory once (four queries) and precomputes lookups and each
 * site's and endpoint's worst check status.
 *
 * @returns the snapshot every resolution below works from
 */
export async function loadUniverse(): Promise<Universe> {
  const [locs, siteRows, epRows, checkRows] = await Promise.all([
    db.select({ id: locations.id, name: locations.name, description: locations.description }).from(locations),
    db.select({ id: sites.id, name: sites.name, description: sites.description, locationId: sites.locationId, collectorEndpointId: sites.collectorEndpointId }).from(sites),
    db.select({ id: endpoints.id, name: endpoints.name, siteId: endpoints.siteId, hostname: endpoints.hostname, os: endpoints.os, tags: endpoints.tags, agentApiKey: endpoints.agentApiKey, agentVersion: endpoints.agentVersion, lastSeenAt: endpoints.lastSeenAt }).from(endpoints),
    db.select({ id: checks.id, name: checks.name, type: checks.type, siteId: checks.siteId, endpointId: checks.endpointId, tags: checks.tags, lastStatus: checks.lastStatus, enabled: checks.enabled }).from(checks),
  ]);
  const siteStatus = new Map<string, string | null>();
  const endpointStatus = new Map<string, string | null>();
  // Disabled checks don't count toward anything's status.
  for (const c of checkRows) {
    if (!c.enabled) continue;
    siteStatus.set(c.siteId, worseStatus(siteStatus.get(c.siteId) ?? null, c.lastStatus ?? "unknown"));
    if (c.endpointId) endpointStatus.set(c.endpointId, worseStatus(endpointStatus.get(c.endpointId) ?? null, c.lastStatus ?? "unknown"));
  }
  return {
    locations: locs,
    sites: siteRows,
    endpoints: epRows.map((e) => ({ ...e, tags: e.tags ?? [] })),
    checks: checkRows.map((c) => ({ ...c, tags: c.tags ?? [] })),
    locationById: new Map(locs.map((l) => [l.id, l])),
    siteById: new Map(siteRows.map((s) => [s.id, s])),
    endpointById: new Map(epRows.map((e) => [e.id, { ...e, tags: e.tags ?? [] }])),
    siteStatus,
    endpointStatus,
  };
}

/**
 * The text value(s) of one filter field for one object. Most fields have
 * one value; "tag" has one per tag (the condition holds if any tag matches).
 */
function fieldValues(type: MemberType, obj: LocationRow | SiteRow | EndpointRow | CheckRow, field: string, u: Universe): string[] {
  const yes = (b: boolean) => (b ? "yes" : "no");
  switch (type) {
    case "location": {
      const l = obj as LocationRow;
      return [field === "name" ? l.name : field === "description" ? l.description ?? "" : ""];
    }
    case "site": {
      const s = obj as SiteRow;
      if (field === "name") return [s.name];
      if (field === "description") return [s.description ?? ""];
      if (field === "location") return [s.locationId ? u.locationById.get(s.locationId)?.name ?? "" : ""];
      if (field === "collector") return [yes(Boolean(s.collectorEndpointId))];
      if (field === "status") return [u.siteStatus.get(s.id) ?? "unknown"];
      return [""];
    }
    case "endpoint": {
      const e = obj as EndpointRow;
      const site = u.siteById.get(e.siteId);
      if (field === "name") return [e.name];
      if (field === "hostname") return [e.hostname ?? ""];
      if (field === "os") return [e.os ?? ""];
      if (field === "tag") return e.tags.length ? e.tags : [""];
      if (field === "site") return [site?.name ?? ""];
      if (field === "location") return [site?.locationId ? u.locationById.get(site.locationId)?.name ?? "" : ""];
      if (field === "agent") return [yes(Boolean(e.agentApiKey))];
      if (field === "agentVersion") return [e.agentVersion ?? ""];
      if (field === "status") return [u.endpointStatus.get(e.id) ?? "unknown"];
      return [""];
    }
    case "check": {
      const c = obj as CheckRow;
      const site = u.siteById.get(c.siteId);
      if (field === "name") return [c.name];
      if (field === "type") return [c.type];
      if (field === "tag") return c.tags.length ? c.tags : [""];
      if (field === "status") return [c.lastStatus ?? "unknown"];
      if (field === "enabled") return [yes(c.enabled)];
      if (field === "endpoint") return [c.endpointId ? u.endpointById.get(c.endpointId)?.name ?? "" : ""];
      if (field === "site") return [site?.name ?? ""];
      if (field === "location") return [site?.locationId ? u.locationById.get(site.locationId)?.name ?? "" : ""];
      return [""];
    }
  }
}

/**
 * Whether one text value satisfies one operator, case-insensitively.
 * Negative operators (is_not, not_contains) are applied by the caller across
 * all of an object's values, so "tag is_not prod" means "has no prod tag".
 */
function opMatches(op: string, actual: string, wanted: string): boolean {
  const a = actual.toLowerCase();
  const w = wanted.toLowerCase();
  switch (op) {
    case "is":
    case "is_not":
      return a === w;
    case "contains":
    case "not_contains":
      return a.includes(w);
    case "starts_with":
      return a.startsWith(w);
    case "ends_with":
      return a.endsWith(w);
    default:
      return false;
  }
}

/**
 * Whether an object satisfies a filter group's rules. An empty rule list
 * matches nothing (so a half-built filter doesn't suddenly cover everything).
 */
export function matchesRules(type: MemberType, obj: LocationRow | SiteRow | EndpointRow | CheckRow, rules: GroupRules, u: Universe): boolean {
  if (!rules.conditions.length) return false;
  const results = rules.conditions.map((c) => {
    const values = fieldValues(type, obj, c.field, u);
    const negative = c.op === "is_not" || c.op === "not_contains";
    const any = values.some((v) => opMatches(c.op, v, c.value));
    return negative ? !any : any;
  });
  return rules.match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/**
 * Checks a filter group's rules before they're saved.
 *
 * @param target which kind of object the rules select
 * @param rules the rules as sent by the dashboard
 * @returns the cleaned rules, or an error message for a 400 response
 */
export function validateRules(target: unknown, rules: unknown): { target: MemberType; rules: GroupRules } | { error: string } {
  if (!MEMBER_TYPES.includes(target as MemberType)) return { error: "target must be location, site, endpoint or check" };
  const r = (rules ?? {}) as { match?: unknown; conditions?: unknown };
  const match = r.match === "any" ? "any" : "all";
  if (!Array.isArray(r.conditions)) return { error: "rules.conditions must be a list" };
  if (r.conditions.length > 20) return { error: "At most 20 conditions per group" };
  const allowed = new Set(FILTER_FIELDS[target as MemberType].map((f) => f.field));
  const conditions: GroupRules["conditions"] = [];
  for (const c of r.conditions as { field?: unknown; op?: unknown; value?: unknown }[]) {
    if (!allowed.has(String(c?.field))) return { error: `Unknown field "${String(c?.field)}" for ${String(target)}s` };
    if (!FILTER_OPS.includes(String(c?.op) as (typeof FILTER_OPS)[number])) return { error: `Unknown operator "${String(c?.op)}"` };
    conditions.push({ field: String(c.field), op: String(c.op), value: String(c.value ?? "").slice(0, 200) });
  }
  return { target: target as MemberType, rules: { match, conditions } };
}

/** Resolved membership: the IDs in a group, by kind. */
export type Resolved = Record<"locations" | "sites" | "endpoints" | "checks", string[]>;

/**
 * Everything directly in a group: manual members (skipping ones whose object
 * no longer exists) or, for a filter group, every object its rules match now.
 *
 * @param group the group row
 * @param u the inventory snapshot (load once per request, pass to many groups)
 * @returns member IDs by kind
 */
/** The list in a Resolved result that holds members of this kind. */
function listFor(out: Resolved, t: MemberType): string[] {
  return t === "location" ? out.locations : t === "site" ? out.sites : t === "endpoint" ? out.endpoints : out.checks;
}

export async function resolveGroup(group: typeof groups.$inferSelect, u: Universe): Promise<Resolved> {
  const out: Resolved = { locations: [], sites: [], endpoints: [], checks: [] };
  if (group.kind === "filter") {
    const t = group.target as MemberType;
    const pool = t === "location" ? u.locations : t === "site" ? u.sites : t === "endpoint" ? u.endpoints : u.checks;
    const list = listFor(out, t);
    for (const obj of pool) if (matchesRules(t, obj, group.rules, u)) list.push(obj.id);
    return out;
  }
  const members = await db.select().from(groupMembers).where(eq(groupMembers.groupId, group.id));
  // Which objects still exist, by kind.
  const exists: Record<MemberType, Set<string>> = {
    location: new Set(u.locations.map((x) => x.id)),
    site: new Set(u.sites.map((x) => x.id)),
    endpoint: new Set(u.endpoints.map((x) => x.id)),
    check: new Set(u.checks.map((x) => x.id)),
  };
  const gone: string[] = [];
  for (const m of members) {
    const t = m.memberType as MemberType;
    if (!own(exists, t)?.has(m.memberId)) {
      gone.push(m.id);
      continue;
    }
    listFor(out, t).push(m.memberId);
  }
  // Tidy memberships of deleted objects (they can't be database foreign keys).
  if (gone.length) await db.delete(groupMembers).where(inArray(groupMembers.id, gone));
  return out;
}

/**
 * Every check a group covers, through the hierarchy: a location member
 * brings all checks of its sites, a site all its checks, an endpoint all its
 * checks, plus any directly listed checks.
 *
 * @param resolved the group's direct members (from resolveGroup)
 * @param u the same inventory snapshot
 * @returns check IDs, without duplicates
 */
export function expandToChecks(resolved: Resolved, u: Universe): string[] {
  const locs = new Set(resolved.locations);
  const siteSet = new Set(resolved.sites);
  for (const s of u.sites) if (s.locationId && locs.has(s.locationId)) siteSet.add(s.id);
  const eps = new Set(resolved.endpoints);
  const out = new Set(resolved.checks);
  for (const c of u.checks) {
    if (siteSet.has(c.siteId) || (c.endpointId && eps.has(c.endpointId))) out.add(c.id);
  }
  return [...out];
}

/**
 * Every endpoint a group covers through the hierarchy (location → its sites'
 * endpoints, site → its endpoints, plus direct endpoint members).
 */
export function expandToEndpoints(resolved: Resolved, u: Universe): string[] {
  const locs = new Set(resolved.locations);
  const siteSet = new Set(resolved.sites);
  for (const s of u.sites) if (s.locationId && locs.has(s.locationId)) siteSet.add(s.id);
  const out = new Set(resolved.endpoints);
  for (const e of u.endpoints) if (siteSet.has(e.siteId)) out.add(e.id);
  return [...out];
}

/**
 * Check IDs covered by each of several groups, loading the inventory once —
 * what maintenance windows scoped to groups need on every cache refresh.
 *
 * @param groupIds the groups to expand
 * @returns a map from group ID to the set of its check IDs
 */
export async function checkIdsForGroups(groupIds: string[]): Promise<Map<string, Set<string>>> {
  const out = new Map<string, Set<string>>();
  if (!groupIds.length) return out;
  const rows = await db.select().from(groups).where(inArray(groups.id, groupIds));
  const u = await loadUniverse();
  for (const g of rows) out.set(g.id, new Set(expandToChecks(await resolveGroup(g, u), u)));
  return out;
}
