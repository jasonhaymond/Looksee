"use client";

import { useEffect, useState } from "react";
import { api, type Check, type CheckResult, type Endpoint, type Host } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { AlertRuleManager } from "./AlertRuleManager";
import { CheckForm } from "./CheckForm";
import { Button, StatusBadge, relativeTime } from "./ui";

function CopyText({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <span className="flex items-center gap-2">
      <code className="flex-1 break-all rounded bg-black/30 p-1.5 text-xs">{text}</code>
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

// Structured result details (interface tables, hop lists, containers,
// matched log lines) shown as a table when they're a list of records.
function Details({ value }: { value: unknown }) {
  if (value == null) return null;
  const rows = Array.isArray(value)
    ? value
    : typeof value === "object"
      ? Object.values(value as Record<string, unknown>).find((v) => Array.isArray(v) && v.length && typeof v[0] === "object")
      : null;
  if (Array.isArray(rows) && rows.length && typeof rows[0] === "object" && rows[0] !== null) {
    const cols = [...new Set(rows.flatMap((r) => Object.keys(r as object)))].slice(0, 8);
    return (
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-[var(--muted)]">
              {cols.map((c) => (
                <th key={c} className="px-2 py-1 font-normal">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {(rows as Record<string, unknown>[]).slice(0, 100).map((r, i) => (
              <tr key={i} className="border-t border-[var(--border)]">
                {cols.map((c) => (
                  <td key={c} className="px-2 py-1">
                    {r[c] == null ? "—" : typeof r[c] === "object" ? JSON.stringify(r[c]) : String(r[c])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  return <pre className="max-h-48 overflow-auto rounded bg-black/30 p-2 text-xs">{JSON.stringify(value, null, 2)}</pre>;
}

export function displayStatus(c: Check): string {
  if (!c.enabled) return "disabled";
  if (c.inMaintenance) return "maintenance";
  return c.lastStatus ?? "unknown";
}

export function CheckDetail({
  check,
  endpoints,
  hosts,
  checks,
  onChanged,
}: {
  check: Check;
  endpoints: Endpoint[];
  hosts: Host[];
  checks: Check[];
  onChanged: () => void;
}) {
  const [tab, setTab] = useState<"overview" | "edit" | "alerts">("overview");
  const [results, setResults] = useState<CheckResult[] | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    if (tab !== "overview") return;
    api.checkResults(check.id, 30).then(setResults).catch(() => setResults([]));
  }, [check.id, check.lastCheckedAt, tab]);

  const host = hosts.find((h) => h.id === check.hostId);
  const probeHost = hosts.find((h) => h.id === check.probeHostId);
  const collectorHost = check.collectorHostId ? hosts.find((h) => h.id === check.collectorHostId) : undefined;
  const latestDetails = results?.find((r) => r.details != null)?.details;
  const upCount = results?.filter((r) => r.status === "up").length ?? 0;

  return (
    <div className="space-y-3 border-t border-[var(--border)] bg-[var(--bg)]/40 p-3">
      <div className="flex flex-wrap gap-1">
        {(["overview", "edit", "alerts"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-md px-3 py-1 text-xs ${tab === t ? "bg-[var(--border)] text-[var(--text)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
            {t === "overview" ? "Overview" : t === "edit" ? "Edit" : "Alerts"}
          </button>
        ))}
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
              {results?.length ? `${Math.round((upCount / results.length) * 1000) / 10}% of last ${results.length}` : "—"}
            </div>
          </div>
          {check.lastMessage && <p className="rounded-md bg-[var(--panel)] p-2 text-xs">{check.lastMessage}</p>}
          <p className="text-xs text-[var(--muted)]">
            {typeLabel(check.type)} · every {check.intervalSeconds}s{check.retryIntervalSeconds ? ` (retry ${check.retryIntervalSeconds}s)` : ""}
            {host ? ` · host ${host.name}` : ""}
            {probeHost ? ` · runs from agent on ${probeHost.name}` : ""}
            {collectorHost ? ` · runs on the site collector on ${collectorHost.name}` : ""}
          </p>
          {check.pushUrl && (
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
              <ul className="max-h-56 space-y-1 overflow-y-auto text-xs">
                {results.map((r) => (
                  <li key={r.id} className="flex items-start gap-2">
                    <StatusBadge status={r.inMaintenance ? "maintenance" : r.status} compact />
                    <span className="w-16 shrink-0 text-[var(--muted)]">{relativeTime(r.checkedAt)}</span>
                    {r.value != null && <span className="shrink-0">{Math.round(r.value * 100) / 100}</span>}
                    <span className="text-[var(--muted)]">{r.message}</span>
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
          endpoints={endpoints}
          hosts={hosts}
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
