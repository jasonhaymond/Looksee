// API route for the dashboard's left navigation tree: GET /api/tree.
//
// Where this sits: the sidebar (dashboard/app/components/Sidebar.tsx) loads
// this on every page and refreshes it every 30 seconds. It returns the whole
// hierarchy — locations → sites → endpoints → checks — plus the groups, each
// node carrying its worst check status and how many of its checks are
// failing, so the tree can show problems at every level without opening it.
//
// Security: requires a signed-in session (requireAuth). Returns names, types
// and statuses only — no configuration, secrets or messages.

import { Router } from "express";
import { asc } from "drizzle-orm";
import { db } from "../db/index.js";
import { groups } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { expandToChecks, loadUniverse, resolveGroup, worseStatus } from "../services/groups.js";

export const treeRouter = Router();
treeRouter.use(requireAuth);

// One check in the tree.
type CheckNode = { id: string; name: string; type: string; status: string | null; enabled: boolean };
// A node's summary: worst status of its enabled checks, and how many of
// them are warn/down.
type Summary = { status: string | null; problems: number; checkCount: number };

/** Folds a list of check nodes into a summary. */
function summarize(list: CheckNode[]): Summary {
  let status: string | null = null;
  let problems = 0;
  let count = 0;
  for (const c of list) {
    if (!c.enabled) continue;
    count++;
    status = worseStatus(status, c.status ?? "unknown");
    if (c.status === "down" || c.status === "warn") problems++;
  }
  return { status, problems, checkCount: count };
}

/** Combines several summaries (e.g. a site's endpoints) into one. */
function combine(list: Summary[]): Summary {
  return list.reduce<Summary>((a, s) => ({ status: worseStatus(a.status, s.status), problems: a.problems + s.problems, checkCount: a.checkCount + s.checkCount }), { status: null, problems: 0, checkCount: 0 });
}

const byName = <T extends { name: string }>(a: T, b: T) => a.name.localeCompare(b.name, undefined, { numeric: true });

// GET /api/tree
treeRouter.get("/", async (_req, res) => {
  const u = await loadUniverse();
  // Checks grouped by their endpoint, and site-level checks (no endpoint) by site.
  const checksByEndpoint = new Map<string, CheckNode[]>();
  const siteChecks = new Map<string, CheckNode[]>();
  for (const c of u.checks) {
    const node: CheckNode = { id: c.id, name: c.name, type: c.type, status: c.lastStatus, enabled: c.enabled };
    const map = c.endpointId ? checksByEndpoint : siteChecks;
    const key = c.endpointId ?? c.siteId;
    map.set(key, [...(map.get(key) ?? []), node]);
  }
  const endpointsBySite = new Map<string, typeof u.endpoints>();
  for (const e of u.endpoints) endpointsBySite.set(e.siteId, [...(endpointsBySite.get(e.siteId) ?? []), e]);

  // A site node: its endpoints (each with its checks) and its site-level checks.
  const siteNode = (s: (typeof u.sites)[number]) => {
    const eps = (endpointsBySite.get(s.id) ?? []).sort(byName).map((e) => {
      const list = (checksByEndpoint.get(e.id) ?? []).sort(byName);
      return { id: e.id, name: e.name, os: e.os, agent: Boolean(e.agentApiKey), collector: s.collectorEndpointId === e.id, ...summarize(list), children: list };
    });
    const own = (siteChecks.get(s.id) ?? []).sort(byName);
    return { id: s.id, name: s.name, ...combine([...eps, summarize(own)]), endpoints: eps, checks: own };
  };

  const siteNodes = u.sites.sort(byName).map(siteNode);
  const locs = u.locations.sort(byName).map((l) => {
    const list = siteNodes.filter((s) => u.siteById.get(s.id)?.locationId === l.id);
    return { id: l.id, name: l.name, ...combine(list), sites: list };
  });
  const unassignedSites = siteNodes.filter((s) => !u.siteById.get(s.id)?.locationId);

  // Groups with the status of every check they cover.
  const groupRows = await db.select().from(groups).orderBy(asc(groups.name));
  const groupNodes = [];
  const checkById = new Map(u.checks.map((c) => [c.id, c]));
  for (const g of groupRows) {
    const ids = expandToChecks(await resolveGroup(g, u), u);
    const list = ids.map((id) => checkById.get(id)!).map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.lastStatus, enabled: c.enabled }));
    groupNodes.push({ id: g.id, name: g.name, kind: g.kind, ...summarize(list) });
  }

  res.json({ locations: locs, unassignedSites, groups: groupNodes });
});
