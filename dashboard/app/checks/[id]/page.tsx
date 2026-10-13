"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { api, ApiError, type Channel, type Check, type CheckResult, type CheckStats, type Endpoint, type Host } from "../../lib/api";
import { typeLabel, TYPE_BY_KEY } from "../../lib/checkTypes";
import { TopNav } from "../../components/TopNav";
import { CheckForm } from "../../components/CheckForm";
import { AlertRuleManager } from "../../components/AlertRuleManager";
import { displayStatus, Details, Remediation } from "../../components/CheckDetail";
import { LineChart, StatusStrip } from "../../components/Charts";
import { Button, EmptyState, StatusBadge, relativeTime, useToast } from "../../components/ui";

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
  const [tab, setTab] = useState<"history" | "edit" | "alerts">("history");
  const [ctx, setCtx] = useState<{ endpoints: Endpoint[]; hosts: Host[]; checks: Check[]; channels: Channel[] } | null>(null);
  const [running, setRunning] = useState(false);
  const toast = useToast();

  const loadCheck = useCallback(async () => {
    try {
      setCheck(await api.check(id));
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) router.push("/login");
      else setMissing(true);
    }
  }, [id, router]);

  const loadHistory = useCallback(async () => {
    const since = new Date(Date.now() - hours * 3_600_000).toISOString();
    const [s, r] = await Promise.all([api.checkStats(id, hours), api.checkResults(id, 2000, since)]);
    setStats(s);
    setResults(r);
  }, [id, hours]);

  useEffect(() => {
    loadCheck();
    Promise.all([api.endpoints(), api.hosts(), api.checks(), api.channels()]).then(([endpoints, hosts, checks, channels]) => setCtx({ endpoints, hosts, checks, channels })).catch(() => undefined);
    const t = setInterval(loadCheck, 15_000);
    return () => clearInterval(t);
  }, [loadCheck]);

  useEffect(() => {
    loadHistory().catch(() => undefined);
  }, [loadHistory, check?.lastCheckedAt]);

  const def = check ? TYPE_BY_KEY.get(check.type) : undefined;
  const unit = def?.value?.unit ?? "";
  const latestDetails = useMemo(() => results?.find((r) => r.details != null)?.details, [results]);
  const shownResults = (results ?? []).filter((r) => !onlyProblems || r.status !== "up");

  if (missing)
    return (
      <main className="mx-auto max-w-6xl p-4 sm:p-6">
        <TopNav active="/manage" />
        <EmptyState>That check doesn&apos;t exist (any more). <Link className="underline" href="/manage">Back to checks</Link></EmptyState>
      </main>
    );
  if (!check) return null;

  const host = ctx?.hosts.find((h) => h.id === check.hostId);
  const endpoint = ctx?.endpoints.find((e) => e.id === check.endpointId);
  const hasValue = stats?.series.some((p) => p.value != null);
  const hasLatency = stats?.series.some((p) => p.latency != null);

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <TopNav active="/manage" />
      <div className="mb-1 text-xs text-[var(--muted)]">
        <Link href="/manage" className="underline">
          Checks
        </Link>{" "}
        / {endpoint?.name ?? "…"}
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
          <Button onClick={async () => (await api.updateCheck(check.id, { enabled: !check.enabled }), loadCheck())}>{check.enabled ? "Disable" : "Enable"}</Button>
        </div>
      </div>

      <div className="surface mb-4 space-y-2 rounded-xl p-3 text-sm">
        <p>
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

      {tab === "history" && (
        <div className="grid gap-4 lg:grid-cols-[1fr_1.4fr]">
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
                        {new Date(i.triggeredAt).toLocaleString()} · {Math.round(((i.resolvedAt ? new Date(i.resolvedAt).getTime() : Date.now()) - new Date(i.triggeredAt).getTime()) / 60_000)} min
                      </span>
                    </div>
                    {i.message && <p className="text-xs text-[var(--muted)]">{i.message}</p>}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-[var(--muted)]">No alert incidents in this range{ctx && !ctx.channels.length ? " (and no notification channels exist yet)" : ""}. Incidents are recorded for checks with an alert rule.</p>
            )}
            {latestDetails != null && (
              <div className="mt-4">
                <h2 className="mb-2 text-sm font-medium">Latest details</h2>
                <Details value={latestDetails} />
              </div>
            )}
          </section>
          <section className="surface rounded-xl p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h2 className="text-sm font-medium">Results ({shownResults.length})</h2>
              <label className="flex items-center gap-1.5 text-xs text-[var(--muted)]">
                <input type="checkbox" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} className="accent-[var(--accent)]" />
                Only problems
              </label>
            </div>
            <div className="max-h-[32rem] overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[var(--panel)] text-left text-[var(--muted)]">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Time</th>
                    <th className="pr-2 font-normal">Status</th>
                    <th className="pr-2 font-normal">Value</th>
                    <th className="pr-2 font-normal">ms</th>
                    <th className="font-normal">Message</th>
                  </tr>
                </thead>
                <tbody>
                  {shownResults.map((r) => (
                    <tr key={r.id} className="border-t border-[var(--border)] align-top">
                      <td className="whitespace-nowrap py-1 pr-2 text-[var(--muted)]">{new Date(r.checkedAt).toLocaleString()}</td>
                      <td className="pr-2">
                        <StatusBadge status={r.inMaintenance ? "maintenance" : r.status} />
                      </td>
                      <td className="pr-2">{r.value != null ? Math.round(r.value * 100) / 100 : ""}</td>
                      <td className="pr-2">{r.latencyMs ?? ""}</td>
                      <td>{r.message}</td>
                    </tr>
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
          <CheckForm type={check.type} check={check} endpoints={ctx.endpoints} hosts={ctx.hosts} checks={ctx.checks} onSaved={() => (loadCheck(), setTab("history"), toast.show("Saved."))} onCancel={() => setTab("history")} />
        </div>
      )}
      {tab === "alerts" && (
        <div className="surface rounded-xl p-3">
          <AlertRuleManager checkId={check.id} />
        </div>
      )}
      {toast.node}
    </main>
  );
}
