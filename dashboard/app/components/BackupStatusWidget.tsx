"use client";

import { useEffect, useState } from "react";
import { api, type BackupRun, type CurrentOperation } from "../lib/api";

const POLL_MS = 15_000;

const STATUS_COLOR: Record<BackupRun["status"], string> = {
  success: "var(--up)",
  error: "var(--down)",
  running: "var(--warn)",
};

export function BackupStatusWidget() {
  const [lastRun, setLastRun] = useState<BackupRun | null | undefined>(undefined);
  const [currentOp, setCurrentOp] = useState<CurrentOperation>(null);

  useEffect(() => {
    const load = async () => {
      const [status, runsRes] = await Promise.all([api.backupStatus(), api.backupRuns()]);
      setCurrentOp(status.currentOperation);
      setLastRun(runsRes.runs.find((r) => r.kind === "backup") ?? null);
    };
    load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <div className="h-full rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
      <h3 className="font-medium">Backups</h3>
      {lastRun === undefined ? (
        <p className="mt-2 text-xs text-[var(--muted)]">Loading…</p>
      ) : currentOp ? (
        <p className="mt-2 text-sm" style={{ color: "var(--warn)" }}>
          {currentOp.kind === "backup" ? "Backup" : "Restore"} in progress…
        </p>
      ) : !lastRun ? (
        <p className="mt-2 text-xs text-[var(--muted)]">No backups run yet — see Backups to set one up.</p>
      ) : (
        <>
          <p className="mt-1 text-lg font-semibold" style={{ color: STATUS_COLOR[lastRun.status] }}>
            {lastRun.status.toUpperCase()}
          </p>
          <p className="text-xs text-[var(--muted)]">{new Date(lastRun.startedAt).toLocaleString()}</p>
          {lastRun.message && <p className="mt-1 text-xs text-[var(--muted)]">{lastRun.message}</p>}
        </>
      )}
    </div>
  );
}
