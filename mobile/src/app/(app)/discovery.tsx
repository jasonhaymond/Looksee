// Network discovery: scan an address range (ping, common ports, SNMP), then
// tick the devices to add, each as an endpoint with the checks suggested for
// it, optionally with an alert rule. Scans only run when started here, and
// nothing is added without being ticked (Looksee's rule for discovery).

import { useCallback, useEffect, useState } from "react";
import { View } from "react-native";
import { Stack } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { api, type Channel, type DiscoveryScan } from "../../lib/shared";
import { useLoad } from "../../lib/useLoad";
import { dateTime, errorText } from "../../lib/format";
import { useTheme } from "../../lib/theme";
import { Button, ButtonRow, Card, Empty, ErrorBox, Field, Loading, Row, Screen, Select, T, tell } from "../../components/ui";
import { AlertRuleForm, emptyRule, rulePayload } from "../../components/AlertRuleForm";

export default function Discovery() {
  const { colors } = useTheme();
  const load = useCallback(async () => {
    const [scans, sites, channels] = await Promise.all([api.discoveryScans(), api.sites(), api.channels()]);
    return { scans, sites, channels };
  }, []);
  const { data, error, loading, reload } = useLoad(load);
  const [cidr, setCidr] = useState("");
  const [community, setCommunity] = useState("");
  const [siteId, setSiteId] = useState("");
  const [scan, setScan] = useState<DiscoveryScan | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [rule, setRule] = useState(emptyRule());
  const [extraChannels, setExtra] = useState<Channel[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // While a scan runs, re-reads it every 3 seconds until it's done.
  useEffect(() => {
    if (!scan || scan.status === "done" || scan.status === "error") return undefined;
    const timer = setInterval(() => {
      api.discoveryScan(scan.id).then(setScan).catch(() => undefined);
    }, 3000);
    return () => clearInterval(timer);
  }, [scan]);

  async function start() {
    setErr(null);
    try {
      setPicked([]);
      setScan(await api.startDiscovery(cidr.trim(), community.trim() || undefined, siteId || undefined));
      void reload();
    } catch (e) {
      setErr(errorText(e));
    }
  }

  /** Adds the ticked devices (new ones as endpoints) with their suggested checks. */
  async function add() {
    if (!scan) return;
    const target = siteId || scan.siteId || data?.sites[0]?.id;
    if (!target) return setErr("Choose the site to add them to.");
    setBusy(true);
    setErr(null);
    const payload = rulePayload(rule);
    try {
      const devices = scan.results.filter((d) => picked.includes(d.ip)).map((d) => ({ ip: d.ip, name: d.snmp?.sysName || d.hostname || d.ip, mac: d.mac, createEndpoint: !d.knownEndpointId, checks: d.suggestedChecks }));
      const r = await api.addDiscovered(scan.id, { siteId: target, alertRule: payload.channelIds.length ? payload : null, devices });
      tell("Added", `${r.endpointsCreated} endpoint(s) and ${r.checksCreated} check(s).`);
      setPicked([]);
    } catch (e) {
      setErr(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <Loading />;
  const running = scan && (scan.status === "queued" || scan.status === "running");
  return (
    <Screen>
      <Stack.Screen options={{ title: "Discovery" }} />
      <ErrorBox error={error} />
      <Card title="Scan a network">
        <Field label="Address range" value={cidr} onChangeText={setCidr} autoCapitalize="none" placeholder="192.168.1.0/24" help="Up to a /22 (1024 addresses)." />
        <Field label="SNMP community (optional)" value={community} onChangeText={setCommunity} autoCapitalize="none" placeholder="public" />
        <Select label="Site" value={siteId} onChange={setSiteId} options={[{ value: "", label: "Scan from the Looksee server" }, ...(data?.sites ?? []).map((s) => ({ value: s.id, label: s.name }))]} help="A site with a collector scans from inside that network." />
        <ErrorBox error={err} />
        <Button variant="primary" title={running ? "Scanning…" : "Start scan"} busy={Boolean(running)} disabled={!cidr.trim()} onPress={start} />
      </Card>
      {scan ? (
        <Card title={`${scan.cidr}: ${scan.status}`}>
          {scan.error ? <ErrorBox error={scan.error} /> : null}
          {scan.status === "done" && scan.results.length === 0 ? <Empty>Nothing answered.</Empty> : null}
          {scan.results.map((d) => (
            <Row
              key={d.ip}
              selected={picked.includes(d.ip)}
              left={<Ionicons name={picked.includes(d.ip) ? "checkbox" : "square-outline"} size={22} color={picked.includes(d.ip) ? colors.accent : colors.muted} />}
              title={`${d.snmp?.sysName || d.hostname || d.ip}${d.knownEndpointId ? " (already an endpoint)" : ""}`}
              subtitle={[d.ip, d.mac, d.openPorts.map((p) => p.service || p.port).join(", "), `${d.suggestedChecks.length} suggested check(s)`].filter(Boolean).join(" · ")}
              right={<View />}
              onPress={() => setPicked((p) => (p.includes(d.ip) ? p.filter((x) => x !== d.ip) : [...p, d.ip]))}
            />
          ))}
          {scan.status === "done" && scan.results.length ? (
            <>
              <T bold>Alert rule for the new checks (optional)</T>
              <AlertRuleForm value={rule} onChange={setRule} channels={[...(data?.channels ?? []), ...extraChannels]} onChannelCreated={(c) => setExtra((x) => [...x, c])} />
              <ButtonRow>
                <Button title={`Select all ${scan.results.length}`} onPress={() => setPicked(scan.results.map((d) => d.ip))} />
                <Button variant="primary" title={`Add ${picked.length}`} disabled={!picked.length} busy={busy} onPress={add} />
              </ButtonRow>
            </>
          ) : null}
        </Card>
      ) : null}
      {data?.scans.length ? (
        <Card title="Earlier scans">
          {data.scans.slice(0, 10).map((s) => <Row key={s.id} title={s.cidr} subtitle={`${s.status} · ${dateTime(s.startedAt)} · ${s.results.length} device(s)`} onPress={() => { setScan(s); setPicked([]); }} />)}
        </Card>
      ) : null}
    </Screen>
  );
}
