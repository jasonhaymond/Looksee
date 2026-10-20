// API routes for groups: /api/groups (list, create, view with resolved
// members, edit, delete, add/remove members, preview a filter, and "which
// groups is this object in").
//
// Where this sits: called by the dashboard's Groups pages, the navigation
// tree and the "Add to group" bulk actions. Membership resolution lives in
// services/groups.ts; this file validates input and shapes responses.
//
// Security: every route needs a signed-in session (requireAuth). Filter
// rules are validated against fixed field/operator lists before saving, and
// member types against the fixed list of object kinds.

import { Router } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { groupMembers, groups } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import {
  FILTER_FIELDS,
  FILTER_OPS,
  MEMBER_TYPES,
  expandToChecks,
  expandToEndpoints,
  loadUniverse,
  matchesRules,
  resolveGroup,
  validateRules,
  worseStatus,
  type MemberType,
  type Universe,
} from "../services/groups.js";

export const groupsRouter = Router();
// Without this, anyone could read the inventory or reshape groups (and so
// what maintenance windows cover).
groupsRouter.use(requireAuth);

/**
 * Summary numbers for one group: how many of each kind it contains, the
 * worst status of the checks it covers, and how many of those are failing.
 */
async function summarize(g: typeof groups.$inferSelect, u: Universe) {
  const r = await resolveGroup(g, u);
  const checkIds = new Set(expandToChecks(r, u));
  let status: string | null = null;
  let problems = 0;
  for (const c of u.checks) {
    if (!checkIds.has(c.id) || !c.enabled) continue;
    status = worseStatus(status, c.lastStatus ?? "unknown");
    if (c.lastStatus === "down" || c.lastStatus === "warn") problems++;
  }
  return {
    counts: { locations: r.locations.length, sites: r.sites.length, endpoints: r.endpoints.length, checks: r.checks.length, coveredChecks: checkIds.size },
    status,
    problems,
  };
}

/**
 * Validates a list of { type, id } member references from a request body.
 *
 * @returns the cleaned list, or an error message
 */
function parseMembers(v: unknown): { type: MemberType; id: string }[] | { error: string } {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return { error: "members must be a list of { type, id }" };
  if (v.length > 5000) return { error: "Too many members in one request" };
  const out: { type: MemberType; id: string }[] = [];
  // Matches a UUID such as 3f2b6c1e-0a4d-4e7b-9c1d-2b3a4c5d6e7f, so a
  // malformed ID is refused here rather than as a database error.
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  for (const m of v as { type?: unknown; id?: unknown }[]) {
    if (!MEMBER_TYPES.includes(m?.type as MemberType)) return { error: `Unknown member type "${String(m?.type)}"` };
    if (!uuid.test(String(m?.id))) return { error: `"${String(m?.id).slice(0, 40)}" isn't a valid ID` };
    out.push({ type: m.type as MemberType, id: String(m.id) });
  }
  return out;
}

// GET /api/groups — every group with its counts and status.
groupsRouter.get("/", async (_req, res) => {
  const rows = await db.select().from(groups).orderBy(asc(groups.name));
  const u = await loadUniverse();
  const out = [];
  for (const g of rows) out.push({ ...g, ...(await summarize(g, u)) });
  res.json(out);
});

// GET /api/groups/fields — what the filter builder can offer: fields per
// object kind and the operators.
groupsRouter.get("/fields", (_req, res) => {
  res.json({ fields: FILTER_FIELDS, ops: FILTER_OPS });
});

// POST /api/groups/preview { target, rules } — what a filter would match
// right now, before it's saved (first 200 by name, plus the total).
groupsRouter.post("/preview", async (req, res) => {
  const v = validateRules(req.body?.target, req.body?.rules);
  if ("error" in v) {
    res.status(400).json(v);
    return;
  }
  const u = await loadUniverse();
  const pool = v.target === "location" ? u.locations : v.target === "site" ? u.sites : v.target === "endpoint" ? u.endpoints : u.checks;
  const matches = pool.filter((o) => matchesRules(v.target, o, v.rules, u)).map((o) => ({ id: o.id, name: o.name }));
  matches.sort((a, b) => a.name.localeCompare(b.name));
  res.json({ total: matches.length, matches: matches.slice(0, 200) });
});

// GET /api/groups/of/:type/:id — the groups an object belongs to, directly
// (manual) or by matching a filter. Shown on location/site/endpoint/check pages.
groupsRouter.get("/of/:type/:id", async (req, res) => {
  const type = String(req.params.type) as MemberType;
  if (!MEMBER_TYPES.includes(type)) {
    res.status(400).json({ error: "type must be location, site, endpoint or check" });
    return;
  }
  const id = String(req.params.id);
  const rows = await db.select().from(groups).orderBy(asc(groups.name));
  const u = await loadUniverse();
  const out = [];
  for (const g of rows) {
    const r = await resolveGroup(g, u);
    if (r[(type + "s") as keyof typeof r].includes(id)) out.push({ id: g.id, name: g.name, kind: g.kind });
  }
  res.json(out);
});

// POST /api/groups — create a manual group (optionally with members) or a
// filter group (target + rules).
groupsRouter.post("/", async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  if (!name) {
    res.status(400).json({ error: "name is required" });
    return;
  }
  const kind = req.body?.kind === "filter" ? "filter" : "manual";
  let target: MemberType | null = null;
  let rules: typeof groups.$inferInsert.rules = { match: "all", conditions: [] };
  if (kind === "filter") {
    const v = validateRules(req.body?.target, req.body?.rules);
    if ("error" in v) {
      res.status(400).json(v);
      return;
    }
    target = v.target;
    rules = v.rules;
  }
  const members = parseMembers(req.body?.members);
  if ("error" in members) {
    res.status(400).json(members);
    return;
  }
  const [g] = await db.insert(groups).values({ name, description: req.body?.description ? String(req.body.description) : null, kind, target, rules }).returning();
  if (kind === "manual" && members.length) {
    await db.insert(groupMembers).values(members.map((m) => ({ groupId: g.id, memberType: m.type, memberId: m.id }))).onConflictDoNothing();
  }
  res.status(201).json(g);
});

// GET /api/groups/:id — the group, its direct members with names and
// statuses, and every check/endpoint it covers through the hierarchy (what
// bulk actions on the group act on).
groupsRouter.get("/:id", async (req, res) => {
  const [g] = await db.select().from(groups).where(eq(groups.id, String(req.params.id)));
  if (!g) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const u = await loadUniverse();
  const r = await resolveGroup(g, u);
  const siteName = (id: string | null) => (id ? u.siteById.get(id)?.name ?? null : null);
  res.json({
    group: g,
    ...(await summarize(g, u)),
    members: {
      locations: r.locations.map((id) => ({ id, name: u.locationById.get(id)?.name ?? "" })),
      sites: r.sites.map((id) => ({ id, name: u.siteById.get(id)?.name ?? "", status: u.siteStatus.get(id) ?? null })),
      endpoints: r.endpoints.map((id) => {
        const e = u.endpointById.get(id)!;
        return { id, name: e.name, os: e.os, site: siteName(e.siteId), status: u.endpointStatus.get(id) ?? null };
      }),
      checks: u.checks
        .filter((c) => r.checks.includes(c.id))
        .map((c) => ({ id: c.id, name: c.name, type: c.type, status: c.lastStatus, enabled: c.enabled, endpoint: c.endpointId ? u.endpointById.get(c.endpointId)?.name ?? null : null, site: siteName(c.siteId) })),
    },
    coveredCheckIds: expandToChecks(r, u),
    coveredEndpointIds: expandToEndpoints(r, u),
  });
});

// PATCH /api/groups/:id — rename, re-describe, or (filter groups) change
// the target and rules. A group's kind can't change.
groupsRouter.patch("/:id", async (req, res) => {
  const [g] = await db.select().from(groups).where(eq(groups.id, String(req.params.id)));
  if (!g) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  const u: Partial<typeof groups.$inferInsert> = {};
  if (req.body?.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) {
      res.status(400).json({ error: "name can't be empty" });
      return;
    }
    u.name = name;
  }
  if (req.body?.description !== undefined) u.description = req.body.description ? String(req.body.description) : null;
  if (g.kind === "filter" && (req.body?.rules !== undefined || req.body?.target !== undefined)) {
    const v = validateRules(req.body?.target ?? g.target, req.body?.rules ?? g.rules);
    if ("error" in v) {
      res.status(400).json(v);
      return;
    }
    u.target = v.target;
    u.rules = v.rules;
  }
  const [row] = await db.update(groups).set(u).where(eq(groups.id, g.id)).returning();
  res.json(row);
});

// DELETE /api/groups/:id — removes the group (its memberships go with it;
// the members themselves are untouched).
groupsRouter.delete("/:id", async (req, res) => {
  await db.delete(groups).where(eq(groups.id, String(req.params.id)));
  res.status(204).end();
});

// POST /api/groups/:id/members { add: [{type,id}], remove: [{type,id}] } —
// change a manual group's members.
groupsRouter.post("/:id/members", async (req, res) => {
  const [g] = await db.select().from(groups).where(eq(groups.id, String(req.params.id)));
  if (!g) {
    res.status(404).json({ error: "Group not found" });
    return;
  }
  if (g.kind !== "manual") {
    res.status(400).json({ error: "A filter group's members come from its rules — edit the rules instead" });
    return;
  }
  const add = parseMembers(req.body?.add);
  const remove = parseMembers(req.body?.remove);
  if ("error" in add) {
    res.status(400).json(add);
    return;
  }
  if ("error" in remove) {
    res.status(400).json(remove);
    return;
  }
  if (add.length) await db.insert(groupMembers).values(add.map((m) => ({ groupId: g.id, memberType: m.type, memberId: m.id }))).onConflictDoNothing();
  for (const m of remove) {
    await db.delete(groupMembers).where(and(eq(groupMembers.groupId, g.id), eq(groupMembers.memberType, m.type), eq(groupMembers.memberId, m.id)));
  }
  const total = await db.select({ id: groupMembers.id }).from(groupMembers).where(eq(groupMembers.groupId, g.id));
  res.json({ added: add.length, removed: remove.length, members: total.length });
});
