"use client";

import { useState } from "react";
import { api, type Archive } from "../lib/api";

export function RestoreForm({ archive, onStarted }: { archive: Archive; onStarted: () => void }) {
  const [open, setOpen] = useState(false);
  const [restoreDb, setRestoreDb] = useState(true);
  const [restoreConfig, setRestoreConfig] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setError(null);
    try {
      await api.restoreBackup({ archiveName: archive.name, confirmArchiveName: confirmText, restoreDb, restoreConfig });
      setOpen(false);
      setConfirmText("");
      onStarted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start restore");
    }
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} className="text-xs text-[var(--down)] hover:underline">
        Restore
      </button>
    );
  }

  return (
    <div className="mt-2 space-y-2 rounded-md border border-[var(--down)]/40 bg-[var(--down)]/5 p-3 text-xs">
      <p className="text-[var(--down)]">
        This overwrites live data with the contents of <strong>{archive.name}</strong>. This cannot be undone.
      </p>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={restoreDb} onChange={(e) => setRestoreDb(e.target.checked)} />
        Restore database
      </label>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={restoreConfig} onChange={(e) => setRestoreConfig(e.target.checked)} />
        Restore config files (engine/.env, dashboard/.env) — requires a manual app restart after
      </label>
      <label className="block">
        Type <code>{archive.name}</code> to confirm:
        <input
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
        />
      </label>
      {error && <p className="text-[var(--down)]">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={handleConfirm}
          disabled={confirmText !== archive.name}
          className="rounded-md bg-[var(--down)] px-3 py-1 font-medium text-black disabled:opacity-40"
        >
          Restore now
        </button>
        <button onClick={() => setOpen(false)} className="text-[var(--muted)]">
          Cancel
        </button>
      </div>
    </div>
  );
}
