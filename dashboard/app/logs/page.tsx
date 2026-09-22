"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type LogEntry, type LogLevel } from "../lib/api";
import { TopNav } from "../components/TopNav";
import { Tooltip } from "../components/Tooltip";

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

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
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
          {hasDetail && (
            <button onClick={() => setExpanded((v) => !v)} className="mt-1 text-xs text-[var(--muted)] underline">
              {expanded ? "hide detail" : "show technical detail"}
            </button>
          )}
          {expanded && (
            <div className="mt-1 space-y-1 rounded bg-black/30 p-1.5 font-mono text-xs">
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

  const loadAll = useCallback(async () => {
    const rows = await api.logs({ level: level || undefined, limit: 200 });
    setEntries(rows);
  }, [level]);

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
    const timer = setInterval(loadAll, POLL_MS);
    return () => clearInterval(timer);
  }, [authChecked, loadAll]);

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/logs" />
      <h2 className="mb-4 inline-flex items-center text-lg font-medium">
        Logs
        <Tooltip text="Debug: verbose technical detail, mainly for troubleshooting. Info: routine events worth knowing about. Warn/Error: something needs attention — these are the ones with a plain-language explanation alongside the technical detail." />
      </h2>

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

      {entries.length === 0 ? (
        <p className="text-sm text-[var(--muted)]">No log entries yet at this level.</p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => (
            <LogRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </main>
  );
}
