// SNMP templates: a named set of SNMP checks — OIDs, calculations and
// thresholds — applied to a device in one step ("make me the usual checks
// for this printer / UPS / NAS / switch").
//
// Two sources:
//   - built-in starter templates (BUILTIN_TEMPLATES below): generic and
//     per-brand printers, UPS (standard and APC), Synology NAS, Linux and
//     other Net-SNMP hosts, Cisco, Dell iDRAC, any switch. Read-only, but
//     they can be copied and changed;
//   - the admin's own templates (table snmp_templates).
//
// Where this sits: routes/snmpTemplates.ts (list, create, edit, delete,
// apply). Applying creates ordinary "snmp" / "snmp_interfaces" checks, one
// per template item, using the device's address and SNMP credentials given
// at that moment. Every item is validated here before it's stored, so a
// template can only ever produce well-formed checks.

import { SNMP_PRESETS, parseExtraOids } from "./probes/snmp.js";
import { evaluateExpression, expressionNames } from "./probes/expression.js";
import { deleteOwn, own } from "../lib/own.js";
import { isOid } from "./probes/mibs.js";

/** One check a template creates. Keys mirror the snmp check's config. */
export type TemplateItem = {
  name: string;
  type?: "snmp" | "snmp_interfaces";
  preset?: string;
  oid?: string;
  mode?: string;
  aggregate?: string;
  asRate?: boolean;
  scale?: number;
  unit?: string;
  expression?: string;
  extraOids?: string;
  expectString?: string;
  warnAbove?: number;
  criticalAbove?: number;
  warnBelow?: number;
  criticalBelow?: number;
  intervalSeconds?: number;
  note?: string;
};

/** A template as the API returns it. */
export type SnmpTemplate = { id: string; name: string; description: string | null; matchSysObjectId: string | null; items: TemplateItem[]; builtIn: boolean };

// ---- Built-in starter templates ----

// What every printer offers through the standard Printer-MIB and
// HOST-RESOURCES-MIB, whatever the brand.
const PRINTER_ITEMS: TemplateItem[] = [
  { name: "Toner / ink (lowest)", preset: "printer_supplies", warnBelow: 15, criticalBelow: 5 },
  { name: "Printer errors", preset: "printer_status" },
  { name: "Failed print jobs", preset: "printer_jobs" },
  { name: "Total pages printed", oid: "1.3.6.1.2.1.43.10.2.1.4.1.1", unit: " pages", intervalSeconds: 3600, note: "Printer-MIB prtMarkerLifeCount; for trend graphs." },
  { name: "Restarted", preset: "uptime_reboot" },
];

// Printer brands by IANA enterprise number, for sysObjectID matching. Extra
// items are vendor counters that are widely documented but vary by model.
const PRINTER_BRANDS: { brand: string; number: number; extra?: TemplateItem[] }[] = [
  { brand: "HP", number: 11 },
  { brand: "Brother", number: 2435 },
  { brand: "Canon", number: 1602, extra: [{ name: "Canon total counter", oid: "1.3.6.1.4.1.1602.1.11.1.3.1.4.101", unit: " pages", intervalSeconds: 3600, note: "imageRUNNER billing counter 101; varies by model — confirm with Walk." }] },
  { brand: "Epson", number: 1248 },
  { brand: "Konica Minolta", number: 18334 },
  { brand: "Kyocera", number: 1347 },
  { brand: "Lexmark", number: 641 },
  { brand: "OKI", number: 2001 },
  { brand: "Ricoh", number: 367, extra: [{ name: "Ricoh engine total counter", oid: "1.3.6.1.4.1.367.3.2.1.2.19.1.0", unit: " pages", intervalSeconds: 3600, note: "Varies by model — confirm with Walk." }] },
  { brand: "Samsung", number: 236 },
  { brand: "Sharp", number: 2385 },
  { brand: "Toshiba", number: 1129 },
  { brand: "Xerox", number: 253, extra: [{ name: "Xerox total impressions", oid: "1.3.6.1.4.1.253.8.53.13.2.1.6.1.20.1", unit: " impressions", intervalSeconds: 3600, note: "Varies by model — confirm with Walk." }] },
];

export const BUILTIN_TEMPLATES: SnmpTemplate[] = [
  { id: "builtin:printer", name: "Printer (any brand)", description: "Toner/ink, errors (jam, paper out, door open), failed jobs, page count and restarts — standard Printer-MIB, which every major brand supports.", matchSysObjectId: null, items: PRINTER_ITEMS, builtIn: true },
  ...PRINTER_BRANDS.map(
    (b): SnmpTemplate => ({
      id: `builtin:printer-${b.brand.toLowerCase().replace(/\s+/g, "-")}`,
      name: `${b.brand} printer`,
      description: `The standard printer checks${b.extra ? ` plus ${b.brand}'s own page counter` : ""}. Suggested for devices identifying as ${b.brand} (enterprise ${b.number}).`,
      matchSysObjectId: `1.3.6.1.4.1.${b.number}`,
      items: [...PRINTER_ITEMS, ...(b.extra ?? [])],
      builtIn: true,
    })
  ),
  {
    id: "builtin:ups",
    name: "UPS (standard UPS-MIB)",
    description: "Battery charge and state, runtime left, on battery, output load — RFC 1628, used by Eaton, CyberPower, Riello and many network cards.",
    matchSysObjectId: null,
    builtIn: true,
    items: [
      { name: "Battery charge", preset: "ups_battery", warnBelow: 50, criticalBelow: 20 },
      { name: "Runtime left", preset: "ups_runtime", warnBelow: 15, criticalBelow: 5 },
      { name: "On battery", preset: "ups_on_battery" },
      { name: "Battery status", oid: "1.3.6.1.2.1.33.1.2.1.0", warnAbove: 2, criticalAbove: 3, note: "2 normal, 3 low, 4 depleted." },
      { name: "Output load", oid: "1.3.6.1.2.1.33.1.4.4.1.5.1", unit: "%", warnAbove: 80, criticalAbove: 95 },
    ],
  },
  {
    id: "builtin:ups-apc",
    name: "APC UPS (PowerNet)",
    description: "APC network management cards: charge, runtime, load, temperature, battery replacement and on-battery.",
    matchSysObjectId: "1.3.6.1.4.1.318",
    builtIn: true,
    items: [
      { name: "Battery charge", oid: "1.3.6.1.4.1.318.1.1.1.2.2.1.0", unit: "%", warnBelow: 50, criticalBelow: 20 },
      { name: "Runtime left", oid: "1.3.6.1.4.1.318.1.1.1.2.2.3.0", expression: "value / 6000", unit: " min", warnBelow: 15, criticalBelow: 5, note: "TimeTicks ÷ 6000 = minutes." },
      { name: "Output load", oid: "1.3.6.1.4.1.318.1.1.1.4.2.3.0", unit: "%", warnAbove: 80, criticalAbove: 95 },
      { name: "Battery temperature", oid: "1.3.6.1.4.1.318.1.1.1.2.2.2.0", unit: "°C", warnAbove: 40, criticalAbove: 50 },
      { name: "Battery needs replacing", oid: "1.3.6.1.4.1.318.1.1.1.2.2.4.0", warnAbove: 1.5, note: "1 no, 2 yes." },
      { name: "On battery", oid: "1.3.6.1.4.1.318.1.1.1.4.1.1.0", warnAbove: 2.5, note: "2 online, 3 on battery, others: bypass/off." },
    ],
  },
  {
    id: "builtin:synology",
    name: "Synology NAS",
    description: "System, power, fans, temperature, every disk and storage pool, and DSM updates.",
    matchSysObjectId: "1.3.6.1.4.1.6574",
    builtIn: true,
    items: [
      { name: "System status", oid: "1.3.6.1.4.1.6574.1.1.0", criticalAbove: 1.5, note: "1 normal, 2 failed." },
      { name: "Temperature", oid: "1.3.6.1.4.1.6574.1.2.0", unit: "°C", warnAbove: 60, criticalAbove: 70 },
      { name: "Power supply", oid: "1.3.6.1.4.1.6574.1.3.0", criticalAbove: 1.5 },
      { name: "System fan", oid: "1.3.6.1.4.1.6574.1.4.1.0", criticalAbove: 1.5 },
      { name: "Disks (worst status)", oid: "1.3.6.1.4.1.6574.2.1.1.5", mode: "walk_max", criticalAbove: 3.5, note: "1 normal, 2–3 not initialised, 4 system partition failed, 5 crashed." },
      { name: "Hottest disk", oid: "1.3.6.1.4.1.6574.2.1.1.6", mode: "walk_max", unit: "°C", warnAbove: 50, criticalAbove: 60 },
      { name: "Storage pools (worst status)", oid: "1.3.6.1.4.1.6574.3.1.1.3", mode: "walk_max", warnAbove: 1.5, criticalAbove: 10.5, note: "1 normal, 2–10 repairing/syncing, 11 degraded, 12 crashed." },
      { name: "DSM update available", oid: "1.3.6.1.4.1.6574.1.5.4.0", warnBelow: 1.5, intervalSeconds: 3600, note: "1 = an update is available." },
    ],
  },
  {
    id: "builtin:netsnmp",
    name: "Linux / Net-SNMP host",
    description: "CPU, memory, load, fullest disk and restarts from Net-SNMP (snmpd) — Linux servers, pfSense, OPNsense and many appliances.",
    matchSysObjectId: "1.3.6.1.4.1.8072",
    builtIn: true,
    items: [
      { name: "CPU busy", extraOids: "idle = 1.3.6.1.4.1.2021.11.11.0", expression: "100 - idle", unit: "%", warnAbove: 85, criticalAbove: 95 },
      { name: "Memory used", extraOids: "total = 1.3.6.1.4.1.2021.4.5.0\navail = 1.3.6.1.4.1.2021.4.6.0\nbuffers = 1.3.6.1.4.1.2021.4.14.0\ncached = 1.3.6.1.4.1.2021.4.15.0", expression: "round((total - avail - buffers - cached) / total * 100, 1)", unit: "%", warnAbove: 90, criticalAbove: 97 },
      { name: "Load (1 min)", oid: "1.3.6.1.4.1.2021.10.1.5.1", scale: 0.01 },
      { name: "Fullest disk", oid: "1.3.6.1.4.1.2021.9.1.9", mode: "walk_max", unit: "%", warnAbove: 85, criticalAbove: 95, note: "Only disks listed with \"disk\" lines in snmpd.conf." },
      { name: "Restarted", preset: "uptime_reboot" },
    ],
  },
  {
    id: "builtin:cisco",
    name: "Cisco switch / router",
    description: "CPU, memory, fans, power supplies, temperature, ports and restarts.",
    matchSysObjectId: "1.3.6.1.4.1.9",
    builtIn: true,
    items: [
      { name: "CPU (5 min)", oid: "1.3.6.1.4.1.9.9.109.1.1.1.1.8.1", unit: "%", warnAbove: 80, criticalAbove: 95 },
      { name: "Memory used", extraOids: "used = 1.3.6.1.4.1.9.9.48.1.1.1.5.1\nfree = 1.3.6.1.4.1.9.9.48.1.1.1.6.1", expression: "round(used / (used + free) * 100, 1)", unit: "%", warnAbove: 85, criticalAbove: 95 },
      { name: "Fans (worst state)", oid: "1.3.6.1.4.1.9.9.13.1.4.1.3", mode: "walk_max", warnAbove: 1.5, criticalAbove: 2.5, note: "1 normal, 2 warning, 3 critical, 4 shutdown." },
      { name: "Power supplies (worst state)", oid: "1.3.6.1.4.1.9.9.13.1.5.1.3", mode: "walk_max", warnAbove: 1.5, criticalAbove: 2.5 },
      { name: "Hottest sensor", oid: "1.3.6.1.4.1.9.9.13.1.3.1.3", mode: "walk_max", unit: "°C", warnAbove: 55, criticalAbove: 65 },
      { name: "Ports", type: "snmp_interfaces" },
      { name: "Restarted", preset: "uptime_reboot" },
    ],
  },
  {
    id: "builtin:idrac",
    name: "Dell server (iDRAC)",
    description: "Overall hardware health and power state from the iDRAC.",
    matchSysObjectId: "1.3.6.1.4.1.674",
    builtIn: true,
    items: [
      { name: "Hardware health", oid: "1.3.6.1.4.1.674.10892.5.2.1.0", warnAbove: 3.5, criticalAbove: 4.5, note: "3 ok, 4 non-critical, 5 critical, 6 non-recoverable." },
      { name: "Powered on", oid: "1.3.6.1.4.1.674.10892.5.2.4.0", criticalBelow: 3.5, note: "4 on, 3 off." },
    ],
  },
  {
    id: "builtin:switch",
    name: "Network switch (any brand)",
    description: "Every port (down, utilisation, errors), hottest sensor and restarts — standard MIBs only.",
    matchSysObjectId: null,
    builtIn: true,
    items: [
      { name: "Ports", type: "snmp_interfaces" },
      { name: "Hottest sensor", preset: "sensor_temp_max", warnAbove: 60, criticalAbove: 75 },
      { name: "Restarted", preset: "uptime_reboot" },
    ],
  },
];

// ---- Validation ----

const MODES = new Set(["get", "walk_avg", "walk_sum", "walk_min", "walk_max", "walk_count", "walk_all"]);
const AGGREGATES = new Set(["count", "sum", "avg", "min", "max"]);
const finite = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number.isFinite(Number(v)) ? Number(v) : NaN);

/**
 * Validates one template item, returning a clean copy (unknown fields
 * dropped) or an error.
 *
 * @param raw the item from the request
 * @param index its position, for the error message
 */
export function cleanItem(raw: unknown, index: number): { item?: TemplateItem; error?: string } {
  const at = `Item ${index + 1}`;
  if (!raw || typeof raw !== "object") return { error: `${at} isn't an object` };
  const r = raw as Record<string, unknown>;
  const name = String(r.name ?? "").trim().slice(0, 120);
  if (!name) return { error: `${at} needs a name` };
  const item: TemplateItem = { name };
  const type = String(r.type ?? "snmp");
  if (type !== "snmp" && type !== "snmp_interfaces") return { error: `${at}: type must be snmp or snmp_interfaces` };
  if (type === "snmp_interfaces") item.type = "snmp_interfaces";
  if (r.preset) {
    // Object.hasOwn: only the presets defined in code.
    if (!Object.hasOwn(SNMP_PRESETS, String(r.preset))) return { error: `${at}: unknown template "${String(r.preset).slice(0, 40)}"` };
    item.preset = String(r.preset);
  }
  if (r.oid) {
    if (!isOid(String(r.oid))) return { error: `${at}: "${String(r.oid).slice(0, 60)}" isn't an OID` };
    item.oid = String(r.oid).replace(/^\./, "");
  }
  if (r.mode) {
    if (!MODES.has(String(r.mode))) return { error: `${at}: unknown read mode` };
    item.mode = String(r.mode);
  }
  if (r.aggregate) {
    if (!AGGREGATES.has(String(r.aggregate))) return { error: `${at}: unknown aggregate` };
    item.aggregate = String(r.aggregate);
  }
  if (r.asRate === true || r.asRate === "true") item.asRate = true;
  if (r.extraOids) {
    try {
      parseExtraOids(String(r.extraOids));
    } catch (err) {
      return { error: `${at}: ${err instanceof Error ? err.message : String(err)}` };
    }
    item.extraOids = String(r.extraOids).slice(0, 2000);
  }
  if (r.expression) {
    const expression = String(r.expression).slice(0, 500);
    // Check the expression parses: work it out once with every name set to 2
    // (only arithmetic problems like dividing by zero are allowed to fail).
    try {
      evaluateExpression(expression, Object.fromEntries(expressionNames(expression).map((n) => [n, 2])));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/Division by zero|finite/.test(msg)) return { error: `${at}: ${msg}` };
    }
    item.expression = expression;
  }
  for (const key of ["scale", "warnAbove", "criticalAbove", "warnBelow", "criticalBelow", "intervalSeconds"] as const) {
    const n = finite(own(r, key));
    if (Number.isNaN(n)) return { error: `${at}: ${key} must be a number` };
    if (n !== undefined) Object.assign(item, { [key]: n });
  }
  if (item.intervalSeconds !== undefined) item.intervalSeconds = Math.min(86_400, Math.max(30, Math.round(item.intervalSeconds)));
  for (const key of ["unit", "expectString", "note"] as const) {
    const v = own(r, key);
    if (v) Object.assign(item, { [key]: String(v).slice(0, key === "note" ? 300 : 60) });
  }
  if (type === "snmp" && !item.preset && !item.oid && !item.extraOids) return { error: `${at} needs an OID, a built-in template, or extra OIDs` };
  if (item.extraOids && !item.expression) return { error: `${at}: extra OIDs need a Calculate expression that uses them` };
  return { item };
}

/**
 * The check config an item produces on a device: the device's address and
 * SNMP credentials plus the item's own settings.
 *
 * @param item the template item
 * @param device host, port and SNMP credentials (version, community, v3 keys)
 */
export function itemConfig(item: TemplateItem, device: Record<string, unknown>): Record<string, unknown> {
  // Everything except what describes the item rather than configures it.
  const settings: Record<string, unknown> = { ...item };
  for (const key of ["name", "type", "intervalSeconds", "note"]) deleteOwn(settings, key);
  return { ...device, ...settings };
}

/**
 * The templates to suggest for a device, from its SNMP sysObjectID: those
 * whose "suggest for" prefix is the device's OID or a parent of it (matched
 * on whole OID parts, so 1.3.6.1.4.1.9 matches 1.3.6.1.4.1.9.1.516 but not
 * 1.3.6.1.4.1.99.…). The most specific prefix comes first, so a brand's own
 * template beats a generic one.
 *
 * @param sysObjectId the device's sysObjectID, e.g. "1.3.6.1.4.1.2435.2.3.9.1"
 * @param templates every template (built-in and the admin's own)
 * @returns id and name of each match, best first (empty if none)
 */
export function templatesForDevice(sysObjectId: string | undefined, templates: SnmpTemplate[]): { id: string; name: string }[] {
  if (!sysObjectId) return [];
  return templates
    .filter((t) => t.matchSysObjectId && (sysObjectId === t.matchSysObjectId || sysObjectId.startsWith(`${t.matchSysObjectId}.`)))
    .sort((a, b) => (b.matchSysObjectId?.length ?? 0) - (a.matchSysObjectId?.length ?? 0))
    .map((t) => ({ id: t.id, name: t.name }));
}
