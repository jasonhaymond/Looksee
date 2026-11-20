// One check: its current status and message, what to look at while it's
// failing, uptime and response-time history (24 h / 7 d / 30 d), recent
// results, where it belongs, its alert rules (add, edit, pause, delete), what
// it ignores (exclusions), and actions: run now, pause/resume, mark
// recovered, maintenance, edit, duplicate, delete. Opened from lists and by
// tapping a notification (looksee://checks/<id>).

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, typeLabel, type AlertRule, type Channel } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { dateTime, errorText, minutes, relativeTime } from "../../../lib/format";
import { useTheme } from "../../../lib/theme";
import { Button, ButtonRow, Card, Chip, Chips, Empty, ErrorBox, KeyValue, Loading, Note, Row, Screen, StatusBadge, T, Toggle, confirm, tell } from "../../../components/ui";
import { Sparkline } from "../../../components/Sparkline";
import { usePrompt } from "../../../components/Prompt";
import { AlertRuleForm, emptyRule, rulePayload, type RuleValue } from "../../../components/AlertRuleForm";

const RANGES = [
  { hours: 24, label: "24 h" },
  { hours: 168, label: "7 d" },
  { hours: 720, label: "30 d" },
];

export default function CheckDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { colors } = useTheme();
  const [hours, setHours] = useState(24);
  const [prompt, ask] = usePrompt();
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    const check = await api.check(id);
    const [stats, results, rules, channels, exclusions, sites, endpoints] = await Promise.all([
      api.checkStats(id, hours),
      api.checkResults(id, 20),
      api.alertRules(id),
      api.channels(),
      api.checkExclusions(id).catch(() => []),
      api.sites(),
      api.endpoints(check.siteId),
    ]);
    return { check, stats, results, rules, channels, exclusions, site: sites.find((s) => s.id === check.siteId), endpoint: endpoints.find((e) => e.id === check.endpointId) };
  }, [id, hours]);
  const { data, error, loading, refreshing, reload, setData } = useLoad(load, 30);

  /** Runs an action, shows its error if it fails, then reloads. */
  async function act(label: string, run: () => Promise<unknown>, done?: string) {
    setBusy(label);
    try {
      await run();
      if (done) tell(done);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    } finally {
      setBusy(null);
    }
  }

  if (loading || !data) return loading ? <Loading /> : <Screen><ErrorBox error={error} /></Screen>;
  const { check, stats } = data;
  const failing = check.lastStatus === "down" || check.lastStatus === "warn";
  const series = stats.series.map((p) => (p.value != null ? p.value : p.latency));
  const seriesIsValue = stats.series.some((p) => p.value != null);

  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: check.name }} />
      <ErrorBox error={error} />
      <Card>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <StatusBadge status={check.enabled ? check.lastStatus : null} />
          <T muted size="s">{typeLabel(check.type)}</T>
          {!check.enabled ? <T size="s" color={colors.warn}>paused</T> : null}
          {check.inMaintenance ? <T size="s" color={colors.maint}>in maintenance</T> : null}
          {check.flapping ? <T size="s" color={colors.warn}>flapping (alerts held)</T> : null}
        </View>
        {check.lastMessage ? <T selectable>{check.lastMessage}</T> : null}
        <T size="s" muted>
          Checked {relativeTime(check.lastCheckedAt)} · every {check.intervalSeconds} s{check.lastStatusChangeAt ? ` · in this state since ${relativeTime(check.lastStatusChangeAt)}` : ""}
          {check.lastLatencyMs != null ? ` · ${check.lastLatencyMs} ms` : ""}
          {check.lastValue != null ? ` · value ${check.lastValue}` : ""}
        </T>
        {check.blockedBy ? <Note tone="warn">{`Alerts held: depends on "${check.blockedBy}", which is down.`}</Note> : null}
        {failing && check.remediation?.length ? (
          <View style={{ gap: 4 }}>
            <T bold size="s">Things to check</T>
            {check.remediation.map((r) => <T key={r} size="s">• {r}</T>)}
          </View>
        ) : null}
        <ButtonRow>
          <Button small icon="play" title="Run now" busy={busy === "run"} onPress={() => act("run", async () => {
            const r = await api.runCheck(check.id);
            if ("queued" in r) tell("Queued", r.message);
          })} />
          <Button small title={check.enabled ? "Pause" : "Resume"} busy={busy === "pause"} onPress={() => act("pause", () => api.updateCheck(check.id, { enabled: !check.enabled }))} />
          {failing ? (
            <Button small title="Mark recovered" onPress={async () => {
              const note = await ask({ title: "Mark recovered", label: "Note (optional)", message: "Records an UP result now. Event checks ignore events received before this." });
              if (note !== null) void act("resolve", () => api.resolveCheck(check.id, note || undefined));
            }} />
          ) : null}
          <Button small title="Maintenance…" onPress={async () => {
            const m = await ask({ title: "Maintenance", label: "Minutes", initial: "60", numeric: true, message: "No alerts for this check until it ends." });
            if (m) void act("maint", () => api.bulkChecks([check.id], "maintenance", { minutes: Number(m) }), "Maintenance started");
          }} />
          <Button small icon="create-outline" title="Edit" onPress={() => router.push({ pathname: "/checks/edit", params: { id: check.id } })} />
          <Button small title="Edit on several…" onPress={() => router.push({ pathname: "/checks/bulk-settings", params: { ids: check.id } })} />
          <Button small title="Duplicate" onPress={() => act("dup", () => api.bulkChecks([check.id], "duplicate"), "Duplicated: the copy is named \"(copy)\" and keeps the alert rules")} />
          <Button small variant="danger" title="Delete" onPress={() => confirm("Delete this check?", "Its history and alert rules are deleted too. This can't be undone.", () => void act("del", async () => {
            await api.deleteCheck(check.id);
            router.back();
          }))} />
        </ButtonRow>
      </Card>

      <Card title="History">
        <Chips>
          {RANGES.map((r) => <Chip key={r.hours} label={r.label} on={hours === r.hours} onPress={() => setHours(r.hours)} />)}
        </Chips>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 16 }}>
          <KeyValueSmall label="Uptime" value={stats.uptimePercent != null ? `${stats.uptimePercent.toFixed(2)}%` : "—"} />
          <KeyValueSmall label="Results" value={`${stats.up} up · ${stats.warn} warn · ${stats.down} down`} />
          {stats.latencyAvg != null ? <KeyValueSmall label="Response" value={`avg ${Math.round(stats.latencyAvg)} ms · p95 ${stats.latencyP95 != null ? Math.round(stats.latencyP95) : "—"} ms`} /> : null}
          {stats.valueAvg != null ? <KeyValueSmall label="Value" value={`avg ${Number(stats.valueAvg.toFixed(2))} (${stats.valueMin ?? "—"}–${stats.valueMax ?? "—"})`} /> : null}
        </View>
        <T size="s" muted>{seriesIsValue ? "Value" : "Response time"} over {RANGES.find((r) => r.hours === hours)?.label}</T>
        <Sparkline values={series} unit={seriesIsValue ? "" : " ms"} />
        {stats.incidents.length ? (
          <View>
            <T bold size="s">Incidents</T>
            {stats.incidents.slice(0, 10).map((i) => (
              <Row key={i.id} left={<StatusBadge status={i.resolvedAt ? "up" : i.severity} small />} title={i.message ?? i.severity} subtitle={`${dateTime(i.triggeredAt)}${i.resolvedAt ? `, lasted ${minutes((new Date(i.resolvedAt).getTime() - new Date(i.triggeredAt).getTime()) / 60_000)}` : " · still open"}`} />
            ))}
          </View>
        ) : null}
      </Card>

      <Card title="Recent results">
        {data.results.length === 0 ? <Empty>No results yet.</Empty> : data.results.map((r) => (
          <Row key={r.id} left={<StatusBadge status={r.status} small />} title={r.message ?? r.status} subtitle={[dateTime(r.checkedAt), r.latencyMs != null ? `${r.latencyMs} ms` : null, r.value != null ? `value ${r.value}` : null, r.inMaintenance ? "maintenance" : null, r.excluded ? "excluded from stats" : null].filter(Boolean).join(" · ")} />
        ))}
      </Card>

      <Card title="Where">
        <Row title={data.site?.name ?? "Site"} subtitle="Site" onPress={() => router.push(`/sites/${check.siteId}`)} />
        {data.endpoint ? <Row title={data.endpoint.name} subtitle="Endpoint" onPress={() => router.push(`/endpoints/${data.endpoint!.id}`)} /> : null}
        {check.tags.length ? <KeyValue label="Tags" value={check.tags.join(", ")} /> : null}
        {check.pushUrl ? (
          <View style={{ gap: 6 }}>
            <KeyValue label={check.type === "heartbeat" || check.type === "push_value" ? "Push URL" : "Recovery URL"} value={check.pushUrl} mono />
            <ButtonRow>
              <Button small title="Copy URL" onPress={() => void Clipboard.setStringAsync(check.pushUrl!)} />
              <Button small title="New URL" onPress={() => confirm("Make a new URL?", "The current URL stops working at once.", () => void act("token", () => api.regeneratePushToken(check.id)), "New URL")} />
            </ButtonRow>
          </View>
        ) : null}
      </Card>

      <AlertRules checkId={check.id} rules={data.rules} channels={data.channels} onChanged={reload} onChannels={(channels) => setData({ ...data, channels })} />

      {data.exclusions.length ? (
        <Card title={`Ignores (${data.exclusions.length})`}>
          {data.exclusions.slice(0, 50).map((x, i) => (
            <Row key={`${x.value}-${i}`} title={x.value} subtitle={x.source.type === "list" ? `From list "${x.source.name}"` : "This check's own setting"} />
          ))}
          <T size="s" muted>Change them with Edit (this check), Edit on several, or More → Exclusion lists.</T>
        </Card>
      ) : null}
      {prompt}
    </Screen>
  );
}

/** A small stacked label/value for the statistics row. */
function KeyValueSmall({ label, value }: { label: string; value: string }) {
  return (
    <View>
      <T size="s" muted>{label}</T>
      <T bold>{value}</T>
    </View>
  );
}

/**
 * The check's alert rules: each with who it notifies and when, an on/off
 * switch, edit and delete; and a form to add one.
 */
function AlertRules({ checkId, rules, channels, onChanged, onChannels }: { checkId: string; rules: AlertRule[]; channels: Channel[]; onChanged: () => void; onChannels: (c: Channel[]) => void }) {
  const [editing, setEditing] = useState<{ id: string | null; value: RuleValue } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const names = (ids: string[]) => ids.map((i) => channels.find((c) => c.id === i)?.name ?? "?").join(", ") || "no channel";

  /** Saves the rule being edited (new or existing). */
  async function save() {
    if (!editing) return;
    setError(null);
    const payload = rulePayload(editing.value);
    if (!payload.channelIds.length) return setError("Choose at least one channel to notify.");
    try {
      if (editing.id) await api.updateAlertRule(editing.id, payload);
      else await api.createAlertRule({ checkId, ...payload });
      setEditing(null);
      onChanged();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Card title="Alert rules" action={!editing ? <Button small icon="add" title="Add" onPress={() => setEditing({ id: null, value: emptyRule() })} /> : undefined}>
      {rules.length === 0 && !editing ? <Empty>No alert rules: this check notifies no one when it fails.</Empty> : null}
      {rules.map((r) => (
        <View key={r.id} style={{ gap: 4 }}>
          <Toggle
            label={`After ${r.consecutiveFailures} ${r.triggerOn === "warn" ? "warn/down" : "down"} in a row → ${names(r.channelIds)}`}
            help={[r.renotifyMinutes ? `reminds every ${r.renotifyMinutes} min` : null, r.escalateAfterMinutes ? `escalates after ${r.escalateAfterMinutes} min to ${names(r.escalationChannelIds)}` : null].filter(Boolean).join(" · ") || undefined}
            value={r.enabled}
            onChange={async (enabled) => {
              await api.updateAlertRule(r.id, { enabled }).catch((err) => tell("That didn't work", errorText(err)));
              onChanged();
            }}
          />
          <ButtonRow>
            <Button small title="Edit" onPress={() => setEditing({ id: r.id, value: { channelIds: r.channelIds, escalationChannelIds: r.escalationChannelIds, consecutiveFailures: String(r.consecutiveFailures), triggerOn: r.triggerOn, renotifyMinutes: r.renotifyMinutes ? String(r.renotifyMinutes) : "", escalateAfterMinutes: r.escalateAfterMinutes ? String(r.escalateAfterMinutes) : "" } })} />
            <Button small variant="danger" title="Delete" onPress={() => confirm("Delete this alert rule?", "The check stops notifying these channels.", async () => {
              await api.deleteAlertRule(r.id).catch((err) => tell("That didn't work", errorText(err)));
              onChanged();
            })} />
          </ButtonRow>
        </View>
      ))}
      {editing ? (
        <View style={{ gap: 10 }}>
          <T bold>{editing.id ? "Edit rule" : "New rule"}</T>
          <AlertRuleForm value={editing.value} onChange={(value) => setEditing({ ...editing, value })} channels={channels} onChannelCreated={(c) => onChannels([...channels, c])} />
          <ErrorBox error={error} />
          <ButtonRow>
            <Button title="Cancel" onPress={() => setEditing(null)} />
            <Button title="Save rule" variant="primary" onPress={save} />
          </ButtonRow>
        </View>
      ) : null}
    </Card>
  );
}
