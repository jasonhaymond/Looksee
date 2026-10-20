// API routes for reusable exclusion lists: /api/exclusion-lists (list, kinds,
// create, edit, delete).
//
// Where this sits: called by the dashboard's Exclusions page. Rows go into the
// `exclusion_lists` table; services/exclusions.ts merges them into each
// check's config before it runs, and its cache is cleared after every write
// here so a change applies on the next run. Which checks use which kind of
// item is EXCLUSION_KINDS in services/probes/exclude.ts.
//
// Security: every route requires a signed-in session (requireAuth). Input is
// validated strictly — known kinds only, bounded list sizes, group IDs that
// exist — so a request can't store unbounded data or point at nothing.
// Items are stored and compared as plain text; they're never run as regular
// expressions or SQL.

import { Router } from "express";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "../db/index.js";
import { exclusionLists, groups } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { EXCLUSION_KINDS, excludeItems } from "../services/probes/exclude.js";
import { invalidateExclusionCache } from "../services/exclusions.js";
import { isUuid } from "../lib/ids.js";

export const exclusionsRouter = Router();
// Without a session nobody can read or change what checks ignore — a
// stranger could otherwise hide real failures by excluding them.
exclusionsRouter.use(requireAuth);


/**
 * Validates a create/edit body and converts it to column values. Only the
 * fields present are returned, so it serves both create and edit.
 *
 * @param body the JSON request body
 * @returns `values` to write, or `error` (a message for a 400 response)
 */
async function parse(body: Record<string, unknown>): Promise<{ values?: Partial<typeof exclusionLists.$inferInsert>; error?: string }> {
  const values: Partial<typeof exclusionLists.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim().slice(0, 120);
    if (!name) return { error: "name is required" };
    values.name = name;
  }
  if (body.description !== undefined) values.description = body.description ? String(body.description).trim().slice(0, 1000) : null;
  if (body.kind !== undefined) {
    // Object.hasOwn: only the kinds defined in the code, never inherited
    // object properties like "constructor".
    if (!Object.hasOwn(EXCLUSION_KINDS, String(body.kind))) return { error: `kind must be one of: ${Object.keys(EXCLUSION_KINDS).join(", ")}` };
    values.kind = String(body.kind);
  }
  if (body.items !== undefined) {
    // A list, or text with one item per line; each item at most 300
    // characters, at most 1000 items.
    const items = excludeItems(body.items).map((i) => i.slice(0, 300));
    values.items = [...new Set(items)];
  }
  if (body.applyToAll !== undefined) values.applyToAll = body.applyToAll === true;
  if (body.groupIds !== undefined) {
    const ids = Array.isArray(body.groupIds) ? [...new Set(body.groupIds.map(String))].slice(0, 100) : [];
    if (ids.some((id) => !isUuid(id))) return { error: "groupIds must be group IDs" };
    // Every group must exist, so a list can't silently apply to nothing.
    const found = ids.length ? await db.select({ id: groups.id }).from(groups).where(inArray(groups.id, ids)) : [];
    if (found.length !== ids.length) return { error: "One or more groups don't exist" };
    values.groupIds = ids;
  }
  if (body.enabled !== undefined) values.enabled = body.enabled !== false;
  return { values };
}

// GET /api/exclusion-lists/kinds — every kind of item, how it matches and
// which check types use it (for the dashboard's form and help text).
exclusionsRouter.get("/kinds", (_req, res) => {
  res.json(Object.entries(EXCLUSION_KINDS).map(([id, k]) => ({ id, ...k })));
});

// GET /api/exclusion-lists — every list, by name.
exclusionsRouter.get("/", async (_req, res) => {
  res.json(await db.query.exclusionLists.findMany({ orderBy: asc(exclusionLists.name) }));
});

// POST /api/exclusion-lists — create a list. Needs a name and a kind.
exclusionsRouter.post("/", async (req, res) => {
  const { values, error } = await parse(req.body ?? {});
  if (error || !values?.name || !values.kind) {
    res.status(400).json({ error: error ?? "name and kind are required" });
    return;
  }
  const [row] = await db.insert(exclusionLists).values(values as typeof exclusionLists.$inferInsert).returning();
  invalidateExclusionCache();
  res.status(201).json(row);
});

// PATCH /api/exclusion-lists/:id — change some fields of a list.
exclusionsRouter.patch("/:id", async (req, res) => {
  if (!isUuid(req.params.id)) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  const { values, error } = await parse(req.body ?? {});
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [row] = await db
    .update(exclusionLists)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(exclusionLists.id, req.params.id))
    .returning();
  if (!row) {
    res.status(404).json({ error: "Exclusion list not found" });
    return;
  }
  invalidateExclusionCache();
  res.json(row);
});

// DELETE /api/exclusion-lists/:id — removes a list; checks stop ignoring
// its items on their next run.
exclusionsRouter.delete("/:id", async (req, res) => {
  if (isUuid(req.params.id)) await db.delete(exclusionLists).where(eq(exclusionLists.id, req.params.id));
  invalidateExclusionCache();
  res.status(204).end();
});
