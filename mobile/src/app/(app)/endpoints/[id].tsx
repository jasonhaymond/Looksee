// One endpoint (a device): its details and agent status, the latest health
// snapshot from its agent (CPU, memory, disks, updates, temperatures…), its
// checks, and actions: add a check, suggested checks, edit, install/reinstall
// the agent, update the agent, Wake-on-LAN, maintenance, pause/resume its
// checks, watchdog settings, delete.
//
// Security: the agent key is shown only right after it's issued (it can't be
// read back later), and issuing a new one stops the old key working.

import { useCallback, useState } from "react";
import { View } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { api, type Channel, type EndpointDetail } from "../../../lib/shared";
import { useLoad } from "../../../lib/useLoad";
import { bytes, errorText, relativeTime } from "../../../lib/format";
import { useTheme } from "../../../lib/theme";
import { Button, ButtonRow, Card, Chip, Chips, Empty, ErrorBox, Field, KeyValue, Loading, Note, Screen, T, Toggle, confirm, tell } from "../../../components/ui";
import { CheckRow } from "../../../components/CheckRow";
import { usePrompt } from "../../../components/Prompt";

export default function EndpointScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [prompt, ask] = usePrompt();
  const [install, setInstall] = useState<{ key: string; commands: Record<string, string> } | null>(null);
  const load = useCallback(async () => {
    const endpoint = await api.endpoint(id);
    const [checks, sites, channels] = await Promise.all([api.checks(endpoint.siteId), api.sites(), api.channels()]);
    return { endpoint, checks: checks.filter((c) => c.endpointId === id), site: sites.find((s) => s.id === endpoint.siteId), channels };
  }, [id]);
  const { data, error, loading, refreshing, reload } = useLoad(load, 30);

  /** Runs an action, shows a message or error, and reloads. */
  async function act(run: () => Promise<unknown>, done?: string) {
    try {
      await run();
      if (done) tell(done);
      await reload();
    } catch (err) {
      tell("That didn't work", errorText(err));
    }
  }

  if (loading) return <Loading />;
  if (!data) return <Screen><ErrorBox error={error} /></Screen>;
  const e = data.endpoint;
  return (
    <Screen refreshing={refreshing} onRefresh={reload}>
      <Stack.Screen options={{ title: e.name }} />
      <ErrorBox error={error} />
      <Card>
        <KeyValue label="Site" value={data.site?.name ?? "—"} />
        {e.hostname ? <KeyValue label="Address" value={e.hostname} mono /> : null}
        {e.os ? <KeyValue label="OS" value={e.os} /> : null}
        <KeyValue label="Agent" value={e.agentVersion ? `v${e.agentVersion}, last report ${relativeTime(e.lastSeenAt)}` : e.hasAgentKey ? "key issued, not reporting yet" : "none"} />
        {e.lastAgentIp ? <KeyValue label="Agent IP" value={e.lastAgentIp} mono /> : null}
        {e.macAddress ? <KeyValue label="MAC" value={e.macAddress} mono /> : null}
        {e.tags.length ? <KeyValue label="Tags" value={e.tags.join(", ")} /> : null}
        {e.lastReportError ? <Note tone="warn">{`Last report problem (${relativeTime(e.lastReportErrorAt)}): ${e.lastReportError}`}</Note> : null}
        {e.collectorError ? <Note tone="warn">{`Collector: ${e.collectorError}`}</Note> : null}
        <ButtonRow>
          <Button small icon="add" title="Check" onPress={() => router.push({ pathname: "/checks/new", params: { endpointId: id, siteId: e.siteId } })} />
          <Button small title="Suggested checks" onPress={() => router.push({ pathname: "/suggestions", params: { endpointId: id } })} />
          <Button small icon="create-outline" title="Edit" onPress={() => router.push({ pathname: "/endpoints/edit", params: { id } })} />
          <Button small title={e.hasAgentKey ? "Reinstall agent…" : "Install agent…"} onPress={() => confirm(e.hasAgentKey ? "Issue a new agent key?" : "Install the agent?", e.hasAgentKey ? "The current key stops working at once; the installed agent must be reinstalled with the new command." : "Creates this endpoint's agent key and shows the install commands.", () => void act(async () => {
            const r = await api.issueAgentKey(id);
            setInstall({ key: r.agentApiKey, commands: r.installCommands as Record<string, string> });
          }), "Continue")} />
          {e.agentVersion ? <Button small title="Update agent" onPress={() => act(() => api.requestEndpointUpdate(id), "Update requested: the agent updates at its next check-in.")} /> : null}
          {e.macAddress ? <Button small title="Wake (WoL)" onPress={() => act(() => api.wakeEndpoint(id), "Wake-on-LAN packet sent.")} /> : null}
          <Button small title="Maintenance…" onPress={async () => {
            const m = await ask({ title: `Maintenance: ${e.name}`, label: "Minutes", initial: "60", numeric: true });
            if (m) void act(() => api.bulkEndpoints([id], "maintenance", { minutes: Number(m) }), "Maintenance started");
          }} />
          <Button small title="Pause checks" onPress={() => act(() => api.bulkEndpoints([id], "disable_checks"), "Paused")} />
          <Button small title="Resume checks" onPress={() => act(() => api.bulkEndpoints([id], "enable_checks"), "Resumed")} />
          <Button small variant="danger" title="Delete" onPress={() => confirm(`Delete ${e.name}?`, "Its checks and their history are deleted too. This can't be undone.", () => void act(async () => {
            await api.deleteEndpoint(id);
            router.back();
          }))} />
        </ButtonRow>
      </Card>

      {install ? (
        <Card title="Install the agent">
          <Note tone="warn">The key is shown only now. Copy the command for the device's system and run it there as an administrator.</Note>
          {Object.entries(install.commands).map(([os, cmd]) => (
            <View key={os} style={{ gap: 4 }}>
              <T bold>{os === "unix" ? "Linux / macOS" : os === "windows" ? "Windows (PowerShell as admin)" : os === "android" ? "Android (Termux)" : os}</T>
              <T selectable style={{ fontFamily: "monospace", fontSize: 12 }}>{cmd}</T>
              <Button small title="Copy" onPress={() => void Clipboard.setStringAsync(cmd)} />
            </View>
          ))}
          <Button small title="Done" onPress={() => setInstall(null)} />
        </Card>
      ) : null}

      <Snapshot endpoint={e} />

      <Card title={`Checks (${data.checks.length})`}>
        {data.checks.length === 0 ? <Empty>No checks on this endpoint.</Empty> : [...data.checks].sort((a, b) => a.name.localeCompare(b.name)).map((c) => <CheckRow key={c.id} check={c} />)}
      </Card>

      {e.agentVersion ? <Watchdog endpoint={e} channels={data.channels} onSaved={reload} /> : null}
      {prompt}
    </Screen>
  );
}

/** The agent's latest health snapshot, in short. */
function Snapshot({ endpoint }: { endpoint: EndpointDetail }) {
  const { colors } = useTheme();
  const s = endpoint.lastSnapshot;
  if (!s) return null;
  const pct = (n: number | undefined) => (n == null ? "—" : `${n.toFixed(0)}%`);
  return (
    <Card title="Health (latest agent report)">
      <KeyValue label="CPU" value={pct(s.cpu?.percent)} />
      {s.mem ? <KeyValue label="Memory" value={`${pct(s.mem.percent)} of ${bytes(s.mem.total)}${s.mem.swapTotal ? ` · swap ${pct(s.mem.swapPercent)}` : ""}`} /> : null}
      {s.uptimeSeconds != null ? <KeyValue label="Up for" value={`${(s.uptimeSeconds / 86_400).toFixed(1)} days`} /> : null}
      {s.updates ? <KeyValue label="Updates" value={`${s.updates.total} pending${s.updates.security ? `, ${s.updates.security} security` : ""}${s.pendingReboot ? " · reboot pending" : ""}`} /> : null}
      {s.disks?.length ? (
        <View style={{ gap: 2 }}>
          <T size="s" muted>Disks</T>
          {s.disks.map((d) => (
            <T key={d.mount} size="s" color={d.percent >= 90 ? colors.down : d.percent >= 80 ? colors.warn : colors.text}>
              {d.mount}: {d.percent.toFixed(0)}% used, {bytes(d.free)} free of {bytes(d.total)}{d.readOnly ? " (read-only)" : ""}
            </T>
          ))}
        </View>
      ) : null}
      {s.temps?.length ? <KeyValue label="Temperatures" value={s.temps.slice(0, 6).map((t) => `${t.sensor} ${t.celsius}°C`).join(", ")} /> : null}
      {s.smart?.some((d) => d.passed === false) ? <Note tone="warn">{`Disk health: ${s.smart.filter((d) => d.passed === false).map((d) => d.device).join(", ")} failing SMART`}</Note> : null}
      {s.firewall ? <KeyValue label="Firewall" value={s.firewall.enabled ? "on" : "OFF"} /> : null}
      {s.users ? <KeyValue label="Signed-in users" value={s.users.sessions.map((u) => u.user).join(", ") || "none"} /> : null}
    </Card>
  );
}

/**
 * Watchdog agent settings: this endpoint's agent alerts (by email and/or chat
 * channels) when it can't reach the Looksee server. Alerts go out from the
 * agent itself, so only channels the agent can send to are offered (not the
 * Android app, which needs the server).
 */
function Watchdog({ endpoint, channels, onSaved }: { endpoint: EndpointDetail; channels: Channel[]; onSaved: () => void }) {
  const w = endpoint.watchdog;
  const [enabled, setEnabled] = useState(w?.enabled ?? false);
  const [after, setAfter] = useState(String(w?.afterMinutes ?? 5));
  const [emailTo, setEmailTo] = useState((w?.emailTo ?? []).join(", "));
  const [ids, setIds] = useState<string[]>(w?.channelIds ?? []);
  const [error, setError] = useState<string | null>(null);
  const usable = channels.filter((c) => ["webhook", "slack", "teams", "telegram"].includes(c.type));

  async function save() {
    setError(null);
    try {
      await api.setWatchdog(endpoint.id, { enabled, afterMinutes: Number(after) || 5, emailTo, channelIds: ids });
      tell("Watchdog settings saved");
      onSaved();
    } catch (err) {
      setError(errorText(err));
    }
  }

  return (
    <Card title="Watchdog">
      <Toggle label="Alert if this agent can't reach Looksee" help="The agent itself sends the alert, so it works while the Looksee server is down." value={enabled} onChange={setEnabled} />
      {enabled ? (
        <>
          <Field label="After (minutes)" value={after} onChangeText={setAfter} keyboardType="number-pad" />
          <Field label="Email to" value={emailTo} onChangeText={setEmailTo} autoCapitalize="none" keyboardType="email-address" placeholder="ops@example.com" />
          <T size="s" muted>Also post to</T>
          <Chips>
            {usable.map((c) => <Chip key={c.id} label={c.name} on={ids.includes(c.id)} onPress={() => setIds((x) => (x.includes(c.id) ? x.filter((y) => y !== c.id) : [...x, c.id]))} />)}
          </Chips>
          {endpoint.watchdogStatus?.lastError ? <Note tone="warn">{`Last delivery problem: ${endpoint.watchdogStatus.lastError}`}</Note> : null}
        </>
      ) : null}
      <ErrorBox error={error} />
      <ButtonRow>
        <Button small variant="primary" title="Save" onPress={save} />
        {enabled ? <Button small title="Send a test" onPress={() => void api.testWatchdogAgent(endpoint.id).then(() => tell("Test requested", "The agent sends it at its next check-in.")).catch((err) => tell("That didn't work", errorText(err)))} /> : null}
      </ButtonRow>
    </Card>
  );
}
