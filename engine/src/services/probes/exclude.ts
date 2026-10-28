// Exclusions: which items a check should ignore, and how an item is matched.
//
// Where this sits: used by the checks that look at many items at once —
// trap/syslog messages (probes/internal.ts), SNMP interface tables, walks and
// templates (probes/snmp.ts), the agent's extended metrics (services/endpointMetrics.ts)
// — and by services/exclusions.ts, which merges a check's own `exclude`
// setting with the reusable exclusion lists before the check runs. This file
// has no database access, so the site collector (which bundles the network
// probes) can use it too.
//
// Two ways to match, depending on the kind of item:
// - names (mounts, interfaces, services, containers, …): the whole name,
//   ignoring upper/lower case, where `*` stands for any run of characters and
//   `?` for one character — "/snap/*" matches "/snap/core/123", "veth*"
//   matches "veth3a2f".
// - texts (log and event messages): the item appears anywhere in the
//   message, ignoring case — "scanner" matches "auth failure from scanner-01".
// Event IDs are names made of digits ("4625").

/** How a kind's items are compared with what the check sees. */
export type ExclusionMatch = "name" | "text";

/**
 * Every kind of exclusion item: its label, how it matches, and the check
 * types (by ID) that use it. host_metric only uses a kind when the chosen
 * metric is about that kind of item (see METRIC_INSTANCE_KINDS).
 */
export const EXCLUSION_KINDS: Record<string, { label: string; match: ExclusionMatch; types: string[]; help: string }> = {
  messages: {
    label: "Message texts",
    match: "text",
    types: ["trap_match", "syslog_match", "agent_log", "agent_journal", "agent_eventlog"],
    help: "Messages containing any of these texts are ignored (case doesn't matter).",
  },
  event_ids: { label: "Windows event IDs", match: "name", types: ["agent_eventlog"], help: "Events with these IDs are ignored, e.g. 10016." },
  mounts: { label: "Mount points / drives", match: "name", types: ["host_metric"], help: "Disks and filesystems mounted here are ignored, e.g. /snap/* or /boot/efi." },
  interfaces: { label: "Network interfaces", match: "name", types: ["host_metric", "snmp_interfaces"], help: "Interfaces with these names (or SNMP aliases) are ignored, e.g. veth* or docker0." },
  devices: { label: "Disk devices", match: "name", types: ["host_metric"], help: "Disk devices (SMART, disk I/O) with these names are ignored, e.g. loop*." },
  sensors: { label: "Sensors and fans", match: "name", types: ["host_metric"], help: "Temperature sensors and fans with these names are ignored." },
  services: { label: "Services", match: "name", types: ["agent_services_overview"], help: "Services or systemd units with these names are ignored." },
  containers: { label: "Docker containers", match: "name", types: ["agent_docker"], help: "Containers with these names are ignored, e.g. *-migrate." },
  vms: { label: "Hyper-V virtual machines", match: "name", types: ["agent_hyperv"], help: "VMs with these names are ignored." },
  packages: { label: "Software packages", match: "name", types: ["host_packages", "host_software", "host_vulnerable"], help: "Packages with these names are ignored, e.g. linux-image-*." },
  users: { label: "User accounts", match: "name", types: ["agent_users"], help: "Accounts with these names are ignored by the user accounts check, e.g. a service account whose password rotates (svc-backup) or temporary accounts (tmp-*)." },
  snmp_values: {
    label: "SNMP rows and values",
    match: "name",
    types: ["snmp"],
    help: "Rows of an SNMP walk or template whose index, name or value matches are left out — e.g. a disk name (/run*), a printer supply (Waste*), a row index (1.5) or a value (Virtual Memory).",
  },
};

/**
 * Which exclusion kind a host_metric's "instance" refers to. A disk metric
 * ignores excluded mounts, a network metric excluded interfaces, and so on;
 * metrics without instances (CPU, memory) have no exclusions.
 */
export const METRIC_INSTANCE_KINDS: Record<string, string> = { mount: "mounts", interface: "interfaces", device: "devices", sensor: "sensors", fan: "sensors" };

/**
 * The exclusion kinds a check of this type (and, for host_metric, this
 * metric instance kind) uses.
 *
 * @param type the check type ID
 * @param instanceKind host_metric only: the chosen metric's instance kind
 */
export function kindsForType(type: string, instanceKind?: string): string[] {
  if (type === "host_metric") {
    const kind = instanceKind && Object.hasOwn(METRIC_INSTANCE_KINDS, instanceKind) ? (Reflect.get(METRIC_INSTANCE_KINDS, instanceKind) as string) : undefined;
    return kind ? [kind] : [];
  }
  return Object.entries(EXCLUSION_KINDS)
    .filter(([, k]) => k.types.includes(type))
    .map(([id]) => id);
}

/**
 * A check's exclude setting as a list. The setting may be a list already, or
 * text with one item per line. Commas also separate name items (older
 * settings were written as "a, b"), but never message texts, which can
 * contain commas.
 *
 * @param value config.exclude as stored
 * @param splitCommas true for name items
 * @returns the trimmed, non-empty items (at most 1000)
 */
export function excludeItems(value: unknown, splitCommas = false): string[] {
  const parts = Array.isArray(value) ? value.map(String) : typeof value === "string" ? value.split(splitCommas ? /[\r\n,]+/ : /\r?\n/) : [];
  return parts.map((s) => s.trim()).filter(Boolean).slice(0, 1000);
}

/**
 * Whether a whole name matches a wildcard pattern: `*` = any run of
 * characters (including none), `?` = exactly one character, everything else
 * literal; case is ignored. Uses the classic two-pointer wildcard algorithm
 * (no regular expressions): when a `*` can't extend the match it backs up to
 * the most recent `*` only, so the work is at most name length × pattern
 * length — a crafted pattern can't make it run away.
 *
 * @param pattern e.g. "veth*" or "eth?"
 * @param name the item's name
 */
export function globMatch(pattern: string, name: string): boolean {
  const p = pattern.toLowerCase();
  const n = name.toLowerCase();
  let pi = 0;
  let ni = 0;
  // Where the last * was in the pattern, and where in the name it started.
  let star = -1;
  let starNi = 0;
  while (ni < n.length) {
    const pc = p.charAt(pi);
    if (pi < p.length && (pc === "?" || pc === n.charAt(ni))) {
      pi++;
      ni++;
    } else if (pc === "*") {
      star = pi++;
      starNi = ni;
    } else if (star >= 0) {
      // Let the last * swallow one more character and try again.
      pi = star + 1;
      ni = ++starNi;
    } else {
      return false;
    }
  }
  // Only trailing *s may be left over in the pattern.
  while (p.charAt(pi) === "*") pi++;
  return pi === p.length;
}

/**
 * Whether a name (mount, interface, service, container, event ID…) is
 * excluded by any of the patterns.
 *
 * @param name the item's name; empty names are never excluded
 * @param patterns the exclusion items (name patterns)
 */
export function nameExcluded(name: string | null | undefined, patterns: string[]): boolean {
  if (!name || !patterns.length) return false;
  return patterns.some((p) => (p.includes("*") || p.includes("?") ? globMatch(p, name) : p.toLowerCase() === name.toLowerCase()));
}

/**
 * Whether a message contains any of the exclusion texts (case ignored).
 *
 * @param text the message
 * @param items the exclusion texts
 */
export function textExcluded(text: string | null | undefined, items: string[]): boolean {
  if (!text || !items.length) return false;
  const lower = text.toLowerCase();
  return items.some((i) => lower.includes(i.toLowerCase()));
}
