// The inline check detail on the Checks list: status, history, suggested
// things to check (remediation), recovery URL, what it ignores, alert rules,
// and the result details table. Also exports the pieces the check page
// (app/checks/[id]/page.tsx) reuses: Details (a result's details as tables),
// ResultFull (everything about one past result, shown when its row is
// opened) and DetailsToggle (that row's Show/Hide button).

"use client";

import { Fragment, useEffect, useState } from "react";
import { RecoveryUrl, ResolveButton } from "./CheckRecovery";
import { ExclusionsApplied } from "./ExclusionsApplied";
import { api, type Check, type CheckResult, type Site, type Endpoint } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { AlertRuleManager } from "./AlertRuleManager";
import { CheckForm } from "./CheckForm";
import { Button, SortTh, StatusBadge, relativeTime } from "./ui";
import { useSort } from "../lib/useSort";
import { own } from "../lib/own";

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <code className="flex-1 break-all rounded bg-[var(--code-bg)] p-1.5 text-xs">{text}</code>
      <button
        type="button"
        onClick={async () => {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }}
        className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--text)]"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </span>
  );
}

// "Things to check" for a failing check, worked out by the engine from the
// failure message and check type.
export function Remediation({ check }: { check: Check }) {
  const hints = check.remediation ?? [];
  const st = displayStatus(check);
  if (!hints.length || (st !== "down" && st !== "warn")) return null;
  return (
    <div className={`rounded-md border p-2 text-xs ${st === "down" ? "border-[var(--down)]/50 bg-[var(--down)]/10" : "border-[var(--warn)]/50 bg-[var(--warn)]/10"}`}>
      <div className="mb-1 font-medium text-[var(--text)]">Things to check</div>
      <ul className="list-disc space-y-0.5 pl-4 text-[var(--text)]">
        {hints.map((h) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

// Structured result details (interface tables, hop lists, containers,
// matched log lines, zone changes, vulnerable packages) shown in full: every
// list of records as its own sortable table, every other field as a label
// and value.

/** Rows a table shows before "Show all": enough for most results, quick to draw. */
const ROWS_AT_FIRST = 100;

/** Whether a value is a plain record (an object that isn't a list). */
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** Whether a value is a non-empty list of records — shown as a table. */
const isTable = (v: unknown): v is Record<string, unknown>[] => Array.isArray(v) && v.length > 0 && v.every(isRecord);

/**
 * One table cell. Nothing shows as "—"; a list of plain values as a comma
 * list; a list of records with an `id` (advisories) as "id (severity)"; an
 * http(s) address as a link; other objects as JSON. Text wraps rather than
 * being cut off.
 */
function Cell({ v, column }: { v: unknown; column?: string }) {
  if (v == null || v === "") return <>—</>;
  // A suggested command (software checks' "how to fix"): shown as code with
  // a Copy button, never run by the dashboard.
  if (column === "command" && typeof v === "string") return <CopyText text={v} />;
  if (Array.isArray(v)) {
    if (v.every((x) => typeof x !== "object" || x === null)) return <>{v.map(String).join(", ")}</>;
    if (v.every((x) => isRecord(x) && typeof x.id === "string")) return <>{v.map((x) => `${String(x.id)}${typeof x.severity === "string" ? ` (${x.severity})` : ""}`).join(", ")}</>;
    return <>{JSON.stringify(v)}</>;
  }
  if (typeof v === "object") return <>{JSON.stringify(v)}</>;
  const text = String(v);
  // An in-app help section links within the dashboard. The regex matches
  // only "/help/" followed by letters, digits and / _ # - (one character
  // class, so it runs in linear time), e.g. "/help/patching#apt-kept-back".
  if (/^\/help\/[A-Za-z0-9/_#-]*$/.test(text)) {
    return (
      <a href={text} target="_blank" rel="noopener" className="underline">
        Help
      </a>
    );
  }
  // Only http and https addresses become links (this regex matches a value
  // that is a single web address, e.g. "https://osv.dev/vulnerability/CVE-…"),
  // so text from a check can't turn into a javascript: or other link.
  if (/^https?:\/\/[^\s]+$/.test(text)) {
    return (
      <a href={text} target="_blank" rel="noopener noreferrer" className="break-all underline">
        {text}
      </a>
    );
  }
  return <>{text}</>;
}

/** A field name as a heading: "checkedPackages" → "Checked packages". */
const titleOf = (key: string) => {
  const words = key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

/** Text longer than this in any row makes its column a "long" field (shown under the row). */
const LONG_TEXT = 60;

/**
 * A check's list of records (sessions, interfaces, hops, containers) as a table you
 * can sort by any column. Every field is shown: short ones as columns (the table
 * scrolls sideways when it's wide), long text — explanations, commands, long links —
 * on a full-width line under its row, so a paragraph doesn't make a narrow column
 * and push the rest off-screen. The first 100 rows are shown, with "Show all" for
 * the rest. Sorting is remembered per set of columns.
 */
function DetailsTable({ rows, columns }: { rows: Record<string, unknown>[]; columns?: string[] }) {
  const [all, setAll] = useState(false);
  // A check can name its field order. Otherwise the order comes from the records,
  // which is arbitrary once stored: the database rearranges an object's keys.
  // Fields a check named come first, then any others it didn't name.
  const present = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const fields = columns ? [...columns.filter((c) => present.includes(c)), ...present.filter((c) => !columns.includes(c))] : present;
  // Long fields: a suggested command, or text longer than LONG_TEXT in any row.
  const isLong = (c: string) => c === "command" || rows.some((r) => typeof own(r, c) === "string" && String(own(r, c)).length > LONG_TEXT);
  const longCols = fields.filter(isLong);
  const cols = fields.filter((c) => !longCols.includes(c));
  // Numbers and text sort as themselves; anything else as its displayed text.
  const read = (c: string) => (r: Record<string, unknown>) => {
    const v = own(r, c);
    return typeof v === "number" || typeof v === "string" || typeof v === "boolean" || v == null ? v : JSON.stringify(v);
  };
  const sort = useSort<Record<string, unknown>>(`details.${cols.join(",")}`, Object.fromEntries(cols.map((c) => [c, read(c)])));
  const sorted = sort.apply(rows);
  const shown = all ? sorted : sorted.slice(0, ROWS_AT_FIRST);
  return (
    <div>
      {/* Phones: each record as a card, every field labelled and wrapping
          (a wide table would cut long text off at the screen edge). */}
      <ul className="space-y-2 sm:hidden">
        {shown.map((r, i) => (
          <li key={i} className="rounded-md border border-[var(--border)] p-2 text-xs">
            <dl className="space-y-1">
              {fields
                .filter((c) => own(r, c) != null && own(r, c) !== "")
                .map((c) => (
                  <div key={c}>
                    <dt className="text-[var(--muted)]">{c}</dt>
                    <dd className="min-w-0 whitespace-pre-wrap break-words">
                      <Cell v={own(r, c)} column={c} />
                    </dd>
                  </div>
                ))}
            </dl>
          </li>
        ))}
      </ul>
      {/* Wider screens: a sortable table. */}
      <div className="hidden overflow-x-auto sm:block">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-left text-[var(--muted)]">
            {cols.map((c) => (
              <SortTh key={c} sort={sort} column={c} className="px-2 py-1 font-normal">
                {c}
              </SortTh>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <Fragment key={i}>
              <tr className="border-t border-[var(--border)] align-top">
                {cols.map((c) => (
                  <td key={c} className="max-w-[40rem] whitespace-pre-wrap break-words px-2 py-1">
                    <Cell v={own(r, c)} column={c} />
                  </td>
                ))}
              </tr>
              {/* This row's long fields, each labelled, across the whole table. */}
              {longCols.some((c) => own(r, c) != null && own(r, c) !== "") && (
                <tr className="align-top">
                  <td colSpan={Math.max(1, cols.length)} className="px-2 pb-2">
                    <dl className="space-y-1">
                      {longCols
                        .filter((c) => own(r, c) != null && own(r, c) !== "")
                        .map((c) => (
                          <div key={c} className="grid grid-cols-1 gap-x-2 sm:grid-cols-[6rem_1fr]">
                            <dt className="text-[var(--muted)]">{c}</dt>
                            <dd className="min-w-0 whitespace-pre-wrap break-words">
                              <Cell v={own(r, c)} column={c} />
                            </dd>
                          </div>
                        ))}
                    </dl>
                  </td>
                </tr>
              )}
            </Fragment>
          ))}
        </tbody>
      </table>
      </div>
      {rows.length > ROWS_AT_FIRST && (
        <button type="button" onClick={() => setAll(!all)} className="mt-1 text-xs text-[var(--muted)] underline hover:text-[var(--text)]">
          {all ? `Show the first ${ROWS_AT_FIRST}` : `Show all ${rows.length} rows`}
        </button>
      )}
    </div>
  );
}

/**
 * A result's details, all of it. A list of records is one table. An object
 * is shown field by field: each list of records as its own titled table
 * ("Changes (3)", "History (40)", "Records (120)"), plain values as label
 * and value, and anything else as formatted JSON. `columns`, when a check
 * sends it, is the field order — not a field to show: a list (for its first
 * table) or, per table, { tableName: [fields…] }.
 *
 * @param value the result's `details` as stored
 */
export function Details({ value }: { value: unknown }) {
  if (value == null) return null;
  if (isTable(value)) return <DetailsTable rows={value} />;
  if (!isRecord(value)) return <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--code-bg)] p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>;
  const named = Array.isArray(value.columns) ? (value.columns as string[]) : undefined;
  const perTable = isRecord(value.columns) ? value.columns : undefined;
  /** The field order a check named for one table, if any. */
  const orderFor = (table: string, index: number): string[] | undefined => {
    const list = perTable ? own(perTable, table) : index === 0 ? named : undefined;
    return Array.isArray(list) ? list.map(String) : undefined;
  };
  const entries = Object.entries(value).filter(([k]) => k !== "columns");
  const tables = entries.filter(([, v]) => isTable(v)) as [string, Record<string, unknown>[]][];
  const plain = entries.filter(([, v]) => !isTable(v) && (v == null || typeof v !== "object" || (Array.isArray(v) && v.every((x) => typeof x !== "object" || x === null))));
  const nested = entries.filter(([k]) => !tables.some(([t]) => t === k) && !plain.some(([p]) => p === k));
  return (
    <div className="space-y-3">
      {plain.length > 0 && (
        <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-xs">
          {plain.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[var(--muted)]">{titleOf(k)}</dt>
              <dd className="whitespace-pre-wrap break-words">{Array.isArray(v) && v.length === 0 ? "none" : <Cell v={v} />}</dd>
            </div>
          ))}
        </dl>
      )}
      {tables.map(([k, rows], i) => (
        <div key={k}>
          {(tables.length > 1 || plain.length > 0) && (
            <div className="mb-1 text-xs font-medium">
              {titleOf(k)} ({rows.length})
            </div>
          )}
          <DetailsTable rows={rows} columns={orderFor(k, i)} />
        </div>
      ))}
      {nested.map(([k, v]) => (
        <div key={k}>
          <div className="mb-1 text-xs font-medium">{titleOf(k)}</div>
          <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-[var(--code-bg)] p-2 text-xs">{JSON.stringify(v, null, 2)}</pre>
        </div>
      ))}
    </div>
  );
}

/**
 * Everything stored about one result, for a result row that has been opened:
 * the exact time, status, maintenance and exclusion flags, the unrounded
 * value, the response time, the whole message, and the full details (the
 * same tables as "Latest details"). Results older than the engine's details
 * retention (services/retention.ts, 7 days) keep everything except the
 * details, which are cleared to save space — that is said here rather than
 * showing an empty box.
 *
 * @param result one row from GET /api/checks/:id/results
 */
export function ResultFull({ result: r }: { result: CheckResult }) {
  const fields: [string, React.ReactNode][] = [
    ["Checked at", `${new Date(r.checkedAt).toLocaleString()} (${relativeTime(r.checkedAt)})`],
    ["Status", r.status],
    ["Value", r.value != null ? String(r.value) : "—"],
    ["Response time", r.latencyMs != null ? `${r.latencyMs} ms` : "—"],
    ["In maintenance", r.inMaintenance ? "yes" : "no"],
    ["Counted in statistics", r.excluded ? `no — excluded${r.excludedReason ? `: ${r.excludedReason}` : ""}` : "yes"],
  ];
  return (
    <div className="space-y-2 rounded-md border border-[var(--border)] bg-[var(--panel)] p-2 text-xs">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5">
        {fields.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-[var(--muted)]">{k}</dt>
            <dd className="min-w-0 break-words">{v}</dd>
          </div>
        ))}
      </dl>
      <div>
        <div className="mb-0.5 text-[var(--muted)]">Message</div>
        <p className="whitespace-pre-wrap break-words">{r.message || "—"}</p>
      </div>
      <div>
        <div className="mb-0.5 text-[var(--muted)]">Details</div>
        {r.details != null ? <Details value={r.details} /> : <p className="text-[var(--muted)]">None stored for this result. Some check types record no details, and details are cleared from results older than 7 days to save space (the rest of the result is kept).</p>}
      </div>
    </div>
  );
}

/**
 * A small "Show details" / "Hide details" toggle for one result row.
 *
 * @param open whether that row is expanded
 * @param onToggle flips it
 */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button type="button" onClick={onToggle} aria-expanded={open} className="whitespace-nowrap text-[10px] text-[var(--muted)] underline hover:text-[var(--text)]">
      {open ? "Hide details" : "Show details"}
    </button>
  );
}

export function displayStatus(c: Check): string {
  if (!c.enabled) return "disabled";
  if (c.inMaintenance) return "maintenance";
  return c.lastStatus ?? "unknown";
}

export function CheckDetail({
  check,
  sites,
  endpoints,
  checks,
  onChanged,
}: {
  check: Check;
  sites: Site[];
  endpoints: Endpoint[];
  checks: Check[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "edit" | "alerts">("overview");
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);
  // Result rows the user has opened (by result id), kept across the
  // re-fetch after each new check run so an open row stays open.
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const toggleOpen = (rid: string) =>
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(rid)) next.delete(rid);
      else next.add(rid);
      return next;
    });

  useEffect(() => {
    if (tab !== "overview") return;
    api.checkResults(check.id, 30).then(setResults).catch(() => setResults([]));
  }, [check.id, check.lastCheckedAt, tab]);

  const host = endpoints.find((h) => h.id === check.endpointId);
  const probeEndpoint = endpoints.find((h) => h.id === check.probeEndpointId);
  const collectorEndpoint = check.collectorEndpointId ? endpoints.find((h) => h.id === check.collectorEndpointId) : undefined;
  const latestDetails = results?.find((r) => r.details != null)?.details;
  // Uptime ignores maintenance-time and excluded results, like the reports.
  const counted = results?.filter((r) => !r.inMaintenance && !r.excluded) ?? [];
  const upCount = counted.filter((r) => r.status === "up").length;

  return (
    <div className="space-y-3 border-t border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-1">
        {(["overview", "edit", "alerts"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-xs ${tab === t ? "bg-[var(--panel-2)] text-[var(--text)] ring-1 ring-[var(--border)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
            {t === "overview" ? "Overview" : t === "edit" ? "Edit" : "Alerts"}
          </button>
        ))}
        <span className="flex-1" />
        <a href={`/checks/${check.id}`} className="rounded-md px-2 py-1 text-xs text-[var(--muted)] underline hover:text-[var(--text)]">
          Full history, charts &amp; incidents →
        </a>
      </div>

      {tab === "overview" && (
        <div className="space-y-3 text-sm">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <div className="text-xs text-[var(--muted)]">Status</div>
              <StatusBadge status={displayStatus(check)} />
              {check.flapping && <div className="text-xs text-[var(--warn)]">Flapping — alerts held</div>}
              {check.blockedBy && <div className="text-xs text-[var(--muted)]">Parent “{check.blockedBy}” is down</div>}
            </div>
            <div>
              <div className="text-xs text-[var(--muted)]">Since</div>
              {relativeTime(check.lastStatusChangeAt)}
            </div>
            <div>
              <div className="text-xs text-[var(--muted)]">Last checked</div>
              {relativeTime(check.lastCheckedAt)}
              {check.lastLatencyMs != null && <span className="text-[var(--muted)]"> · {check.lastLatencyMs} ms</span>}
            </div>
            <div>
              <div className="text-xs text-[var(--muted)]">Recent uptime</div>
              {counted.length ? `${Math.round((upCount / counted.length) * 1000) / 10}% of last ${counted.length}` : "—"}
            </div>
          </div>
          {check.lastMessage && <p className="whitespace-pre-wrap break-words rounded-md bg-[var(--panel)] p-2 text-xs">{check.lastMessage}</p>}
          <Remediation check={check} />
          <p className="text-xs text-[var(--muted)]">
            {typeLabel(check.type)} · every {check.intervalSeconds}s{check.retryIntervalSeconds ? ` (retry ${check.retryIntervalSeconds}s)` : ""}
            {host ? ` · endpoint ${host.name}` : ""}
            {probeEndpoint ? ` · runs from agent on ${probeEndpoint.name}` : ""}
            {collectorEndpoint ? ` · runs on the site collector on ${collectorEndpoint.name}` : ""}
          </p>
          <RecoveryUrl check={check} onChanged={onChanged} />
          <ExclusionsApplied check={check} />
          {check.pushUrl && (check.type === "heartbeat" || check.type === "push_value") && (
            <div className="space-y-1.5 rounded-md border border-[var(--border)] p-2">
              <p className="text-xs text-[var(--muted)]">
                Call this URL from your job{check.type === "push_value" ? " with ?value=NUMBER" : " when it finishes"}. Add <code>?status=down&amp;msg=…</code> to report a failure.
              </p>
              <CopyText text={check.pushUrl} />
              <CopyText text={check.type === "push_value" ? `curl -fsS "${check.pushUrl}?value=42"` : `curl -fsS --retry 3 "${check.pushUrl}"`} />
              <button
                onClick={async () => {
                  if (!confirm("Create a new URL? The current one stops working immediately.")) return;
                  await api.regeneratePushToken(check.id);
                  onChanged();
                }}
                className="text-xs text-[var(--muted)] underline"
              >
                Regenerate URL
              </button>
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <ResolveButton check={check} onDone={onChanged} />
            <Button
              disabled={running}
              onClick={async () => {
                setRunning(true);
                try {
                  const res = await api.runCheck(check.id);
                  if ("queued" in res) alert(res.message);
                } catch (err) {
                  alert(err instanceof Error ? err.message : "Run failed");
                } finally {
                  setRunning(false);
                  onChanged();
                }
              }}
            >
              {running ? "Running…" : "Run now"}
            </Button>
            <Button onClick={async () => (await api.updateCheck(check.id, { enabled: !check.enabled }), onChanged())}>{check.enabled ? "Disable" : "Enable"}</Button>
          </div>
          {latestDetails != null && (
            <div>
              <div className="mb-1 text-xs text-[var(--muted)]">Latest details</div>
              <Details value={latestDetails} />
            </div>
          )}
          {results && results.length > 0 && (
            <div>
              <div className="mb-1 text-xs text-[var(--muted)]">Recent results</div>
              {/* Each row opens to everything stored about that result
                  (ResultFull above). The list grows taller while a row is
                  open, since details can be whole tables. */}
              <ul className={`${openIds.size ? "max-h-[40rem]" : "max-h-56"} space-y-1 overflow-y-auto text-xs`}>
                {results.map((r) => (
                  <li key={r.id}>
                    {/* The whole line opens the result, not only its link;
                        a click on the link itself is left to the link. */}
                    <div
                      className="flex cursor-pointer items-start gap-2 rounded hover:bg-[var(--panel-2)]"
                      onClick={(e) => {
                        if (!(e.target as HTMLElement).closest("button")) toggleOpen(r.id);
                      }}
                    >
                      <StatusBadge status={r.inMaintenance ? "maintenance" : r.status} compact />
                      <span className="w-16 shrink-0 text-[var(--muted)]">{relativeTime(r.checkedAt)}</span>
                      {r.value != null && <span className="shrink-0">{Math.round(r.value * 100) / 100}</span>}
                      <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-[var(--muted)]">{r.message}</span>
                      <DetailsToggle open={openIds.has(r.id)} onToggle={() => toggleOpen(r.id)} />
                    </div>
                    {openIds.has(r.id) && (
                      <div className="mt-1">
                        <ResultFull result={r} />
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {tab === "edit" && (
        <CheckForm
          type={check.type}
          check={check}
          sites={sites}
          endpoints={endpoints}
          checks={checks}
          onSaved={() => {
            setTab("overview");
            onChanged();
          }}
          onCancel={() => setTab("overview")}
        />
      )}

      {tab === "alerts" && <AlertRuleManager checkId={check.id} />}
    </div>
  );
}
