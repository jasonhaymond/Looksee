// Backups: Looksee's database and settings backed up with BorgBackup
// (encrypted, deduplicated). Shows whether Borg is available, the repository
// and schedule, recent runs and archives, with "Back up now" and restore.
//
// Restoring replaces the current database with the archive's: anything
// recorded since is lost. It needs the archive name typed again to confirm.
// The repository passphrase is write-only.

import { useCallback, useState } from "react";
import { Stack } from "expo-router";
import { api } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { dateTime, errorText } from "../../lib/format";
import { Button, ButtonRow, Card, Empty, ErrorBox, Field, KeyValue, Loading, Note, Row, Screen, StatusBadge, T, Toggle, tell } from "../../components/ui";
import { usePrompt } from "../../components/Prompt";

export default function Backups() {
  const [prompt, ask] = usePrompt();
  const load = useCallback(async () => {
    const [settings, status, runs, archives] = await Promise.all([api.backupSettings(), api.backupStatus(), api.backupRuns(), api.backupArchives().catch(() => ({ archives: [] }))]);
    return { ...settings, status, runs: runs.runs, archives: archives.archives };
  }, []);
  const { data, error, loading, refreshing, reload } = useLoad(load, 15);
  const [edit, setEdit] = useState<{ repoUrl: string; schedule: string; retentionCount: string; passphrase: string } | null>(null);
  const [restoreDb, setRestoreDb] = useState(true);
  const [restoreConfig, setRestoreConfig] = useState(false);

  /** Runs an action, reports errors, reloads. */
  const act = async (run: () => Promise<unknown>, done?: string) => {
    try {
      await run();
      if (done) tell(done);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  };

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const s = data.settings;
  const busy = data.status.currentOperation;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: "Backups" }} />
      <ErrorBox error={error} />
      {!data.borgAvailable ? <Note tone="warn">BorgBackup isn't installed on the server, so backups can't run. See the deployment guide.</Note> : null}
      <Card title="Settings">
        <KeyValue label="Repository" value={s.repoUrl ?? "not set"} mono />
        <KeyValue label="Schedule" value={s.schedule ?? "manual only"} mono />
        <KeyValue label="Keep" value={s.retentionCount ? `${s.retentionCount} archives` : "all"} />
        <KeyValue label="Passphrase" value={s.passphraseSet ? "saved" : "not set"} />
        {edit ? (
          <>
            <Field label="Repository URL" value={edit.repoUrl} onChangeText={(t) => setEdit({ ...edit, repoUrl: t })} autoCapitalize="none" placeholder="ssh://user@backup-host/./looksee" />
            <Field label="Schedule (cron, blank = manual)" value={edit.schedule} onChangeText={(t) => setEdit({ ...edit, schedule: t })} autoCapitalize="none" placeholder="30 2 * * *" />
            <Field label="Archives to keep" value={edit.retentionCount} onChangeText={(t) => setEdit({ ...edit, retentionCount: t })} keyboardType="number-pad" />
            <Field label="New passphrase (blank keeps the saved one)" value={edit.passphrase} onChangeText={(t) => setEdit({ ...edit, passphrase: t })} secureTextEntry />
            <ButtonRow>
              <Button small title="Cancel" onPress={() => setEdit(null)} />
              <Button small variant="primary" title="Save" onPress={() => act(async () => {
                await api.updateBackupSettings({ repoUrl: edit.repoUrl.trim(), schedule: edit.schedule.trim() || null, retentionCount: edit.retentionCount ? Number(edit.retentionCount) : null, ...(edit.passphrase ? { passphrase: edit.passphrase } : {}) });
                setEdit(null);
              })} />
            </ButtonRow>
          </>
        ) : (
          <ButtonRow>
            <Button small title="Edit" onPress={() => setEdit({ repoUrl: s.repoUrl ?? "", schedule: s.schedule ?? "", retentionCount: s.retentionCount ? String(s.retentionCount) : "", passphrase: "" })} />
            <Button small variant="primary" title={busy ? `${busy.kind} running…` : "Back up now"} disabled={Boolean(busy) || !data.borgAvailable} onPress={() => act(() => api.runBackup(), "Backup started")} />
          </ButtonRow>
        )}
      </Card>
      <Card title="Recent runs">
        {data.runs.length === 0 ? <Empty>No backups have run yet.</Empty> : data.runs.slice(0, 15).map((r) => (
          <Row key={r.id} left={<StatusBadge status={r.status === "success" ? "up" : r.status === "error" ? "down" : "warn"} small />} title={`${r.kind}: ${r.archiveName}`} subtitle={`${dateTime(r.startedAt)}${r.message ? ` · ${r.message}` : ""}`} />
        ))}
      </Card>
      <Card title="Archives">
        <T size="s" muted>Restoring replaces the current data with the archive's. Everything recorded since that archive is lost.</T>
        <Toggle label="Restore the database" value={restoreDb} onChange={setRestoreDb} />
        <Toggle label="Restore the settings files (.env)" value={restoreConfig} onChange={setRestoreConfig} />
        {data.archives.length === 0 ? <Empty>No archives.</Empty> : [...data.archives].reverse().map((a) => (
          <Row key={a.name} title={a.name} subtitle={dateTime(a.time)} right={<Button small variant="danger" title="Restore…" disabled={Boolean(busy) || (!restoreDb && !restoreConfig)} onPress={async () => {
            const typed = await ask({ title: "Restore this archive?", label: "Type the archive name to confirm", message: `${a.name}\n\nThe current ${[restoreDb ? "database" : null, restoreConfig ? "settings" : null].filter(Boolean).join(" and ")} will be replaced. This can't be undone.`, okLabel: "Restore" });
            if (typed === null) return;
            if (typed.trim() !== a.name) return tell("Not restored", "The name typed doesn't match the archive.");
            void act(() => api.restoreBackup({ archiveName: a.name, confirmArchiveName: typed.trim(), restoreDb, restoreConfig }), restoreConfig ? "Restore started. Restored settings files take effect after the app is restarted on the server; follow the run under Recent runs." : "Restore started; follow it under Recent runs.");
          }} />} />
        ))}
      </Card>
      {prompt}
    </Screen>
  );
}
