"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type BackupSettings, type BackupRun, type Archive, type CurrentOperation } from "../lib/api";
import { RestoreForm } from "./RestoreForm";
import { TopNav } from "../components/TopNav";
import { Tooltip } from "../components/Tooltip";

const POLL_MS = 5_000;

export default function BackupsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [settings, setSettings] = useState<BackupSettings | null>(null);
  const [borgAvailable, setBorgAvailable] = useState(false);
  const [borgVersion, setBorgVersion] = useState<string | null>(null);
  const [currentOp, setCurrentOp] = useState<CurrentOperation>(null);
  const [runs, setRuns] = useState<BackupRun[]>([]);
  const [archives, setArchives] = useState<Archive[]>([]);
  const [sshKey, setSshKey] = useState<string | null>(null);

  const [repoUrl, setRepoUrl] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [schedule, setSchedule] = useState("");
  const [retentionCount, setRetentionCount] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const loadAll = useCallback(async () => {
    const [settingsRes, statusRes, runsRes, archivesRes] = await Promise.all([
      api.backupSettings(),
      api.backupStatus(),
      api.backupRuns(),
      api.backupArchives().catch(() => ({ archives: [] })),
    ]);
    setSettings(settingsRes.settings);
    setBorgAvailable(settingsRes.borgAvailable);
    setBorgVersion(settingsRes.borgVersion);
    setCurrentOp(statusRes.currentOperation);
    setRuns(runsRes.runs);
    setArchives(archivesRes.archives);
    setRepoUrl(settingsRes.settings.repoUrl ?? "");
    setSchedule(settingsRes.settings.schedule ?? "");
    setRetentionCount(settingsRes.settings.retentionCount != null ? String(settingsRes.settings.retentionCount) : "");
  }, []);

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

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);
    try {
      await api.updateBackupSettings({
        repoUrl,
        ...(passphrase ? { passphrase } : {}),
        schedule: schedule.trim() ? schedule.trim() : null,
        retentionCount: retentionCount.trim() ? Number(retentionCount) : null,
      });
      setPassphrase("");
      setSaved(true);
      loadAll();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save settings");
    }
  }

  async function handleShowSshKey() {
    try {
      const { publicKey } = await api.backupSshPublicKey();
      setSshKey(publicKey);
    } catch (err) {
      setSshKey(`Error: ${err instanceof Error ? err.message : "failed to generate key"}`);
    }
  }

  async function handleBackupNow() {
    await api.runBackup();
    loadAll();
  }

  if (!authChecked || !settings) return null;

  return (
    <main className="mx-auto max-w-3xl p-6">
      <TopNav active="/backups" />
      <h2 className="mb-4 text-lg font-medium">Backups</h2>

      <div className="mb-4 flex items-center gap-2 text-sm">
        <span className={`h-2 w-2 rounded-full ${borgAvailable ? "bg-[var(--up)]" : "bg-[var(--down)]"}`} />
        {borgAvailable ? `borg ${borgVersion} available` : "borg is not installed on this host — settings can be saved, but backups will fail until it is"}
      </div>

      {currentOp && (
        <div className="mb-4 rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 px-3 py-2 text-sm text-[var(--warn)]">
          A {currentOp.kind} is currently running (started {new Date(currentOp.startedAt).toLocaleTimeString()})...
        </div>
      )}

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <h2 className="mb-3 font-medium">Repository settings</h2>
        <form onSubmit={handleSave} className="space-y-3 text-sm">
          <label className="block">
            <span className="inline-flex items-center">
              Repository
              <Tooltip text={'Where Borg stores encrypted backup archives. A local path (e.g. /var/backups/looksee) is simplest; user@host:path uses SSH to back up to a different machine — click "Show SSH public key" below to authorize this engine on that machine.'} />
            </span>{" "}
            (local path or <code>user@host:path</code> for SSH)
            <input
              value={repoUrl}
              onChange={(e) => setRepoUrl(e.target.value)}
              placeholder="/var/backups/looksee or backup@host:/srv/backups/looksee"
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
            />
          </label>
          <label className="block">
            <span className="inline-flex items-center">
              Passphrase
              <Tooltip text="Encrypts the backup repository. Store this somewhere safe outside Looksee (a password manager) — it's write-only here and can never be shown again once saved, and losing it means losing access to every archive with no recovery." />
            </span>{" "}
            {settings.passphraseSet && <span className="text-[var(--muted)]">(already set — leave blank to keep it)</span>}
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
            />
          </label>
          <div className="flex gap-3">
            <label className="flex-1">
              <span className="inline-flex items-center">
                Schedule
                <Tooltip text={'Standard 5-field cron syntax: minute hour day-of-month month day-of-week. "0 3 * * *" means every day at 3am. Leave blank to only back up when you click "Back up now."'} />
              </span>{" "}
              (cron, blank = manual only)
              <input
                value={schedule}
                onChange={(e) => setSchedule(e.target.value)}
                placeholder="0 3 * * *"
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 font-mono text-xs outline-none"
              />
            </label>
            <label className="w-32">
              <span className="inline-flex items-center">
                Keep last N
                <Tooltip text="After each scheduled or manual backup, older archives beyond this count are pruned automatically. Leave blank for no automatic pruning — archives accumulate forever." />
              </span>
              <input
                type="number"
                min={1}
                value={retentionCount}
                onChange={(e) => setRetentionCount(e.target.value)}
                className="mt-1 w-full rounded-md border border-[var(--border)] bg-transparent px-2 py-1 outline-none"
              />
            </label>
          </div>
          {saveError && <p className="text-[var(--down)]">{saveError}</p>}
          {saved && <p className="text-[var(--up)]">Saved.</p>}
          <div className="flex items-center gap-3">
            <button type="submit" className="rounded-md bg-[var(--up)] px-3 py-1.5 font-medium text-black">
              Save settings
            </button>
            <span className="inline-flex items-center text-[var(--muted)]">
              <button type="button" onClick={handleShowSshKey} className="hover:text-[var(--text)]">
                Show SSH public key (for a remote repo)
              </button>
              <Tooltip text="A dedicated key generated just for backups. Copy it into the remote host's ~/.ssh/authorized_keys to authorize this engine to write backups there over SSH." />
            </span>
          </div>
          {sshKey && <pre className="overflow-x-auto rounded-md border border-[var(--border)] p-2 text-xs">{sshKey}</pre>}
        </form>
      </section>

      <section className="mb-6 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-medium">Archives</h2>
          <span className="inline-flex items-center">
            <button
              onClick={handleBackupNow}
              disabled={Boolean(currentOp) || !settings.repoUrl || !settings.passphraseSet}
              className="rounded-md border border-[var(--border)] px-3 py-1 text-sm disabled:opacity-40"
            >
              Back up now
            </button>
            {(!settings.repoUrl || !settings.passphraseSet) && (
              <Tooltip text="Set a repository and passphrase above first, then save settings — this button enables once both are configured." />
            )}
          </span>
        </div>
        {archives.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No archives yet.</p>
        ) : (
          <ul className="space-y-2">
            {archives.map((a) => (
              <li key={a.name} className="rounded-md border border-[var(--border)] p-2 text-sm">
                <div className="flex items-center justify-between">
                  <span>{a.name}</span>
                  <span className="text-xs text-[var(--muted)]">{new Date(a.time).toLocaleString()}</span>
                </div>
                <RestoreForm archive={a} onStarted={loadAll} />
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-4">
        <h2 className="mb-3 font-medium">Recent runs</h2>
        {runs.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No runs yet.</p>
        ) : (
          <ul className="space-y-1 text-xs">
            {runs.map((r) => (
              <li key={r.id} className="flex items-center gap-2">
                <span
                  className="h-1.5 w-1.5 rounded-full"
                  style={{
                    background: r.status === "success" ? "var(--up)" : r.status === "error" ? "var(--down)" : "var(--warn)",
                  }}
                />
                {/* Status text label alongside the dot — color is never the
                    only signal, per the dataviz skill's status-color rule. */}
                <span className="text-[var(--muted)]">{r.status.toUpperCase()}</span>
                <span className="font-mono">{r.kind}</span>
                <span>{r.archiveName}</span>
                <span className="text-[var(--muted)]">{new Date(r.startedAt).toLocaleString()}</span>
                {r.message && <span className="text-[var(--muted)]">— {r.message}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
