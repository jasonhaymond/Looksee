// The Checks page (/manage): every check, grouped and filtered, with bulk
// actions (run, enable, maintenance, resolve, alert rules, add to group) and
// the inline detail. "use client" makes this a React component that runs in
// the browser; the engine refuses every call without a session.
//
// Filters cascade and take several values each: the location filter narrows
// which sites are offered, sites narrow endpoints, and those narrow the kinds
// and tags offered to what the remaining checks actually have. Ticking two
// values in one filter shows checks matching either; different filters must
// all match. Bulk actions run in the background once confirmed
// (lib/background.ts), so the page stays usable while they finish.

"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Channel, type Check, type Site, type Endpoint, type Location } from "../lib/api";
import { CATEGORIES, typeCategory, typeLabel } from "../lib/checkTypes";
import { PageHelp } from "../components/PageHelp";
import { CheckForm, TypePicker } from "../components/CheckForm";
import { CheckDetail, displayStatus } from "../components/CheckDetail";
import { AddToGroupDialog } from "../components/NodeViews";
import { AlertOptions, BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, FilterChip, Modal, MultiFilter, MultiPicker, PromptDialog, StatusBadge, Tags, alertRulePayload, availableOnly, emptyAlertOptions, inputClass, relativeTime, useSelection, useToast, type BulkAction, type FilterOption } from "../components/ui";
import { runInBackground } from "../lib/background";
import { pollEvery } from "../lib/poll";
import { own } from "../lib/own";
import { useStoredState } from "../lib/useStoredState";

const REFRESH_MS = 15_000;
const STATUS_ORDER: Record<string, number> = { down: 0, warn: 1, unknown: 2, maintenance: 3, up: 4, disabled: 5 };
const STATUS_FILTERS = ["all", "problems", "down", "warn", "up", "unknown", "maintenance", "disabled"] as const;
type GroupBy = "location" | "site" | "endpoint" | "category" | "status" | "none";
// Every valid grouping, so a stale or tampered saved preference is ignored.
const GROUP_BYS: GroupBy[] = ["location", "site", "endpoint", "category", "status", "none"];

type Dialog =
  | { kind: "add" }
  | { kind: "delete" }
  | { kind: "prompt"; title: string; label: string; help?: string; type?: "text" | "number"; options?: { value: string; label: string }[]; initial?: string; action: string; param: string; asNumber?: boolean; asList?: boolean }
  | { kind: "alertRule" }
  | { kind: "dependencies" }
  | { kind: "duplicate" }
  | { kind: "group" }
  | null;

/** A saved grouping choice, or undefined when what's stored isn't one. */
const parseGroupBy = (raw: string): GroupBy | undefined => (GROUP_BYS.some((g) => g === raw) ? (raw as GroupBy) : undefined);

export default function ChecksPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  // Each filter holds every ticked value (none ticked = no filtering).
  // Location values are location IDs, or "none" for sites without one.
  const [locationFilter, setLocationFilter] = useState<string[]>([]);
  const [siteFilter, setSiteFilter] = useState<string[]>([]);
  const [endpointFilter, setEndpointFilter] = useState<string[]>([]);
  const [categoryFilter, setCategoryFilter] = useState<string[]>([]);
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  // How the list is grouped, remembered in this browser (lib/useStoredState.ts).
  const [groupBy, setGroupBy] = useStoredState<GroupBy>("looksee.checks.groupBy.v5", "site", parseGroupBy, String);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [addType, setAddType] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(() =>
    Promise.all([api.checks(), api.sites(), api.endpoints(), api.channels(), api.locations()]).then(([c, e, h, ch, l]) => {
    setChecks(c);
    setSites(e);
    setEndpoints(h);
    setChannels(ch);
    setLocations(l);
    setLoaded(true);
  }), []);

  useEffect(() => {
    api
      .me()
      .then(() => setAuthChecked(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    load();
    const t = pollEvery(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [authChecked, load]);

  const siteName = useMemo(() => new Map(sites.map((e) => [e.id, e.name])), [sites]);
  const endpointName = useMemo(() => new Map(endpoints.map((h) => [h.id, h.name])), [endpoints]);
  const locationName = useMemo(() => new Map(locations.map((l) => [l.id, l.name])), [locations]);

  // The cascade, biggest filter first. Each step offers only what's left
  // after the filters above it, and ignores ticked values no longer offered
  // (availableOnly) — so ticking a location hides other locations' sites
  // and endpoints, and the kinds/tags lists only show what those checks have.
  const cascade = useMemo(() => {
    // A site's location key: its location's ID, or "none" (also for a
    // location that no longer exists).
    const locOf = new Map(sites.map((e) => [e.id, e.locationId && locationName.has(e.locationId) ? e.locationId : "none"]));
    const locationOptions: FilterOption[] = [...locations.map((l) => ({ value: l.id, label: l.name })), ...(sites.some((e) => locOf.get(e.id) === "none") ? [{ value: "none", label: "No location" }] : [])];
    const locs = availableOnly(locationFilter, locationOptions);
    const inLocation = (siteId: string) => !locs.length || locs.includes(locOf.get(siteId) ?? "none");

    const siteOptions: FilterOption[] = sites.filter((e) => inLocation(e.id)).map((e) => ({ value: e.id, label: e.name }));
    const siteIds = availableOnly(siteFilter, siteOptions);
    const inSites = (siteId: string) => inLocation(siteId) && (!siteIds.length || siteIds.includes(siteId));

    const endpointOptions: FilterOption[] = endpoints.filter((h) => inSites(h.siteId)).map((h) => ({ value: h.id, label: h.name }));
    const endpointIds = availableOnly(endpointFilter, endpointOptions);
    // An endpoint matches the checks on it and the ones its agent runs for others.
    const placed = checks.filter((c) => inSites(c.siteId) && (!endpointIds.length || endpointIds.some((id) => c.endpointId === id || c.probeEndpointId === id)));

    const categoryOptions: FilterOption[] = CATEGORIES.filter((cat) => placed.some((c) => typeCategory(c.type) === cat)).map((cat) => ({ value: cat, label: cat }));
    const cats = availableOnly(categoryFilter, categoryOptions);
    const ofKind = placed.filter((c) => !cats.length || cats.includes(typeCategory(c.type)));

    const tagOptions: FilterOption[] = [...new Set(ofKind.flatMap((c) => c.tags ?? []))].sort().map((t) => ({ value: t, label: t }));
    const tags = availableOnly(tagFilter, tagOptions);
    // Checks matching every filter except status and search — what the
    // status chips count.
    const scoped = ofKind.filter((c) => !tags.length || tags.some((t) => (c.tags ?? []).includes(t)));
    return { locationOptions, locs, siteOptions, siteIds, endpointOptions, endpointIds, categoryOptions, cats, tagOptions, tags, scoped };
  }, [checks, sites, endpoints, locations, locationName, locationFilter, siteFilter, endpointFilter, categoryFilter, tagFilter]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return cascade.scoped
      .filter((c) => {
        const st = displayStatus(c);
        if (statusFilter === "problems" && !["down", "warn"].includes(st)) return false;
        if (statusFilter !== "all" && statusFilter !== "problems" && st !== statusFilter) return false;
        if (q) {
          const hay = `${c.name} ${typeLabel(c.type)} ${c.lastMessage ?? ""} ${(c.tags ?? []).join(" ")} ${siteName.get(c.siteId) ?? ""} ${c.endpointId ? endpointName.get(c.endpointId) ?? "" : ""} ${JSON.stringify(c.config)}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (STATUS_ORDER[displayStatus(a)] ?? 9) - (STATUS_ORDER[displayStatus(b)] ?? 9) || a.name.localeCompare(b.name));
  }, [cascade, search, statusFilter, siteName, endpointName]);

  const groups = useMemo(() => {
    const keyOf = (c: Check): [string, string] => {
      switch (groupBy) {
        case "location":
          return c.locationId ? [c.locationId, locationName.get(c.locationId) ?? "Unknown location"] : ["", "No location"];
        case "site":
          return [c.siteId, siteName.get(c.siteId) ?? "Unknown site"];
        case "endpoint":
          return c.endpointId ? [c.endpointId, endpointName.get(c.endpointId) ?? "Unknown endpoint"] : ["", "No endpoint"];
        case "category":
          return [typeCategory(c.type), typeCategory(c.type)];
        case "status":
          return [displayStatus(c), displayStatus(c).toUpperCase()];
        default:
          return ["all", "All checks"];
      }
    };
    const map = new Map<string, { label: string; items: Check[] }>();
    for (const c of filtered) {
      const [k, label] = keyOf(c);
      if (!map.has(k)) map.set(k, { label, items: [] });
      map.get(k)!.items.push(c);
    }
    return [...map.entries()].sort((a, b) => (groupBy === "status" ? (STATUS_ORDER[a[0]] ?? 9) - (STATUS_ORDER[b[0]] ?? 9) : a[1].label.localeCompare(b[1].label)));
  }, [filtered, groupBy, siteName, endpointName, locationName]);

  const visibleIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const sel = useSelection(visibleIds);

  // Status chip counts, within the place/kind/tag filters.
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ch of cascade.scoped) c[displayStatus(ch)] = (c[displayStatus(ch)] ?? 0) + 1;
    return c;
  }, [cascade]);

  /**
   * Runs one bulk action on the selected checks (POST /api/checks/bulk),
   * shows how many were affected (and the first error, if any were
   * skipped), and reloads. The selection is read when the action starts —
   * it usually runs in the background after its dialog closes — and cleared
   * straight away for delete, whose checks are gone.
   */
  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Updated") {
    const ids = sel.ids;
    if (action === "delete") sel.clear();
    const res = await api.bulkChecks(ids, action, params);
    if (res.errors.length) toast.show(`${verb} ${res.affected}; ${res.errors.length} skipped: ${res.errors[0].error}`, "error");
    else toast.show(`${verb} ${res.affected} check(s).`);
    await load();
  }
  /** A bulk action with no dialog, started straight from the Actions menu, in the background. */
  const bulkNow = (label: string, action: string, verb?: string) => runInBackground(`${label} ${sel.ids.length} check(s)`, () => bulk(action, {}, verb));

  const prompt = (d: Omit<Extract<Dialog, { kind: "prompt" }>, "kind">) => setDialog({ kind: "prompt", ...d });
  const siteOptions = sites.map((e) => ({ value: e.id, label: e.name }));
  const endpointOptions = [{ value: "", label: "— none —" }, ...endpoints.map((h) => ({ value: h.id, label: h.name }))];

  const bulkActions: BulkAction[] = [
    { group: "State", key: "enable", label: "Enable", run: () => bulkNow("Enable", "enable") },
    { group: "State", key: "disable", label: "Disable", run: () => bulkNow("Disable", "disable") },
    { group: "State", key: "resolve", label: "Resolve…", hint: "Mark failing checks recovered now", run: () => prompt({ title: "Resolve checks", label: "Note (optional)", action: "resolve", param: "note", help: "Records an “up” result for each, closing their alerts. Checks that poll report their real status on their next run." }) },
    { group: "State", key: "run", label: "Run now", hint: "Engine and collector checks only", run: () => bulkNow("Run", "run_now", "Ran") },
    { group: "State", key: "maint", label: "Maintenance…", run: () => prompt({ title: "Put in maintenance", label: "For how many minutes?", type: "number", initial: "60", action: "maintenance", param: "minutes", asNumber: true, help: "Results are still recorded; alerts are held and SLA reports skip this time." }) },
    { group: "Alerts", key: "alert", label: "Add alert rule…", run: () => setDialog({ kind: "alertRule" }) },
    { group: "Alerts", key: "noalert", label: "Remove alert rules", run: () => bulkNow("Remove alert rules from", "clear_alert_rules", "Removed alert rules from") },
    { group: "Alerts", key: "deps", label: "Depends on…", run: () => setDialog({ kind: "dependencies" }) },
    { group: "Organize", key: "tags", label: "Add tags…", run: () => prompt({ title: "Add tags", label: "Tags (comma-separated)", action: "add_tags", param: "tags", asList: true }) },
    { group: "Organize", key: "untag", label: "Remove tags…", run: () => prompt({ title: "Remove tags", label: "Tags (comma-separated)", action: "remove_tags", param: "tags", asList: true }) },
    { group: "Organize", key: "move", label: "Move to site…", run: () => prompt({ title: "Move to site", label: "Site", options: siteOptions, action: "move", param: "siteId" }) },
    { group: "Organize", key: "endpoint", label: "Set endpoint…", run: () => prompt({ title: "Set endpoint", label: "Endpoint", options: endpointOptions, action: "set_endpoint", param: "endpointId" }) },
    { group: "Organize", key: "group", label: "Add to group…", run: () => setDialog({ kind: "group" }) },
    { group: "Organize", key: "dup", label: "Duplicate…", hint: "Copy to the same or other sites/endpoints", run: () => setDialog({ kind: "duplicate" }) },
    { group: "Schedule", key: "probe", label: "Run from…", run: () => prompt({ title: "Run from", label: "Where ping/TCP/HTTP/DNS/TLS checks run", options: [{ value: "", label: "Looksee engine" }, ...endpoints.map((h) => ({ value: h.id, label: `Agent on ${h.name}` }))], action: "set_probe_endpoint", param: "endpointId" }) },
    { group: "Schedule", key: "interval", label: "Interval…", run: () => prompt({ title: "Set check interval", label: "Seconds between checks", type: "number", initial: "60", action: "set_interval", param: "seconds", asNumber: true }) },
    { group: "Schedule", key: "retry", label: "Retry interval…", run: () => prompt({ title: "Set retry interval", label: "Seconds between checks while failing (0 to clear)", type: "number", initial: "30", action: "set_retry_interval", param: "seconds", asNumber: true }) },
    { key: "delete", label: "Delete…", danger: true, run: () => setDialog({ kind: "delete" }) },
  ];

  if (!authChecked) return null;

  const filtersActive = Boolean(search || statusFilter !== "all" || cascade.locs.length || cascade.siteIds.length || cascade.endpointIds.length || cascade.cats.length || cascade.tags.length);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Checks</h2>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setDialog({ kind: "add" })} disabled={sites.length === 0} title={sites.length ? undefined : "Create a site first"}>
            + Add check
          </Button>
        </div>
      </div>
      <PageHelp anchor="checks">Everything Looksee monitors. Filter, group, tick several, and act on them together from the bar that appears at the bottom.</PageHelp>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => {
          const n = s === "all" ? cascade.scoped.length : s === "problems" ? (counts.down ?? 0) + (counts.warn ?? 0) : (own(counts, s) ?? 0);
          if (s !== "all" && s !== "problems" && n === 0) return null;
          return (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
              {s === "all" ? "All" : s === "problems" ? "Problems" : s[0].toUpperCase() + s.slice(1)} {n}
            </FilterChip>
          );
        })}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-7">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, type, endpoint, site, message, tag…" className={`${inputClass} col-span-2`} aria-label="Search checks" />
        <MultiFilter noun="location" options={cascade.locationOptions} selected={cascade.locs} onChange={setLocationFilter} />
        <MultiFilter noun="site" options={cascade.siteOptions} selected={cascade.siteIds} onChange={setSiteFilter} />
        <MultiFilter noun="endpoint" options={cascade.endpointOptions} selected={cascade.endpointIds} onChange={setEndpointFilter} />
        <MultiFilter noun="kind" options={cascade.categoryOptions} selected={cascade.cats} onChange={setCategoryFilter} />
        <MultiFilter noun="tag" options={cascade.tagOptions} selected={cascade.tags} onChange={setTagFilter} />
      </div>

      <div className="mb-2 flex flex-wrap items-center gap-3 text-sm">
        <label className="flex items-center gap-2">
          <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(visibleIds, on)} label="Select all shown" />
          <span className="text-[var(--muted)]">Select all {filtered.length} shown</span>
        </label>
        <span className="flex-1" />
        {filtersActive && (
          <button
            className="text-xs text-[var(--muted)] underline"
            onClick={() => {
              setSearch("");
              setStatusFilter("all");
              setSiteFilter([]);
              setLocationFilter([]);
              setEndpointFilter([]);
              setCategoryFilter([]);
              setTagFilter([]);
            }}
          >
            Clear filters
          </button>
        )}
        <label className="flex items-center gap-2 text-[var(--muted)]">
          Group by
          <select
            value={groupBy}
            onChange={(e) => {
              setGroupBy(e.target.value as GroupBy);
            }}
            className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
          >
            <option value="location">Location</option>
            <option value="site">Site</option>
            <option value="endpoint">Endpoint</option>
            <option value="category">Kind</option>
            <option value="status">Status</option>
            <option value="none">Nothing</option>
          </select>
        </label>
      </div>

      {loaded && checks.length === 0 ? (
        <EmptyState>
          No checks yet. {sites.length === 0 ? "Create a site on the Sites page first, then " : ""}use <strong>+ Add check</strong> — or scan your network from <a className="underline" href="/discovery">Discovery</a>.
        </EmptyState>
      ) : loaded && filtered.length === 0 ? (
        <EmptyState>No checks match these filters.</EmptyState>
      ) : (
        <div className="space-y-4">
          {groups.map(([key, group]) => {
            const ids = group.items.map((c) => c.id);
            const all = ids.every((id) => sel.selected.has(id));
            const some = ids.some((id) => sel.selected.has(id));
            const isCollapsed = collapsed.has(key);
            const problems = group.items.filter((c) => ["down", "warn"].includes(displayStatus(c))).length;
            return (
              <section key={key} className="surface overflow-hidden rounded-xl">
                {groupBy !== "none" && (
                  <div className="flex items-center gap-3 border-b border-[var(--border)] px-3 py-2">
                    <Checkbox checked={all} indeterminate={some} onChange={(on) => sel.setMany(ids, on)} label={`Select all in ${group.label}`} />
                    <button
                      className="flex flex-1 items-center gap-2 text-left"
                      onClick={() =>
                        setCollapsed((prev) => {
                          const next = new Set(prev);
                          if (next.has(key)) next.delete(key);
                          else next.add(key);
                          return next;
                        })
                      }
                      aria-expanded={!isCollapsed}
                    >
                      <span className="text-xs text-[var(--muted)]">{isCollapsed ? "▸" : "▾"}</span>
                      <span className="font-medium">{group.label}</span>
                      <span className="text-xs text-[var(--muted)]">
                        {group.items.length} check{group.items.length === 1 ? "" : "s"}
                        {problems > 0 && <span className="text-[var(--down)]"> · {problems} with problems</span>}
                      </span>
                    </button>
                  </div>
                )}
                {!isCollapsed && (
                  <div role="table" aria-label={`Checks in ${group.label}`}>
                    <div role="row" className="hidden grid-cols-[28px_110px_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,2fr)_90px] gap-3 bg-[var(--panel-2)] px-3 py-1.5 text-xs text-[var(--muted)] md:grid">
                      <span />
                      <span role="columnheader">Status</span>
                      <span role="columnheader">Name</span>
                      <span role="columnheader">Kind / where</span>
                      <span role="columnheader">Last result</span>
                      <span role="columnheader">Checked</span>
                    </div>
                    {group.items.map((c) => {
                      const open = expanded === c.id;
                      const where = [c.endpointId ? endpointName.get(c.endpointId) : null, c.probeEndpointId ? `via ${endpointName.get(c.probeEndpointId) ?? "agent"}` : c.collectorEndpointId ? `via site collector ${endpointName.get(c.collectorEndpointId) ?? ""}`.trim() : null, groupBy !== "site" ? siteName.get(c.siteId) : null].filter(Boolean).join(" · ");
                      return (
                        <Fragment key={c.id}>
                          <div
                            role="row"
                            onClick={() => setExpanded(open ? null : c.id)}
                            className={`grid cursor-pointer grid-cols-[28px_1fr] gap-x-3 gap-y-1 border-t border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--panel-2)] md:grid-cols-[28px_110px_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,2fr)_90px] md:items-center ${sel.selected.has(c.id) ? "bg-[var(--accent)]/10" : ""}`}
                          >
                            <span className="row-span-4 pt-0.5 md:row-span-1 md:pt-0">
                              <Checkbox checked={sel.selected.has(c.id)} onChange={() => sel.toggle(c.id)} label={`Select ${c.name}`} />
                            </span>
                            <span className="flex items-center gap-2 md:block">
                              <StatusBadge status={displayStatus(c)} />
                              <span className="font-medium md:hidden">{c.name}</span>
                            </span>
                            <span className="hidden min-w-0 md:block">
                              <span className="block truncate font-medium">{c.name}</span>
                              <Tags tags={c.tags} />
                            </span>
                            <span className="min-w-0 text-xs text-[var(--muted)]">
                              <span className="block truncate">{typeLabel(c.type)}</span>
                              {where && <span className="block truncate">{where}</span>}
                            </span>
                            <span className="min-w-0 text-xs">
                              <span className="block truncate" title={c.lastMessage ?? ""}>
                                {c.flapping ? "Flapping · " : ""}
                                {c.blockedBy ? `Parent ${c.blockedBy} down · ` : ""}
                                {c.lastMessage ?? (c.lastCheckedAt ? "OK" : "No results yet")}
                              </span>
                              <span className="md:hidden">
                                <Tags tags={c.tags} />
                              </span>
                            </span>
                            <span className="text-xs text-[var(--muted)]">
                              {relativeTime(c.lastCheckedAt)}
                              {c.lastLatencyMs != null && <span className="block">{c.lastLatencyMs} ms</span>}
                            </span>
                          </div>
                          {open && (
                            <div role="row">
                              <CheckDetail check={c} sites={sites} endpoints={endpoints} checks={checks} onChanged={load} />
                            </div>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}

      <BulkBar count={sel.ids.length} noun="check" actions={bulkActions} onClear={sel.clear} />

      {dialog?.kind === "add" && (
        <Modal
          title={addType ? `Add check — ${typeLabel(addType)}` : "Add a check — what do you want to monitor?"}
          wide
          onClose={() => {
            setDialog(null);
            setAddType(null);
          }}
        >
          {addType ? (
            <CheckForm
              type={addType}
              sites={sites}
              endpoints={endpoints}
              checks={checks}
              channels={channels}
              defaultSiteId={cascade.siteIds.length === 1 ? cascade.siteIds[0] : undefined}
              defaultEndpointId={cascade.endpointIds.length === 1 ? cascade.endpointIds[0] : undefined}
              onChangeType={() => setAddType(null)}
              onSaved={(created, count = 1) => {
                setDialog(null);
                setAddType(null);
                toast.show(count > 1 ? `Created ${count} checks.` : `Created “${created.name}”.`);
                load().then(() => count === 1 && setExpanded(created.id));
              }}
              onCancel={() => {
                setDialog(null);
                setAddType(null);
              }}
            />
          ) : (
            <TypePicker onPick={setAddType} onCancel={() => setDialog(null)} />
          )}
        </Modal>
      )}

      {dialog?.kind === "delete" && (
        <ConfirmDialog
          title={`Delete ${sel.ids.length} check(s)?`}
          message={<p>This deletes the checks, their full result history, and their alert rules. It can&apos;t be undone.</p>}
          actionLabel={`Delete ${sel.ids.length}`}
          onConfirm={() => bulk("delete", {}, "Deleted")}
          onClose={() => setDialog(null)}
        />
      )}

      {dialog?.kind === "prompt" && (
        <PromptDialog
          title={`${dialog.title} (${sel.ids.length} selected)`}
          label={dialog.label}
          help={dialog.help}
          type={dialog.type}
          options={dialog.options}
          initial={dialog.initial}
          onClose={() => setDialog(null)}
          onSubmit={(value) =>
            bulk(dialog.action, {
              [dialog.param]: dialog.asNumber ? Number(value) || null : dialog.asList ? value.split(",").map((t) => t.trim()).filter(Boolean) : value || null,
            })
          }
        />
      )}

      {dialog?.kind === "group" && (
        <AddToGroupDialog
          members={sel.ids.map((id) => ({ type: "check" as const, id }))}
          onClose={() => setDialog(null)}
          onDone={() => {
            toast.show(`Added ${sel.ids.length} check(s) to the group.`);
            setDialog(null);
          }}
        />
      )}
      {dialog?.kind === "alertRule" && <BulkAlertRuleDialog channels={channels} count={sel.ids.length} onClose={() => setDialog(null)} onSubmit={(params) => bulk("add_alert_rule", params, "Added an alert rule to")} />}
      {dialog?.kind === "duplicate" && (
        <DuplicateDialog
          checks={checks.filter((c) => sel.selected.has(c.id))}
          sites={sites}
          endpoints={endpoints}
          onClose={() => setDialog(null)}
          onSubmit={(params) => bulk("duplicate", params, "Created copies:")}
        />
      )}
      {dialog?.kind === "dependencies" && (
        <BulkDependencyDialog checks={checks.filter((c) => !sel.selected.has(c.id))} count={sel.ids.length} onClose={() => setDialog(null)} onSubmit={(ids) => bulk("set_dependencies", { dependsOn: ids }, "Set dependencies on")} />
      )}
      {toast.node}
    </main>
  );
}

function BulkAlertRuleDialog({ channels, count, onClose, onSubmit }: { channels: Channel[]; count: number; onClose: () => void; onSubmit: (p: Record<string, unknown>) => Promise<void> }) {
  const [value, setValue] = useState(emptyAlertOptions());
  const payload = alertRulePayload(value);
  return (
    <Modal title={`Add alert rule to ${count} check(s)`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <AlertOptions channels={channels} value={value} onChange={setValue} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!payload}
            onClick={() => {
              // Close now; the change runs in the background (lib/background.ts).
              onClose();
              runInBackground(`Add an alert rule to ${count} check(s)`, () => onSubmit(payload!));
            }}
          >
            Add rule
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// Duplicate: same place, other sites, or other endpoints. Copies keep their
// alert rules, dependencies and enabled state.
function DuplicateDialog({ checks, sites, endpoints, onClose, onSubmit }: { checks: Check[]; sites: Site[]; endpoints: Endpoint[]; onClose: () => void; onSubmit: (p: Record<string, unknown>) => Promise<void> }) {
  const [mode, setMode] = useState<"same" | "sites" | "endpoints">("same");
  const [siteIds, setSiteIds] = useState<string[]>([]);
  const [endpointIds, setEndpointIds] = useState<string[]>([]);
  const siteName = new Map(sites.map((e) => [e.id, e.name]));
  const endpointScoped = checks.some((c) => c.endpointId);
  const copies = mode === "same" ? checks.length : checks.length * (mode === "endpoints" ? endpointIds.length : siteIds.length);
  return (
    <Modal title={`Duplicate ${checks.length} check(s)`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap gap-4">
          {(
            [
              ["same", "Same place (a copy next to each)"],
              ["sites", "To other sites"],
              ["endpoints", "To other endpoints"],
            ] as const
          ).map(([v, label]) => (
            <label key={v} className="flex items-center gap-1.5">
              <input type="radio" checked={mode === v} onChange={() => setMode(v)} className="accent-[var(--accent)]" />
              {label}
            </label>
          ))}
        </div>
        {mode === "sites" && (
          <>
            <MultiPicker items={sites.map((e) => ({ id: e.id, label: e.name }))} selected={siteIds} onChange={setSiteIds} placeholder="Search sites…" />
            {endpointScoped && <p className="text-xs text-[var(--muted)]">Checks tied to an endpoint keep it only when it&apos;s in the destination site; agent checks that need an endpoint are skipped elsewhere — copy those to endpoints instead.</p>}
          </>
        )}
        {mode === "endpoints" && <MultiPicker items={endpoints.map((h) => ({ id: h.id, label: h.name, sub: h.hostname ?? undefined, group: siteName.get(h.siteId) }))} selected={endpointIds} onChange={setEndpointIds} placeholder="Search endpoints…" groupLabel="Site" />}
        <p className="text-xs text-[var(--muted)]">Copies stay enabled and keep each original&apos;s alert rules and dependencies. {copies} cop{copies === 1 ? "y" : "ies"} will be created.</p>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={copies === 0}
            onClick={() => {
              onClose();
              runInBackground(`Create ${copies} cop${copies === 1 ? "y" : "ies"}`, () => onSubmit(mode === "endpoints" ? { endpointIds } : mode === "sites" ? { siteIds } : {}));
            }}
          >
            Duplicate
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function BulkDependencyDialog({ checks, count, onClose, onSubmit }: { checks: Check[]; count: number; onClose: () => void; onSubmit: (ids: string[]) => Promise<void> }) {
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const shown = checks.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())).slice(0, 200);
  return (
    <Modal title={`Set what ${count} check(s) depend on`} onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-[var(--muted)]">While any chosen parent is down, alerts for the selected checks are held back. Choosing nothing clears their dependencies.</p>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter…" className={inputClass} />
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {shown.map((c) => (
            <label key={c.id} className="flex items-center gap-2">
              <input type="checkbox" className="accent-[var(--up)]" checked={picked.includes(c.id)} onChange={(e) => setPicked((p) => (e.target.checked ? [...p, c.id] : p.filter((x) => x !== c.id)))} />
              {c.name}
            </label>
          ))}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose();
              runInBackground(`Set dependencies of ${count} check(s)`, () => onSubmit(picked));
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
