// API routes for SNMP templates: /api/snmp-templates — list (built-in +
// your own), create, edit, delete, and apply to a device (which creates its
// checks).
//
// Where this sits: called by the dashboard's SNMP templates page and the
// "Apply SNMP template" dialog on endpoints. Templates are stored in table
// snmp_templates; built-in ones are defined in services/snmpTemplates.ts and
// can't be changed or deleted (copy one instead).
//
// Security: every route requires a signed-in session (requireAuth). Each
// template item is validated (known presets and modes, real OIDs, numeric
// thresholds, expressions that parse) before it's stored or applied. The
// device's SNMP credentials sent with "apply" go into the created checks'
// config exactly as when a check is created by hand — write-only from then
// on, like every check secret.

import { Router } from "express";
import { asc, eq } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, endpoints, sites, snmpTemplates } from "../db/schema.js";
import { requireAuth } from "../middleware/auth.js";
import { BUILTIN_TEMPLATES, cleanItem, itemConfig, type SnmpTemplate, type TemplateItem } from "../services/snmpTemplates.js";
import { createAlertRule, parseAlertRule } from "../services/alertRuleFactory.js";
import { logger } from "../lib/logger.js";
import { own, setOwn } from "../lib/own.js";
import { isOid } from "../services/probes/mibs.js";
import { isUuid } from "../lib/ids.js";

export const snmpTemplatesRouter = Router();
// Without a session nobody can read or change templates, or create checks.
snmpTemplatesRouter.use(requireAuth);


/** A stored template in the API's shape. */
const view = (t: typeof snmpTemplates.$inferSelect): SnmpTemplate => ({ id: t.id, name: t.name, description: t.description, matchSysObjectId: t.matchSysObjectId, items: t.items as TemplateItem[], builtIn: false });

/** Finds a template by ID — built-in ("builtin:…") or stored. */
async function find(id: string): Promise<SnmpTemplate | null> {
  if (id.startsWith("builtin:")) return BUILTIN_TEMPLATES.find((t) => t.id === id) ?? null;
  if (!isUuid(id)) return null;
  const row = await db.query.snmpTemplates.findFirst({ where: eq(snmpTemplates.id, id) });
  return row ? view(row) : null;
}

/**
 * Validates a create/edit body. Only fields present are returned.
 *
 * @returns column values, or an error for a 400 response
 */
function parse(body: Record<string, unknown>): { values?: Partial<typeof snmpTemplates.$inferInsert>; error?: string } {
  const values: Partial<typeof snmpTemplates.$inferInsert> = {};
  if (body.name !== undefined) {
    const name = String(body.name ?? "").trim().slice(0, 120);
    if (!name) return { error: "name is required" };
    values.name = name;
  }
  if (body.description !== undefined) values.description = body.description ? String(body.description).slice(0, 1000) : null;
  if (body.matchSysObjectId !== undefined) {
    const m = body.matchSysObjectId ? String(body.matchSysObjectId).trim().replace(/^\./, "") : "";
    if (m && !isOid(m)) return { error: "matchSysObjectId must be an OID prefix like 1.3.6.1.4.1.2435" };
    values.matchSysObjectId = m || null;
  }
  if (body.items !== undefined) {
    if (!Array.isArray(body.items) || !body.items.length) return { error: "A template needs at least one item" };
    if (body.items.length > 50) return { error: "At most 50 items" };
    const items: TemplateItem[] = [];
    for (const [i, raw] of body.items.entries()) {
      const { item, error } = cleanItem(raw, i);
      if (error || !item) return { error };
      items.push(item);
    }
    values.items = items;
  }
  return { values };
}

// GET /api/snmp-templates — built-in templates first, then yours by name.
snmpTemplatesRouter.get("/", async (_req, res) => {
  const own = await db.query.snmpTemplates.findMany({ orderBy: asc(snmpTemplates.name) });
  res.json([...BUILTIN_TEMPLATES, ...own.map(view)]);
});

// GET /api/snmp-templates/:id — one template.
snmpTemplatesRouter.get("/:id", async (req, res) => {
  const t = await find(req.params.id);
  if (!t) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(t);
});

// POST /api/snmp-templates — create one (name and items required).
snmpTemplatesRouter.post("/", async (req, res) => {
  const { values, error } = parse(req.body ?? {});
  if (error || !values?.name || !values.items) {
    res.status(400).json({ error: error ?? "name and items are required" });
    return;
  }
  const [row] = await db.insert(snmpTemplates).values(values as typeof snmpTemplates.$inferInsert).returning();
  res.status(201).json(view(row));
});

// PATCH /api/snmp-templates/:id — change one of your templates.
snmpTemplatesRouter.patch("/:id", async (req, res) => {
  if (req.params.id.startsWith("builtin:")) {
    res.status(400).json({ error: "Built-in templates can't be changed — copy it and change the copy" });
    return;
  }
  const { values, error } = parse(req.body ?? {});
  if (error) {
    res.status(400).json({ error });
    return;
  }
  const [row] = isUuid(req.params.id) ? await db.update(snmpTemplates).set({ ...values, updatedAt: new Date() }).where(eq(snmpTemplates.id, req.params.id)).returning() : [];
  if (!row) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  res.json(view(row));
});

// DELETE /api/snmp-templates/:id — delete one of your templates. Checks
// already created from it stay.
snmpTemplatesRouter.delete("/:id", async (req, res) => {
  if (req.params.id.startsWith("builtin:")) {
    res.status(400).json({ error: "Built-in templates can't be deleted" });
    return;
  }
  if (isUuid(req.params.id)) await db.delete(snmpTemplates).where(eq(snmpTemplates.id, req.params.id));
  res.status(204).end();
});

// The SNMP settings a device brings to "apply": its address and credentials.
const DEVICE_KEYS = ["host", "port", "version", "community", "username", "securityLevel", "authProtocol", "authKey", "privProtocol", "privKey"];

// POST /api/snmp-templates/:id/apply { siteId, endpointId?, device: {host,
//   port, version, community | v3 settings}, namePrefix?, intervalSeconds?,
//   items? (indexes to create; default all), alertRule? }
// Creates one check per chosen item on the device and returns them.
snmpTemplatesRouter.post("/:id/apply", async (req, res) => {
  const t = await find(req.params.id);
  if (!t) {
    res.status(404).json({ error: "Template not found" });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const siteId = String(body.siteId ?? "");
  const site = isUuid(siteId) ? await db.query.sites.findFirst({ where: eq(sites.id, siteId) }) : undefined;
  if (!site) {
    res.status(400).json({ error: "Choose a site" });
    return;
  }
  // The endpoint, if given, must be in that site; its hostname is the
  // default address.
  const endpointId = body.endpointId ? String(body.endpointId) : null;
  const endpoint = endpointId && isUuid(endpointId) ? await db.query.endpoints.findFirst({ where: eq(endpoints.id, endpointId) }) : undefined;
  if (endpointId && (!endpoint || endpoint.siteId !== siteId)) {
    res.status(400).json({ error: "That endpoint isn't in the chosen site" });
    return;
  }
  const rawDevice = (body.device && typeof body.device === "object" ? body.device : {}) as Record<string, unknown>;
  const device: Record<string, unknown> = {};
  for (const k of DEVICE_KEYS) {
    const v = own(rawDevice, k);
    if (v !== undefined && v !== "") setOwn(device, k, k === "port" ? Number(v) : String(v).slice(0, 300));
  }
  if (!device.host && endpoint?.hostname) device.host = endpoint.hostname;
  if (!device.host) {
    res.status(400).json({ error: "The device's address (host) is required" });
    return;
  }
  const picked = Array.isArray(body.items) ? t.items.filter((_, i) => (body.items as unknown[]).map(Number).includes(i)) : t.items;
  if (!picked.length) {
    res.status(400).json({ error: "Choose at least one item" });
    return;
  }
  const prefix = String(body.namePrefix ?? endpoint?.name ?? device.host).trim().slice(0, 80);
  const defaultInterval = Math.min(86_400, Math.max(30, Number(body.intervalSeconds) || 300));
  const created = await db
    .insert(checks)
    .values(
      picked.map((item) => ({
        name: `${prefix}: ${item.name}`,
        siteId,
        endpointId: endpoint?.id ?? null,
        type: item.type ?? ("snmp" as const),
        config: itemConfig(item, device),
        intervalSeconds: item.intervalSeconds ?? defaultInterval,
        tags: [`template:${t.name}`.slice(0, 60)],
      }))
    )
    .returning({ id: checks.id, name: checks.name });
  const rule = parseAlertRule(body.alertRule);
  if (rule) for (const c of created) await createAlertRule(c.id, rule);
  logger.info("checks", `Applied SNMP template "${t.name}" to ${String(device.host)}: ${created.length} check(s)`, `Created ${created.length} checks from the "${t.name}" template.`);
  res.status(201).json({ created });
});
