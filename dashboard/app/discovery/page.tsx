"use client";

import { useEffect, useState } from "react";
import { api, type DiscoveryScan, type Endpoint } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { Button, Checkbox, EmptyState, Label, inputClass, relativeTime, useToast } from "../components/ui";
import { usePageAuth } from "../components/usePageAuth";

// Per device: create a host? which suggested checks (by index)?
type Pick = { host: boolean; checks: Set<number> };

export default function DiscoveryPage() {
  const authed = usePageAuth();
  const [cidr, setCidr] = useState("192.168.1.0/24");
  const [community, setCommunity] = useState("public");
  const [scan, setScan] = useState<DiscoveryScan | null>(null);
  const [history, setHistory] = useState<DiscoveryScan[]>([]);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [endpointId, setEndpointId] = useState("");
  const [picks, setPicks] = useState<Record<string, Pick>>({});
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  useEffect(() => {
    if (!authed) return;
    api.endpoints().then((e) => {
      setEndpoints(e);
      setEndpointId((cur) => cur || e[0]?.id || "");
    });
    api.discoveryScans().then((list) => {
      setHistory(list);
      if (list[0]) setScan(list[0]);
    });
  }, [authed]);

  // Poll while the scan runs; results stream in as devices are found.
  useEffect(() => {
    if (!scan || scan.status !== "running") return;
    const t = setInterval(async () => setScan(await api.discoveryScan(scan.id)), 1500);
    return () => clearInterval(t);
  }, [scan]);

  // New devices default to: host on, first suggested check (reachability) on.
  useEffect(() => {
    if (!scan) return;
    setPicks((prev) => {
      const next = { ...prev };
      for (const d of scan.results) if (!next[d.ip]) next[d.ip] = { host: !d.knownHostId, checks: new Set(d.knownHostId ? [] : [0]) };
      return next;
    });
  }, [scan]);

  const devices = scan?.results ?? [];
  const chosen = devices.filter((d) => picks[d.ip]?.host || picks[d.ip]?.checks.size);
  const toggleCheck = (ip: string, i: number) =>
    setPicks((p) => {
      const cur = p[ip] ?? { host: false, checks: new Set<number>() };
      const checks = new Set(cur.checks);
      if (checks.has(i)) checks.delete(i);
      else checks.add(i);
      return { ...p, [ip]: { ...cur, checks } };
    });

  if (!authed) return null;
  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <TopNav active="/discovery" />
      <h2 className="mb-3 text-lg font-medium">Network discovery</h2>
      <PageHelp anchor="discovery">Sweeps a subnet (ping plus a few common ports — many devices ignore ping), then looks up names, MAC addresses and SNMP info. Tick what you want and add it in one go. Scans run from the engine, so it only sees networks the engine can reach.</PageHelp>

      <form
        className="mb-4 flex flex-wrap items-end gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            const s = await api.startDiscovery(cidr, community);
            setScan(s);
            setPicks({});
            setHistory((h) => [s, ...h]);
          } catch (err) {
            setError(err instanceof Error ? err.message : "Couldn't start the scan");
          }
        }}
      >
        <Label label="Subnet (up to /22)">
          <input value={cidr} onChange={(e) => setCidr(e.target.value)} className={`${inputClass} w-48`} />
        </Label>
        <Label label="SNMP community" help="Used to read device names/descriptions. Leave as 'public' if unsure.">
          <input value={community} onChange={(e) => setCommunity(e.target.value)} className={`${inputClass} w-32`} />
        </Label>
        <Button variant="primary" type="submit" disabled={scan?.status === "running"}>
          {scan?.status === "running" ? "Scanning…" : "Scan"}
        </Button>
        {history.length > 1 && (
          <select value={scan?.id ?? ""} onChange={(e) => api.discoveryScan(e.target.value).then(setScan)} className={`${inputClass} w-auto`} aria-label="Previous scans">
            {history.map((h) => (
              <option key={h.id} value={h.id}>
                {h.cidr} — {relativeTime(h.startedAt)}
              </option>
            ))}
          </select>
        )}
        {error && <p className="w-full text-sm text-[var(--down)]">{error}</p>}
      </form>

      {!scan ? (
        <EmptyState>Enter a subnet and press Scan.</EmptyState>
      ) : (
        <>
          <p className="mb-2 text-sm text-[var(--muted)]">
            {scan.status === "running" ? `Scanning ${scan.cidr}… ${devices.length} found so far.` : scan.status === "error" ? `Scan failed: ${scan.error}` : `${devices.length} device(s) found in ${scan.cidr}.`}
          </p>
          {devices.length > 0 && (
            <div className="space-y-2">
              {devices.map((d) => {
                const p = picks[d.ip] ?? { host: false, checks: new Set<number>() };
                return (
                  <div key={d.ip} className="rounded-xl border border-[var(--border)] bg-[var(--panel)]/40 p-3 text-sm">
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="font-mono font-medium">{d.ip}</span>
                      <span>{d.hostname ?? d.snmp?.sysName ?? ""}</span>
                      {d.mac && <span className="font-mono text-xs text-[var(--muted)]">{d.mac}</span>}
                      <span className="text-xs text-[var(--muted)]">
                        {d.pingable ? "answers ping" : "no ping"}
                        {d.openPorts.length ? ` · ${d.openPorts.map((o) => o.service).join(", ")}` : ""}
                      </span>
                      {d.knownHostId && <span className="rounded bg-[var(--border)] px-1.5 py-0.5 text-[10px]">already a host</span>}
                    </div>
                    {d.snmp?.sysDescr && <p className="mt-1 truncate text-xs text-[var(--muted)]">{d.snmp.sysDescr}</p>}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
                      <label className="flex items-center gap-1.5">
                        <Checkbox checked={p.host} onChange={(v) => setPicks((x) => ({ ...x, [d.ip]: { ...p, host: v } }))} label={`Create host for ${d.ip}`} />
                        Create host
                      </label>
                      {d.suggestedChecks.map((c, i) => (
                        <label key={i} className="flex items-center gap-1.5">
                          <Checkbox checked={p.checks.has(i)} onChange={() => toggleCheck(d.ip, i)} label={c.name} />
                          {typeLabel(c.type)}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {scan.status === "done" && devices.length > 0 && (
            <div className="sticky bottom-3 mt-4 flex flex-wrap items-center gap-3 rounded-xl border border-[var(--up)]/50 bg-[var(--panel)] p-2 shadow-2xl">
              <span className="px-2 text-sm">{chosen.length} device(s) selected</span>
              <label className="flex items-center gap-2 text-sm">
                into
                <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className="rounded-md border border-[var(--border)] bg-transparent px-2 py-1">
                  {endpoints.map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.name}
                    </option>
                  ))}
                </select>
              </label>
              <Button
                variant="primary"
                disabled={!chosen.length || !endpointId}
                onClick={async () => {
                  const res = await api.addDiscovered(scan.id, {
                    endpointId,
                    devices: chosen.map((d) => ({ ip: d.ip, name: d.hostname ?? d.snmp?.sysName ?? d.ip, mac: d.mac, createHost: picks[d.ip].host, checks: d.suggestedChecks.filter((_, i) => picks[d.ip].checks.has(i)) })),
                  });
                  toast.show(`Added ${res.hostsCreated} host(s) and ${res.checksCreated} check(s).`);
                  setPicks({});
                }}
              >
                Add selected
              </Button>
              <Button variant="ghost" onClick={() => setPicks(Object.fromEntries(devices.map((d) => [d.ip, { host: false, checks: new Set<number>() }])))}>
                Select none
              </Button>
            </div>
          )}
        </>
      )}
      {toast.node}
    </main>
  );
}
