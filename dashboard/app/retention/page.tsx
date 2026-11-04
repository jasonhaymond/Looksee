// The Data retention page (/retention): how long Looksee keeps each kind of
// monitoring data, and the free-space limit that rolls over the oldest data early
// so the disk never fills up. Shows the disk, the database and how big each kind of
// data is.
//
// Where this sits: the engine does the work (engine/src/services/retention.ts); this
// page reads and changes its settings through /api/retention.
//
// "use client" makes this a React component that runs in the browser. Every call is
// refused by the engine without a signed-in session.

"use client";

import { useEffect, useState } from "react";
import { api, type RetentionStatus } from "../lib/api";
import { useSort } from "../lib/useSort";
import { PageHelp } from "../components/PageHelp";
import { Button, ConfirmDialog, Label, SortTh, formatBytes, inputClass, relativeTime, useToast } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

type Kind = RetentionStatus["kinds"][number];

/** The edits on the page before Save. */
type Draft = { rolloverEnabled: boolean; minFreeMode: string; minFreeGb: string; minFreePercent: string; minKeepHours: string; storagePath: string; days: Record<string, string> };

/** Fills the form from what the engine has saved. */
const toDraft = (s: RetentionStatus): Draft => ({
  rolloverEnabled: s.rolloverEnabled,
  minFreeMode: s.minFreeMode,
  minFreeGb: String(s.minFreeGb),
  minFreePercent: String(s.minFreePercent),
  minKeepHours: String(s.minKeepHours),
  storagePath: s.storagePath ?? "",
  days: Object.fromEntries(s.kinds.map((k) => [k.key, k.saved != null ? String(k.saved) : ""])),
});

/**
 * The page. Shows the disk first, then the two groups of settings, and saves them
 * together. "Apply now" deletes data, so it asks first.
 */
export default function RetentionPage() {
  const authed = usePageAuth();
  const [status, setStatus] = useState<RetentionStatus | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const toast = useToast();
  const sort = useSort<Kind>("retention", { label: (k) => k.label, days: (k) => k.days, bytes: (k) => k.bytes, oldest: (k) => k.oldest });

  useEffect(() => {
    if (!authed) return;
    api.retention().then((s) => {
      setStatus(s);
      setDraft(toDraft(s));
    });
  }, [authed]);

  if (!authed || !status || !draft) return null;

  const set = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });
  const disk = status.disk;
  const usedPercent = disk ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : 0;
  const low = disk && status.limitBytes != null && disk.freeBytes < status.limitBytes;
  // The limit being typed, to warn before saving one this disk can never meet.
  const draftLimit = draft.minFreeMode === "percent" ? ((Number(draft.minFreePercent) || 0) / 100) * (disk?.totalBytes ?? 0) : (Number(draft.minFreeGb) || 0) * 1e9;

  /** Saves the form. The engine checks every value and says what's wrong. */
  async function save() {
    setSaving(true);
    setError(null);
    try {
      const s = await api.saveRetention({
        rolloverEnabled: draft!.rolloverEnabled,
        minFreeMode: draft!.minFreeMode,
        minFreeGb: Number(draft!.minFreeGb),
        minFreePercent: Number(draft!.minFreePercent),
        minKeepHours: Number(draft!.minKeepHours),
        storagePath: draft!.storagePath.trim() || null,
        days: Object.fromEntries(Object.entries(draft!.days).map(([k, v]) => [k, v.trim() === "" ? null : Number(v)])),
      });
      setStatus(s);
      setDraft(toDraft(s));
      toast.show("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
      <h1 className="text-lg font-medium">Data retention</h1>
      <PageHelp anchor="data-retention">
        How long Looksee keeps its monitoring data. Old data is deleted every night. If the disk runs low first, the oldest data is rolled over early, even if its period hasn&apos;t run out, so the disk never fills up and stops monitoring.
      </PageHelp>

      <section className="surface space-y-2 rounded-xl p-4 text-sm">
        <h2 className="font-medium">Disk</h2>
        {disk ? (
          <>
            <div className="h-2 overflow-hidden rounded bg-[var(--border)]" role="img" aria-label={`${usedPercent.toFixed(0)}% of the disk used`}>
              <div className="h-2 rounded" style={{ width: `${Math.min(100, usedPercent)}%`, background: low ? "var(--down)" : usedPercent >= 80 ? "var(--warn)" : "var(--up)" }} />
            </div>
            <p>
              <strong>{formatBytes(disk.freeBytes)} free</strong> of {formatBytes(disk.totalBytes)} on <span className="font-mono text-xs">{status.effectivePath}</span>
              {low && <span className="text-[var(--down)]"> — below the {formatBytes(status.limitBytes)} limit</span>}
            </p>
          </>
        ) : (
          <p className="text-[var(--down)]">
            Can&apos;t read the disk at <span className="font-mono text-xs">{status.effectivePath}</span>: {status.diskError}. Until this is fixed, Looksee can&apos;t protect the disk from filling up. Set the disk path below.
          </p>
        )}
        <p className="text-xs text-[var(--muted)]">
          The database uses {formatBytes(status.databaseBytes)}.
          {status.reusableBytes > 0 && ` About ${formatBytes(status.reusableBytes)} of that is freed room new data will reuse. It isn't counted in the disk's free space because there wasn't room to compact the database.`}
        </p>
        {status.lastRolloverAt && (
          <p className="text-xs text-[var(--warn)]">
            Last rollover {relativeTime(status.lastRolloverAt)}: {status.lastRolloverMessage}
          </p>
        )}
      </section>

      <section className="surface space-y-3 rounded-xl p-4 text-sm">
        <h2 className="font-medium">Keep the disk from filling up</h2>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={draft.rolloverEnabled} onChange={(e) => set({ rolloverEnabled: e.target.checked })} className="accent-[var(--accent)]" />
          Roll over the oldest data when free space runs low, even before its retention period is over
        </label>
        {!draft.rolloverEnabled && <p className="text-xs text-[var(--warn)]">With this off, a full disk stops the database, and with it all monitoring.</p>}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Label label="Limit measured as">
            <select value={draft.minFreeMode} onChange={(e) => set({ minFreeMode: e.target.value })} className={inputClass}>
              <option value="gb">GB free</option>
              <option value="percent">Percent free</option>
            </select>
          </Label>
          {draft.minFreeMode === "gb" ? (
            <Label label="Keep at least (GB free)">
              <input type="number" min="0.5" step="0.5" value={draft.minFreeGb} onChange={(e) => set({ minFreeGb: e.target.value })} className={inputClass} />
            </Label>
          ) : (
            <Label label="Keep at least (% free)">
              <input type="number" min="1" max="90" value={draft.minFreePercent} onChange={(e) => set({ minFreePercent: e.target.value })} className={inputClass} />
            </Label>
          )}
          <Label label="Always keep the last (hours)" help="Data this recent is never rolled over, however low the disk is. If only this is left and the disk is still low, something else is filling it; Looksee logs an error rather than deleting more.">
            <input type="number" min="1" max="8760" value={draft.minKeepHours} onChange={(e) => set({ minKeepHours: e.target.value })} className={inputClass} />
          </Label>
        </div>
        {disk && draftLimit >= disk.totalBytes && <p className="text-xs text-[var(--down)]">That limit is larger than this {formatBytes(disk.totalBytes)} disk, so everything older than the &quot;always keep&quot; window would be rolled over.</p>}
        <Label label="Disk to watch" help="Any folder on the disk that holds the database. Blank works it out: DATA_DISK_PATH, then Docker's data folder, then the app's own folder. Set this if the database's data is on another disk.">
          <input value={draft.storagePath} onChange={(e) => set({ storagePath: e.target.value })} placeholder={status.effectivePath} className={`${inputClass} font-mono`} />
        </Label>
      </section>

      <section className="surface rounded-xl p-4 text-sm">
        <h2 className="mb-2 font-medium">Keep each kind of data for</h2>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead className="text-left text-xs text-[var(--muted)]">
              <tr>
                <SortTh sort={sort} column="label" className="py-1 pr-3 font-normal">
                  Data
                </SortTh>
                <SortTh sort={sort} column="days" className="py-1 pr-3 font-normal">
                  Days
                </SortTh>
                <SortTh sort={sort} column="bytes" className="py-1 pr-3 font-normal">
                  Size
                </SortTh>
                <SortTh sort={sort} column="oldest" className="py-1 font-normal">
                  Oldest
                </SortTh>
              </tr>
            </thead>
            <tbody>
              {sort.apply(status.kinds).map((k) => (
                <tr key={k.key} className="border-t border-[var(--border)] align-top">
                  <td className="py-1.5 pr-3">
                    {k.label}
                    <span className="block text-xs text-[var(--muted)]">{k.help}</span>
                  </td>
                  <td className="py-1.5 pr-3">
                    <input
                      type="number"
                      min={k.minDays}
                      value={draft.days[k.key] ?? ""}
                      placeholder={String(k.days)}
                      aria-label={`Days to keep ${k.label}`}
                      onChange={(e) => set({ days: { ...draft.days, [k.key]: e.target.value } })}
                      className={`${inputClass} w-24`}
                    />
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-xs">{formatBytes(k.bytes)}</td>
                  <td className="whitespace-nowrap py-1.5 text-xs text-[var(--muted)]">{k.oldest ? relativeTime(k.oldest) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="mt-2 text-xs text-[var(--muted)]">Leave a box blank for the default shown in it. When the disk runs low, data rolls over in this order: network flows, endpoint metrics, traps and syslog, application logs, software history, and check results last. Security events are never rolled over early, and can&apos;t be set below 30 days here.</p>
      </section>

      {error && <p className="text-sm text-[var(--down)]">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={saving} onClick={save}>
          Save
        </Button>
        <Button onClick={() => setConfirming(true)}>Apply now…</Button>
      </div>

      {confirming && (
        <ConfirmDialog
          title="Apply retention now?"
          message={<p>Deletes everything past its retention period right away instead of tonight, and rolls over old data if the disk is below the limit. This uses the saved settings, so save any changes first. Deleted data can&apos;t be brought back except from a backup.</p>}
          actionLabel="Delete old data"
          onConfirm={async () => {
            const r = await api.runRetention();
            setStatus(r.status);
            toast.show(r.outcome.message);
          }}
          onClose={() => setConfirming(false)}
        />
      )}
      {toast.node}
    </main>
  );
}
