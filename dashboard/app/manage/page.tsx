"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type Channel, type Check, type Endpoint, type Host } from "../lib/api";
import { CATEGORIES, typeCategory, typeLabel } from "../lib/checkTypes";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { CheckForm, TypePicker } from "../components/CheckForm";
import { CheckDetail, displayStatus } from "../components/CheckDetail";
import { BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, FilterChip, Modal, PromptDialog, StatusBadge, Tags, inputClass, relativeTime, useSelection, useToast } from "../components/ui";

const REFRESH_MS = 15_000;
const STATUS_ORDER: Record<string, number> = { down: 0, warn: 1, unknown: 2, maintenance: 3, up: 4, disabled: 5 };
const STATUS_FILTERS = ["all", "problems", "down", "warn", "up", "unknown", "maintenance", "disabled"] as const;
type GroupBy = "endpoint" | "host" | "category" | "status" | "none";

type Dialog =
  | { kind: "add" }
  | { kind: "delete" }
  | { kind: "prompt"; title: string; label: string; help?: string; type?: "text" | "number"; options?: { value: string; label: string }[]; initial?: string; action: string; param: string; asNumber?: boolean; asList?: boolean }
  | { kind: "alertRule" }
  | { kind: "dependencies" }
  | null;

function readPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(key) as T) || fallback;
  } catch {
    return fallback;
  }
}

export default function ChecksPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [checks, setChecks] = useState<Check[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>("all");
  const [endpointFilter, setEndpointFilter] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [groupBy, setGroupBy] = useState<GroupBy>("endpoint");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<Dialog>(null);
  const [addType, setAddType] = useState<string | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [c, e, h, ch] = await Promise.all([api.checks(), api.endpoints(), api.hosts(), api.channels()]);
    setChecks(c);
    setEndpoints(e);
    setHosts(h);
    setChannels(ch);
    setLoaded(true);
  }, []);

  useEffect(() => {
    api
      .me()
      .then(() => setAuthChecked(true))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) router.push("/login");
      });
    setGroupBy(readPref<GroupBy>("looksee.checks.groupBy", "endpoint"));
  }, [router]);

  useEffect(() => {
    if (!authChecked) return;
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => clearInterval(t);
  }, [authChecked, load]);

  const endpointName = useMemo(() => new Map(endpoints.map((e) => [e.id, e.name])), [endpoints]);
  const hostName = useMemo(() => new Map(hosts.map((h) => [h.id, h.name])), [hosts]);
  const allTags = useMemo(() => [...new Set(checks.flatMap((c) => c.tags ?? []))].sort(), [checks]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return checks
      .filter((c) => {
        const st = displayStatus(c);
        if (statusFilter === "problems" && !["down", "warn"].includes(st)) return false;
        if (statusFilter !== "all" && statusFilter !== "problems" && st !== statusFilter) return false;
        if (endpointFilter && c.endpointId !== endpointFilter) return false;
        if (hostFilter && c.hostId !== hostFilter && c.probeHostId !== hostFilter) return false;
        if (categoryFilter && typeCategory(c.type) !== categoryFilter) return false;
        if (tagFilter && !(c.tags ?? []).includes(tagFilter)) return false;
        if (q) {
          const hay = `${c.name} ${typeLabel(c.type)} ${c.lastMessage ?? ""} ${(c.tags ?? []).join(" ")} ${endpointName.get(c.endpointId) ?? ""} ${c.hostId ? hostName.get(c.hostId) ?? "" : ""} ${JSON.stringify(c.config)}`.toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      })
      .sort((a, b) => (STATUS_ORDER[displayStatus(a)] ?? 9) - (STATUS_ORDER[displayStatus(b)] ?? 9) || a.name.localeCompare(b.name));
  }, [checks, search, statusFilter, endpointFilter, hostFilter, categoryFilter, tagFilter, endpointName, hostName]);

  const groups = useMemo(() => {
    const keyOf = (c: Check): [string, string] => {
      switch (groupBy) {
        case "endpoint":
          return [c.endpointId, endpointName.get(c.endpointId) ?? "Unknown endpoint"];
        case "host":
          return c.hostId ? [c.hostId, hostName.get(c.hostId) ?? "Unknown host"] : ["", "No host (agentless)"];
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
  }, [filtered, groupBy, endpointName, hostName]);

  const visibleIds = useMemo(() => filtered.map((c) => c.id), [filtered]);
  const sel = useSelection(visibleIds);

  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const ch of checks) c[displayStatus(ch)] = (c[displayStatus(ch)] ?? 0) + 1;
    return c;
  }, [checks]);

  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Updated") {
    const res = await api.bulkChecks(sel.ids, action, params);
    if (res.errors.length) toast.show(`${verb} ${res.affected}; ${res.errors.length} skipped: ${res.errors[0].error}`, "error");
    else toast.show(`${verb} ${res.affected} check(s).`);
    if (action === "delete") sel.clear();
    await load();
  }

  const prompt = (d: Omit<Extract<Dialog, { kind: "prompt" }>, "kind">) => setDialog({ kind: "prompt", ...d });
  const endpointOptions = endpoints.map((e) => ({ value: e.id, label: e.name }));
  const hostOptions = [{ value: "", label: "— none —" }, ...hosts.map((h) => ({ value: h.id, label: h.name }))];

  const bulkActions = [
    { key: "enable", label: "Enable", run: () => bulk("enable") },
    { key: "disable", label: "Disable", run: () => bulk("disable") },
    { key: "run", label: "Run now", run: () => bulk("run_now", {}, "Ran") },
    { key: "maint", label: "Maintenance…", run: () => prompt({ title: "Put in maintenance", label: "For how many minutes?", type: "number", initial: "60", action: "maintenance", param: "minutes", asNumber: true, help: "Results are still recorded; alerts are held and SLA reports skip this time." }) },
    { key: "tags", label: "Add tags…", run: () => prompt({ title: "Add tags", label: "Tags (comma-separated)", action: "add_tags", param: "tags", asList: true }) },
    { key: "untag", label: "Remove tags…", run: () => prompt({ title: "Remove tags", label: "Tags (comma-separated)", action: "remove_tags", param: "tags", asList: true }) },
    { key: "move", label: "Move to endpoint…", run: () => prompt({ title: "Move to endpoint", label: "Endpoint", options: endpointOptions, action: "move", param: "endpointId" }) },
    { key: "host", label: "Set host…", run: () => prompt({ title: "Set host", label: "Host", options: hostOptions, action: "set_host", param: "hostId" }) },
    { key: "probe", label: "Run from…", run: () => prompt({ title: "Run from", label: "Where ping/TCP/HTTP/DNS/TLS checks run", options: [{ value: "", label: "Looksee engine" }, ...hosts.map((h) => ({ value: h.id, label: `Agent on ${h.name}` }))], action: "set_probe_host", param: "hostId" }) },
    { key: "interval", label: "Interval…", run: () => prompt({ title: "Set check interval", label: "Seconds between checks", type: "number", initial: "60", action: "set_interval", param: "seconds", asNumber: true }) },
    { key: "retry", label: "Retry interval…", run: () => prompt({ title: "Set retry interval", label: "Seconds between checks while failing (0 to clear)", type: "number", initial: "30", action: "set_retry_interval", param: "seconds", asNumber: true }) },
    { key: "alert", label: "Add alert rule…", run: () => setDialog({ kind: "alertRule" }) },
    { key: "noalert", label: "Remove alert rules", run: () => bulk("clear_alert_rules", {}, "Removed alert rules from") },
    { key: "deps", label: "Depends on…", run: () => setDialog({ kind: "dependencies" }) },
    { key: "dup", label: "Duplicate", run: () => bulk("duplicate", {}, "Duplicated") },
    { key: "delete", label: "Delete…", danger: true, run: () => setDialog({ kind: "delete" }) },
  ];

  if (!authChecked) return null;

  const filtersActive = Boolean(search || statusFilter !== "all" || endpointFilter || hostFilter || categoryFilter || tagFilter);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <TopNav active="/manage" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Checks</h2>
        <div className="flex gap-2">
          <Button variant="primary" onClick={() => setDialog({ kind: "add" })} disabled={endpoints.length === 0} title={endpoints.length ? undefined : "Create an endpoint first"}>
            + Add check
          </Button>
        </div>
      </div>
      <PageHelp anchor="checks">Everything Looksee monitors. Filter, group, tick several, and act on them together from the bar that appears at the bottom.</PageHelp>

      <div className="mb-3 flex flex-wrap gap-1.5">
        {STATUS_FILTERS.map((s) => {
          const n = s === "all" ? checks.length : s === "problems" ? (counts.down ?? 0) + (counts.warn ?? 0) : counts[s] ?? 0;
          if (s !== "all" && s !== "problems" && n === 0) return null;
          return (
            <FilterChip key={s} active={statusFilter === s} onClick={() => setStatusFilter(s)}>
              {s === "all" ? "All" : s === "problems" ? "Problems" : s[0].toUpperCase() + s.slice(1)} {n}
            </FilterChip>
          );
        })}
      </div>

      <div className="mb-4 grid grid-cols-2 gap-2 md:grid-cols-6">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, type, host, message, tag…" className={`${inputClass} col-span-2`} aria-label="Search checks" />
        <select value={endpointFilter} onChange={(e) => setEndpointFilter(e.target.value)} className={inputClass} aria-label="Endpoint filter">
          <option value="">All endpoints</option>
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <select value={hostFilter} onChange={(e) => setHostFilter(e.target.value)} className={inputClass} aria-label="Host filter">
          <option value="">All hosts</option>
          {hosts.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        <select value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} className={inputClass} aria-label="Category filter">
          <option value="">All kinds</option>
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <select value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} className={inputClass} aria-label="Tag filter" disabled={allTags.length === 0}>
          <option value="">{allTags.length ? "All tags" : "No tags yet"}</option>
          {allTags.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
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
              setEndpointFilter("");
              setHostFilter("");
              setCategoryFilter("");
              setTagFilter("");
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
              try {
                localStorage.setItem("looksee.checks.groupBy", e.target.value);
              } catch {
                // preference only
              }
            }}
            className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1 text-sm"
          >
            <option value="endpoint">Endpoint</option>
            <option value="host">Host</option>
            <option value="category">Kind</option>
            <option value="status">Status</option>
            <option value="none">Nothing</option>
          </select>
        </label>
      </div>

      {loaded && checks.length === 0 ? (
        <EmptyState>
          No checks yet. {endpoints.length === 0 ? "Create an endpoint on the Endpoints page first, then " : ""}use <strong>+ Add check</strong> — or scan your network from <a className="underline" href="/discovery">Discovery</a>.
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
              <section key={key} className="overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel)]/40">
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
                    <div role="row" className="hidden grid-cols-[28px_110px_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,2fr)_90px] gap-3 px-3 py-1.5 text-xs text-[var(--muted)] md:grid">
                      <span />
                      <span role="columnheader">Status</span>
                      <span role="columnheader">Name</span>
                      <span role="columnheader">Kind / where</span>
                      <span role="columnheader">Last result</span>
                      <span role="columnheader">Checked</span>
                    </div>
                    {group.items.map((c) => {
                      const open = expanded === c.id;
                      const where = [c.hostId ? hostName.get(c.hostId) : null, c.probeHostId ? `via ${hostName.get(c.probeHostId) ?? "agent"}` : c.collectorHostId ? `via site collector ${hostName.get(c.collectorHostId) ?? ""}`.trim() : null, groupBy !== "endpoint" ? endpointName.get(c.endpointId) : null].filter(Boolean).join(" · ");
                      return (
                        <Fragment key={c.id}>
                          <div
                            role="row"
                            onClick={() => setExpanded(open ? null : c.id)}
                            className={`grid cursor-pointer grid-cols-[28px_1fr] gap-x-3 gap-y-1 border-t border-[var(--border)] px-3 py-2 text-sm hover:bg-[var(--border)]/20 md:grid-cols-[28px_110px_minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,2fr)_90px] md:items-center ${sel.selected.has(c.id) ? "bg-[var(--up)]/5" : ""}`}
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
                              <CheckDetail check={c} endpoints={endpoints} hosts={hosts} checks={checks} onChanged={load} />
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
              endpoints={endpoints}
              hosts={hosts}
              checks={checks}
              channels={channels}
              defaultEndpointId={endpointFilter || undefined}
              defaultHostId={hostFilter || undefined}
              onChangeType={() => setAddType(null)}
              onSaved={(created) => {
                setDialog(null);
                setAddType(null);
                toast.show(`Created “${created.name}”.`);
                load().then(() => setExpanded(created.id));
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
          confirmWord="delete"
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

      {dialog?.kind === "alertRule" && <BulkAlertRuleDialog channels={channels} count={sel.ids.length} onClose={() => setDialog(null)} onSubmit={(params) => bulk("add_alert_rule", params, "Added an alert rule to")} />}
      {dialog?.kind === "dependencies" && (
        <BulkDependencyDialog checks={checks.filter((c) => !sel.selected.has(c.id))} count={sel.ids.length} onClose={() => setDialog(null)} onSubmit={(ids) => bulk("set_dependencies", { dependsOn: ids }, "Set dependencies on")} />
      )}
      {toast.node}
    </main>
  );
}

function BulkAlertRuleDialog({ channels, count, onClose, onSubmit }: { channels: Channel[]; count: number; onClose: () => void; onSubmit: (p: Record<string, unknown>) => Promise<void> }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [consecutive, setConsecutive] = useState("2");
  const [triggerOn, setTriggerOn] = useState("down");
  const [renotify, setRenotify] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Add alert rule to ${count} check(s)`} onClose={onClose}>
      {channels.length === 0 ? (
        <p className="text-sm">
          No notification channels yet —{" "}
          <a className="underline" href="/channels">
            add one first
          </a>
          .
        </p>
      ) : (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-3 gap-2">
            <label>
              <span className="text-xs text-[var(--muted)]">Results in a row</span>
              <input type="number" min={1} value={consecutive} onChange={(e) => setConsecutive(e.target.value)} className={inputClass} />
            </label>
            <label>
              <span className="text-xs text-[var(--muted)]">Failing means</span>
              <select value={triggerOn} onChange={(e) => setTriggerOn(e.target.value)} className={inputClass}>
                <option value="down">Down only</option>
                <option value="warn">Warn or down</option>
              </select>
            </label>
            <label>
              <span className="text-xs text-[var(--muted)]">Remind every (min)</span>
              <input type="number" min={1} value={renotify} onChange={(e) => setRenotify(e.target.value)} className={inputClass} />
            </label>
          </div>
          <div className="flex flex-wrap gap-3">
            {channels.map((c) => (
              <label key={c.id} className="flex items-center gap-1.5">
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
              disabled={!picked.length || busy}
              onClick={async () => {
                setBusy(true);
                await onSubmit({ channelIds: picked, consecutiveFailures: Number(consecutive) || 2, triggerOn, renotifyMinutes: renotify ? Number(renotify) : null });
                onClose();
              }}
            >
              Add rule
            </Button>
          </div>
        </div>
      )}
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
            onClick={async () => {
              await onSubmit(picked);
              onClose();
            }}
          >
            Save
          </Button>
        </div>
      </div>
    </Modal>
  );
}
