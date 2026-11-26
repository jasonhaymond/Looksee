// A check's own page (/checks/<id>): status, history chart and results (each
// row opens to show everything stored about it; exclude / count again),
// incidents, settings, alert rules, recovery and what the check ignores.
//
// "use client" makes this a React component that runs in the browser; the
// engine refuses every call without a session.

"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, type Channel, type Check, type CheckResult, type CheckStats, type Site, type Endpoint } from "../../lib/api";
import { typeLabel, TYPE_BY_KEY } from "../../lib/checkTypes";
import { CheckForm } from "../../components/CheckForm";
import { AlertRuleManager } from "../../components/AlertRuleManager";
import { displayStatus, Details, DetailsToggle, Remediation, ResultFull } from "../../components/CheckDetail";
import { RecoveryUrl, ResolveButton } from "../../components/CheckRecovery";
import { ExclusionsApplied } from "../../components/ExclusionsApplied";
import { BulkSettingsDialog } from "../../components/BulkSettingsDialog";
import { LineChart, StatusStrip } from "../../components/Charts";
import { Button, EmptyState, Label, Modal, SortTh, StatusBadge, inputClass, relativeTime, useToast } from "../../components/ui";
import { useSort } from "../../lib/useSort";
import { pollEvery } from "../../lib/poll";
import { useNow } from "../../lib/useNow";

const RANGES: [number, string][] = [
  [1, "1 hour"],
  [24, "24 hours"],
  [168, "7 days"],
  [720, "30 days"],
  [2160, "90 days"],
];

function Stat({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="surface rounded-lg p-3">
      <div className="text-xs text-[var(--muted)]">{label}</div>
      <div className="text-lg font-semibold">{value}</div>
      {sub && <div className="text-xs text-[var(--muted)]">{sub}</div>}
    </div>
  );
}

const fmt = (v: number | null | undefined, unit = "") => (v == null ? "—" : `${Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100}${unit}`);

// Everything about one check on one linkable page: status and what to do
// about it, uptime/latency/value over a chosen range, its incidents, every
// result, and its settings and alert rules.
export default function CheckPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [check, setCheck] = useState<Check | null>(null);
  const [missing, setMissing] = useState(false);
  const [hours, setHours] = useState(24);
  const [stats, setStats] = useState<CheckStats | null>(null);
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [onlyProblems, setOnlyProblems] = useState(false);
  // Result rows opened to show everything about them (by result id). Kept
  // across the history re-fetch after each check run, so open rows stay open.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggleOpen = (rid: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid);
      else next.add(rid);
      return next;
    });
  // Whether the "Exclude a time range" dialog is open.
  const [excludeRange, setExcludeRange] = useState(false);
  // Whether "Edit on several endpoints" (the same kind of check elsewhere) is open.
  const [bulkEdit, setBulkEdit] = useState(false);
  const [tab, setTab] = useState<"history" | "edit" | "alerts">("history");
  const [ctx, setCtx] = useState<{ sites: Site[]; endpoints: Endpoint[]; checks: Check[]; channels: Channel[] } | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();
  // The current time, for "open for N min" (lib/useNow.ts).
  const now = useNow();

  const loadCheck = useCallback(
    () =>
      api
        .check(id)
        .then(setCheck)
        .catch((err) => {
          if (err instanceof ApiError && err.status === 401) router.push("/login");
          else setMissing(true);
        }),
    [id, router]
  );

  const loadHistory = useCallback(() => {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    return Promise.all([api.checkStats(id, hours), api.checkResults(id, 2000, since)]).then(([s, r]) => {
      setStats(s);
      setResults(r);
    });
  }, [id, hours]);

  useEffect(() => {
    loadCheck();
    Promise.all([api.sites(), api.endpoints(), api.checks(), api.channels()]).then(([sites, endpoints, checks, channels]) => setCtx({ sites, endpoints, checks, channels })).catch(() => undefined);
    const t = pollEvery(loadCheck, 15_000);
    return () => clearInterval(t);
  }, [loadCheck]);

  useEffect(() => {
    loadHistory().catch(() => undefined);
  }, [loadHistory, check?.lastCheckedAt]);

  const def = check ? TYPE_BY_KEY.get(check.type) : undefined;
  const unit = def?.value?.unit ?? "";
  const latestDetails = useMemo(() => results?.find((r) => r.details != null)?.details, [results]);
  const resultSort = useSort<CheckResult>("checkResults", { time: (r) => new Date(r.checkedAt), status: (r) => r.status, value: (r) => r.value, ms: (r) => r.latencyMs, message: (r) => r.message });
  const shownResults = resultSort.apply((results ?? []).filter((r) => !onlyProblems || r.status !== "up"));

  if (missing)
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <EmptyState>That check doesn&apos;t exist (any more). <Link className="underline" href="/manage">Back to checks</Link></EmptyState>
      </main>
    );
  if (!check) return null;

  const host = ctx?.endpoints.find((h) => h.id === check.endpointId);
  const site = ctx?.sites.find((e) => e.id === check.siteId);
  const hasValue = stats?.series.some((p) => p.value != null);
  const hasLatency = stats?.series.some((p) => p.latency != null);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <div className="mb-1 text-xs text-[var(--muted)]">
        <Link href="/manage" className="underline">
          Checks
        </Link>{" "}
        / {site?.name ?? "…"}
        {host ? ` / ${host.name}` : ""}
      </div>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <StatusBadge status={displayStatus(check)} />
          <h1 className="text-xl font-semibold">{check.name}</h1>
        </div>
        <div className="flex gap-2">
          <Button
            disabled={running}
            onClick={async () => {
              setRunning(true);
              try {
                const res = await api.runCheck(check.id);
                toast.show("queued" in res ? res.message : "Ran it.");
              } catch (err) {
                toast.show(err instanceof Error ? err.message : "Run failed", "error");
              } finally {
                setRunning(false);
                loadCheck();
              }
            }}
          >
            {running ? "Running…" : "Run now"}
          </Button>
          <ResolveButton check={check} onDone={loadCheck} />
          <Button onClick={async () => (await api.updateCheck(check.id, { enabled: !check.enabled }), loadCheck())}>{check.enabled ? "Disable" : "Enable"}</Button>
        </div>
      </div>

      <div className="surface mb-4 space-y-2 rounded-xl p-3 text-sm">
        <p className="whitespace-pre-wrap break-words">
          {check.lastMessage ?? (check.lastCheckedAt ? "OK" : "No results yet")} <span className="text-xs text-[var(--muted)]">· checked {relativeTime(check.lastCheckedAt)} · in this state since {relativeTime(check.lastStatusChangeAt)}</span>
        </p>
        <p className="text-xs text-[var(--muted)]">
          {typeLabel(check.type)} · every {check.intervalSeconds}s{check.retryIntervalSeconds ? ` (retry ${check.retryIntervalSeconds}s)` : ""}
          {check.flapping ? " · flapping — alerts held" : ""}
          {check.blockedBy ? ` · parent “${check.blockedBy}” is down` : ""} ·{" "}
          <a className="underline" href={`/help/checks#${check.type}`} target="_blank" rel="noreferrer">
            how this check works
          </a>
        </p>
        <Remediation check={check} />
        <RecoveryUrl check={check} onChanged={loadCheck} />
        <ExclusionsApplied check={check} />
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-sm text-[var(--muted)]">Range</span>
        {RANGES.map(([h, label]) => (
          <button key={h} onClick={() => setHours(h)} aria-pressed={hours === h} className={`rounded-full border px-3 py-0.5 text-xs ${hours === h ? "border-[var(--accent)] bg-[var(--accent)]/15" : "border-[var(--border)] text-[var(--muted)] hover:text-[var(--text)]"}`}>
            {label}
          </button>
        ))}
      </div>

      <div className={`mb-4 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6 ${stats ? "" : "opacity-50"}`}>
        <Stat label="Uptime" value={stats?.uptimePercent != null ? `${stats.uptimePercent}%` : "—"} sub={`${stats?.results ?? 0} results`} />
        <Stat label="Down / warn results" value={`${stats?.down ?? 0} / ${stats?.warn ?? 0}`} />
        <Stat label="State changes" value={stats?.stateChanges ?? "—"} />
        <Stat label="Incidents" value={stats?.incidents.length ?? "—"} sub={`${stats?.incidents.filter((i) => !i.resolvedAt).length ?? 0} open`} />
        <Stat label="Response time" value={fmt(stats?.latencyAvg, " ms")} sub={`p95 ${fmt(stats?.latencyP95, " ms")} · max ${fmt(stats?.latencyMax, " ms")}`} />
        <Stat label="Value" value={fmt(stats?.valueAvg, unit)} sub={`min ${fmt(stats?.valueMin, unit)} · max ${fmt(stats?.valueMax, unit)}`} />
      </div>

      {stats && (
        <div className="mb-4 space-y-4">
          <section className="surface rounded-xl p-3">
            <h2 className="mb-2 text-sm font-medium">Status</h2>
            <StatusStrip series={stats.series} />
          </section>
          <div className={`grid gap-4 ${hasValue && hasLatency ? "lg:grid-cols-2" : ""}`}>
            {hasLatency && (
              <section className="surface rounded-xl p-3">
                <h2 className="mb-2 text-sm font-medium">Response time (ms)</h2>
                <LineChart label="Response time" unit=" ms" points={stats.series.map((p) => ({ t: p.t, v: p.latency }))} />
              </section>
            )}
            {hasValue && (
              <section className="surface rounded-xl p-3">
                <h2 className="mb-2 text-sm font-medium">
                  Value{unit ? ` (${unit.trim()})` : ""}
                  {def?.value?.hint && <span className="ml-2 text-xs font-normal text-[var(--muted)]">{def.value.hint}</span>}
                </h2>
                <LineChart label="Value" unit={unit} points={stats.series.map((p) => ({ t: p.t, v: p.value, min: p.valueMin, max: p.valueMax }))} />
              </section>
            )}
          </div>
        </div>
      )}

      <div className="mb-3 flex flex-wrap gap-1">
        {(
          [
            ["history", "History & incidents"],
            ["edit", "Settings"],
            ["alerts", "Alert rules"],
          ] as const
        ).map(([t, label]) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-sm ${tab === t ? "bg-[var(--panel-2)] font-medium text-[var(--text)] ring-1 ring-[var(--border)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
            {label}
          </button>
        ))}
      </div>

      {/* The latest result's details (zone changes, vulnerable packages,
          interface tables…) across the full width: they're often wide. */}
      {tab === "history" && latestDetails != null && (
        <section className="surface mb-4 rounded-xl p-3">
          <h2 className="mb-2 text-sm font-medium">Latest details</h2>
          <Details value={latestDetails} />
        </section>
      )}

      {tab === "history" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <section className="surface rounded-xl p-3">
            <h2 className="mb-2 text-sm font-medium">Incidents in range</h2>
            {stats?.incidents.length ? (
              <ul className="space-y-2 text-sm">
                {stats.incidents.map((i) => (
                  <li key={i.id} className="border-b border-[var(--border)] pb-2 last:border-0">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={i.resolvedAt ? "up" : i.severity} compact />
                      <span className="font-medium">{i.resolvedAt ? "Resolved" : "Open"}</span>
                      <span className="text-xs text-[var(--muted)]">
                        {/* Start time, end time (when resolved) and how long it lasted. */}
                        {new Date(i.triggeredAt).toLocaleString()}
                        {i.resolvedAt ? ` → ${new Date(i.resolvedAt).toLocaleString()}` : ""} · {Math.round(((i.resolvedAt ? new Date(i.resolvedAt).getTime() : now) - new Date(i.triggeredAt).getTime()) / 60_000)} min
                      </span>
                    </div>
                    {i.message && <p className="text-xs text-[var(--muted)]">{i.message}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--muted)]">No alert incidents in this range{ctx && !ctx.channels.length ? " (and no notification channels exist yet)" : ""}. Incidents are recorded for checks with an alert rule.</p>
            )}
          </section>
          <section className="surface rounded-xl p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Results ({shownResults.length})</h2>
              {/* Open or close every listed result at once. */}
              <button onClick={() => setOpenIds(openIds.size ? new Set() : new Set(shownResults.map((r) => r.id)))} className="text-xs text-[var(--muted)] underline hover:text-[var(--text)]">
                {openIds.size ? "Hide all details" : "Show all details"}
              </button>
              <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-[var(--accent)]" />
                Only problems
              </label>
              <button onClick={() => setExcludeRange(true)} className="text-xs text-[var(--muted)] underline hover:text-[var(--text)]" title="Leave a time range out of uptime, SLA reports and status pages">
                Exclude a time range…
              </button>
            </div>
            {/* Taller while any row is open: a result's details can be whole tables. */}
            <div className={`${openIds.size ? "max-h-[60rem]" : "max-h-[32rem]"} overflow-auto`}>
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--panel)] text-left text-[var(--muted)]">
                  <tr>
                    <SortTh sort={resultSort} column="time" className="py-1 pr-2 font-normal">
                      Time
                    </SortTh>
                    <SortTh sort={resultSort} column="status" className="pr-2 font-normal">
                      Status
                    </SortTh>
                    <SortTh sort={resultSort} column="value" className="pr-2 font-normal">
                      Value
                    </SortTh>
                    <SortTh sort={resultSort} column="ms" className="pr-2 font-normal">
                      ms
                    </SortTh>
                    <SortTh sort={resultSort} column="message" className="pr-2 font-normal">
                      Message
                    </SortTh>
                    <th className="font-normal">
                      <span className="sr-only">Statistics</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {shownResults.map((r) => (
                    // Fragment: one result is its summary row plus, when
                    // opened, a full-width row with everything about it.
                    <Fragment key={r.id}>
                    {/* Clicking anywhere on the row opens it too: on a phone the
                        table is wider than the screen and the Show details link
                        sits off to the right. Clicks on the row's own buttons
                        are left to those buttons. */}
                    <tr
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest("button")) toggleOpen(r.id);
                      }}
                      className={`cursor-pointer border-t border-[var(--border)] align-top hover:bg-[var(--panel-2)] ${r.excluded ? "opacity-60" : ""}`}
                    >
                      <td className="whitespace-nowrap py-1 pr-2 text-[var(--muted)]">{new Date(r.checkedAt).toLocaleString()}</td>
                      <td className="pr-2">
                        <StatusBadge status={r.inMaintenance ? "maintenance" : r.status} />
                      </td>
                      <td className="pr-2">{r.value != null ? Math.round(r.value * 100) / 100 : ""}</td>
                      <td className="pr-2">{r.latencyMs ?? ""}</td>
                      <td className="pr-2">
                        <span className="whitespace-pre-wrap break-words">{r.message}</span>
                        {r.excluded && <span className="block text-[10px] text-[var(--muted)]">Excluded from statistics{r.excludedReason ? `: ${r.excludedReason}` : ""}</span>}
                      </td>
                      <td className="space-x-2 whitespace-nowrap">
                        <DetailsToggle open={openIds.has(r.id)} onToggle={() => toggleOpen(r.id)} />
                        {/* Leave this one result out of uptime/SLA figures, or count it again. */}
                        <button
                          onClick={async () => {
                            await api.excludeResults(check.id, { resultIds: [r.id], exclude: !r.excluded, reason: r.excluded ? undefined : "excluded by hand" });
                            loadHistory();
                          }}
                          className="text-[10px] text-[var(--muted)] underline hover:text-[var(--text)]"
                        >
                          {r.excluded ? "Count again" : "Exclude"}
                        </button>
                      </td>
                    </tr>
                    {openIds.has(r.id) && (
                      <tr>
                        <td colSpan={6} className="pb-2">
                          {/* On a phone the results table is wider than the
                              screen; this keeps the opened result screen-wide
                              (the page and card padding add up to 3.5rem) and
                              pinned to the left while the table scrolls sideways,
                              so its text wraps on screen instead of running off it. */}
                          <div className="sticky left-0 max-w-[calc(100vw-3.5rem)] sm:max-w-none">
                            <ResultFull result={r} />
                          </div>
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  ))}
                </tbody>
              </table>
              {results && results.length >= 2000 && <p className="pt-2 text-xs text-[var(--muted)]">Showing the newest 2000 results — narrow the range to see older ones.</p>}
            </div>
          </section>
        </div>
      )}

      {tab === "edit" && ctx && (
        <div className="surface rounded-xl p-3">
          {/* The same change on this kind of check on other endpoints too (components/BulkSettingsDialog.tsx). */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--muted)]">
            <span>Editing this one check.</span>
            <Button className="text-xs" onClick={() => setBulkEdit(true)}>
              Edit on several endpoints…
            </Button>
          </div>
          <CheckForm type={check.type} check={check} sites={ctx.sites} endpoints={ctx.endpoints} checks={ctx.checks} onSaved={() => (loadCheck(), setTab("history"), toast.show("Saved."))} onCancel={() => setTab("history")} />
        </div>
      )}
      {tab === "alerts" && (
        <div className="surface rounded-xl p-3">
          <AlertRuleManager checkId={check.id} />
        </div>
      )}
      {toast.node}
      {bulkEdit && ctx && (
        <BulkSettingsDialog
          initial={[ctx.checks.find((c) => c.id === check.id) ?? check]}
          checks={ctx.checks}
          sites={ctx.sites}
          endpoints={ctx.endpoints}
          onClose={() => setBulkEdit(false)}
          onSubmit={async (ids, params) => {
            const res = await api.bulkChecks(ids, "edit_settings", params);
            toast.show(res.errors.length ? `Changed settings on ${res.affected}; ${res.errors.length} skipped: ${res.errors[0].error}` : `Changed settings on ${res.affected} check(s).`, res.errors.length ? "error" : undefined);
            loadCheck();
          }}
        />
      )}
      {excludeRange && check && <ExcludeRangeDialog checkId={check.id} onClose={() => setExcludeRange(false)} onDone={() => (setExcludeRange(false), loadHistory())} />}
    </main>
  );
}

/**
 * Leaves every result in a time range out of statistics (uptime, SLA
 * reports, status pages, charts) — for an outage that shouldn't count, such
 * as planned work nobody put in maintenance. The results are kept; the range
 * can be counted again the same way.
 */
function ExcludeRangeDialog({ checkId, onClose, onDone }: { checkId: string; onClose: () => void; onDone: () => void }) {
  // datetime-local inputs hold local wall-clock time with no zone; new Date()
  // reads them as local, so the instants sent are exactly what was picked.
  const toLocal = (d: Date) => new Date(d.getTime() - d.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const now = new Date();
  const [from, setFrom] = useState(toLocal(new Date(now.getTime() - 3_600_000)));
  const [to, setTo] = useState(toLocal(now));
  const [reason, setReason] = useState("");
  const [include, setInclude] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Exclude a time range from statistics" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Label label="From">
            <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className={inputClass} />
          </Label>
          <Label label="To">
            <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className={inputClass} />
          </Label>
        </div>
        {!include && (
          <Label label="Reason" help="Shown next to the excluded results.">
            <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. planned ISP work" className={inputClass} />
          </Label>
        )}
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} className="accent-[var(--accent)]" />
          Count this range again instead (undo an exclusion)
        </label>
        {error && <p className="text-[var(--down)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={async () => {
              setError(null);
              try {
                const r = await api.excludeResults(checkId, { from: new Date(from).toISOString(), to: new Date(to).toISOString(), exclude: !include, reason: reason || undefined });
                if (!r.changed) setError("No results in that range.");
                else onDone();
              } catch (err) {
                setError(err instanceof Error ? err.message : "Couldn't change the results");
              }
            }}
          >
            {include ? "Count again" : "Exclude"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
