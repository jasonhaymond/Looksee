// The Logs page (/logs): the engine's own activity log with level filter,
// refreshing live. Entries about an endpoint (their metadata carries its ID)
// link to that endpoint's page and can be narrowed to just that endpoint
// (/logs?endpointId=<id>). "use client" makes this a React component that
// runs in the browser; the engine refuses every call without a session.

"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { api, ApiError, type LogEntry, type LogLevel } from "../lib/api";
import { Tooltip } from "../components/Tooltip";
import { PageHelp } from "../components/PageHelp";
import { pollEvery } from "../lib/poll";

const POLL_MS = 5_000;

const LEVEL_COLOR: Record<LogLevel, string> = {
  debug: "var(--muted)",
  info: "var(--text)",
  warn: "var(--warn)",
  error: "var(--down)",
};

const LEVEL_FILTERS: { value: LogLevel | ""; label: string }[] = [
  { value: "", label: "All" },
  { value: "debug", label: "Debug" },
  { value: "info", label: "Info" },
  { value: "warn", label: "Warn" },
  { value: "error", label: "Error" },
];

/** The endpoint an entry is about, from its metadata — when it names one. */
function endpointOf(entry: LogEntry): { id: string; name: string | null } | null {
  const id = entry.metadata?.endpointId;
  if (typeof id !== "string" || !id) return null;
  const name = entry.metadata?.endpointName;
  return { id, name: typeof name === "string" && name ? name : null };
}

/**
 * One log entry: level, source, time and the plain-language message, with
 * the technical message and metadata behind "show technical detail". An
 * entry about an endpoint links to it, and to the log narrowed to it
 * (onOnlyEndpoint).
 */
function LogRow({ entry, onOnlyEndpoint }: { entry: LogEntry; onOnlyEndpoint: (id: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const endpoint = endpointOf(entry);
  const hasDetail = entry.level !== "debug" && (entry.metadata != null || entry.humanMessage !== entry.message);

  return (
    <li className="rounded-md border border-[var(--border)] p-2 text-sm">
      <div className="flex items-start gap-2">
        <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: LEVEL_COLOR[entry.level] }} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2 text-xs text-[var(--muted)]">
            <span className="font-medium" style={{ color: LEVEL_COLOR[entry.level] }}>
              {entry.level.toUpperCase()}
            </span>
            <span className="font-mono">{entry.source}</span>
            <span>{new Date(entry.createdAt).toLocaleString()}</span>
          </div>
          <p className="mt-0.5 break-words">{entry.level === "debug" ? entry.message : entry.humanMessage}</p>
          {endpoint && (
            <p className="mt-0.5 text-xs text-[var(--muted)]">
              Endpoint:{" "}
              <Link href={`/endpoints/${encodeURIComponent(endpoint.id)}`} className="underline">
                {endpoint.name ?? "open endpoint"}
              </Link>
              {" · "}
              <button onClick={() => onOnlyEndpoint(endpoint.id)} className="underline">
                only this endpoint
              </button>
            </p>
          )}
          {hasDetail && (
            <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-xs text-[var(--muted)] underline">
              {expanded ? "hide detail" : "show technical detail"}
            </button>
          )}
          {expanded && (
            <div className="mt-1 space-y-1 rounded bg-[var(--code-bg)] p-1.5 font-mono text-xs">
              <p className="break-words">{entry.message}</p>
              {entry.metadata && <pre className="overflow-x-auto whitespace-pre-wrap break-words">{JSON.stringify(entry.metadata, null, 2)}</pre>}
            </div>
          )}
        </div>
      </div>
    </li>
  );
}

export default function LogsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [level, setLevel] = useState<LogLevel | "">("");
  const [entries, setEntries] = useState<LogEntry[]>([]);
  // Narrowed to one endpoint's entries, when set — from "only this
  // endpoint" on a row, or ?endpointId= in the address (read once, on the
  // first render in the browser; the page shows nothing until sign-in is
  // confirmed, so the server-rendered HTML never differs because of it).
  const [endpointId, setEndpointId] = useState<string | null>(() => (typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("endpointId")));

  const loadAll = useCallback(() =>
    api.logs({ level: level || undefined, limit: 200, endpointId: endpointId ?? undefined }).then((rows) => {
    setEntries(rows);
  }), [level, endpointId]);

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
    loadAll();
    const timer = pollEvery(loadAll, POLL_MS);
    return () => clearInterval(timer);
  }, [authChecked, loadAll]);

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-4xl p-4 sm:p-6">
      <h2 className="mb-4 inline-flex items-center text-lg font-medium">
        Logs
        <Tooltip text="Debug: verbose technical detail, mainly for troubleshooting. Info: routine events worth knowing about. Warn/Error: something needs attention — these are the ones with a plain-language explanation alongside the technical detail." />
      </h2>
      <PageHelp anchor="backups-and-logs">
        The engine&apos;s own activity log — what it&apos;s doing and why. Filter by level below; warn/error entries include a plain-language explanation.
      </PageHelp>

      <div className="mb-4 flex gap-1 text-sm">
        {LEVEL_FILTERS.map((f) => (
          <button
            key={f.value || "all"}
            onClick={() => setLevel(f.value)}
            className={`rounded-md border px-2 py-1 ${level === f.value ? "border-[var(--up)] text-[var(--up)]" : "border-[var(--border)] text-[var(--muted)]"}`}
          >
            {f.label}
          </button>
        ))}
      </div>
      {endpointId && (
        <p className="mb-3 text-xs text-[var(--muted)]">
          Showing only entries about one endpoint.{" "}
          <button onClick={() => setEndpointId(null)} className="underline">
            Show all
          </button>
        </p>
      )}

      {entries.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No log entries yet at this level.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <LogRow key={entry.id} entry={entry} onOnlyEndpoint={setEndpointId} />
          ))}
        </ul>
      )}
    </main>
  );
}
