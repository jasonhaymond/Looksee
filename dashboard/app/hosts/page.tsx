"use client";

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { api, ApiError, type AddressRow, type Channel, type Check, type Endpoint, type Host, type HostDetail, type HostInventory, type Location, type Suggestion } from "../lib/api";
import { typeLabel } from "../lib/checkTypes";
import { TopNav } from "../components/TopNav";
import { PageHelp } from "../components/PageHelp";
import { AlertOptions, BulkBar, Button, Checkbox, ConfirmDialog, EmptyState, FilterChip, Label, Modal, PromptDialog, StatusBadge, Tags, alertRulePayload, emptyAlertOptions, formatBytes, inputClass, relativeTime, useSelection, useToast, type BulkAction } from "../components/ui";
import { displayStatus } from "../components/CheckDetail";
import { collectorState } from "../components/collector";

// An agent that hasn't reported for 3 report intervals (90s by default) is
// considered offline here; the agent_heartbeat check is the alerting version.
const ONLINE_WINDOW_MS = 120_000;

function hostState(h: Host): "online" | "offline" | "no agent" {
  if (!h.lastSeenAt) return "no agent";
  return Date.now() - new Date(h.lastSeenAt).getTime() < ONLINE_WINDOW_MS ? "online" : "offline";
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      }}
      className="rounded border border-[var(--border)] px-2 py-0.5 text-[10px] text-[var(--muted)] hover:text-[var(--text)]"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

function Bar({ percent }: { percent: number }) {
  const color = percent >= 90 ? "var(--down)" : percent >= 80 ? "var(--warn)" : "var(--up)";
  return (
    <span className="inline-block h-1.5 w-20 rounded bg-[var(--border)] align-middle">
      <span className="block h-1.5 rounded" style={{ width: `${Math.min(100, percent)}%`, background: color }} />
    </span>
  );
}

function Overview({ detail }: { detail: HostDetail }) {
  const s = detail.lastSnapshot;
  if (!s) return <p className="text-sm text-[var(--muted)]">No 3.x agent report yet. Install or update the agent (Agent tab) to see live detail here.</p>;
  const yes = (v: boolean | undefined | null, good = true) => (v == null ? "—" : v === good ? "yes" : <span className="text-[var(--down)]">{v ? "yes" : "no"}</span>);
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <div className="text-xs text-[var(--muted)]">CPU</div>
          {s.cpu?.percent != null ? `${s.cpu.percent.toFixed(0)}%` : "—"} {s.cpu?.percent != null && <Bar percent={s.cpu.percent} />}
        </div>
        <div>
          <div className="text-xs text-[var(--muted)]">Memory</div>
          {s.mem ? `${s.mem.percent.toFixed(0)}% of ${formatBytes(s.mem.total)}` : "—"}
        </div>
        <div>
          <div className="text-xs text-[var(--muted)]">Load (5m / core)</div>
          {s.load ? (s.load.l5 / (s.load.cores || 1)).toFixed(2) : "—"}
        </div>
        <div>
          <div className="text-xs text-[var(--muted)]">Uptime</div>
          {s.uptimeSeconds != null ? `${(s.uptimeSeconds / 86400).toFixed(1)} days` : "—"}
        </div>
      </div>

      {s.disks && s.disks.length > 0 && (
        <div className="overflow-x-auto">
          <div className="mb-1 text-xs text-[var(--muted)]">Filesystems</div>
          <table className="w-full whitespace-nowrap text-xs">
            <tbody>
              {s.disks.map((d) => (
                <tr key={d.mount} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2 font-mono">{d.mount}</td>
                  <td className="pr-2 text-[var(--muted)]">{d.fstype}</td>
                  <td className="pr-2">
                    <Bar percent={d.percent} /> {d.percent.toFixed(0)}%
                  </td>
                  <td className="pr-2">{formatBytes(d.free)} free</td>
                  <td className="text-[var(--down)]">{d.stale ? "stale" : d.readOnly ? "read-only" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {s.net && s.net.length > 0 && (
        <div className="overflow-x-auto">
          <div className="mb-1 text-xs text-[var(--muted)]">Interfaces</div>
          <table className="w-full whitespace-nowrap text-xs">
            <thead className="text-left text-[var(--muted)]">
              <tr>
                <th className="py-1 pr-2 font-normal">Name</th>
                <th className="pr-2 font-normal">Link</th>
                <th className="pr-2 font-normal">Speed</th>
                <th className="pr-2 font-normal">Traffic</th>
                <th className="pr-2 font-normal">MAC</th>
                <th className="font-normal">Addresses</th>
              </tr>
            </thead>
            <tbody>
              {s.net.map((n) => (
                <tr key={n.name} className="border-t border-[var(--border)]">
                  <td className="py-1 pr-2">{n.name}</td>
                  <td className="pr-2">{n.up ? "up" : <span className="text-[var(--down)]">down</span>}</td>
                  <td className="pr-2 text-[var(--muted)]">{n.speedMbps ? `${n.speedMbps} Mbps` : ""}</td>
                  <td className="pr-2">
                    ↓ {((n.rxBytesPerSec * 8) / 1e6).toFixed(2)} ↑ {((n.txBytesPerSec * 8) / 1e6).toFixed(2)} Mbps
                  </td>
                  <td className="pr-2 font-mono text-[var(--muted)]">{n.mac || "—"}</td>
                  <td className="truncate text-[var(--muted)]">{(n.addrs ?? []).slice(0, 3).join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-3">
        <span>Firewall on: {yes(s.firewall?.enabled)}</span>
        <span>Disk encrypted: {yes(s.encryption?.enabled)}</span>
        <span>Reboot pending: {yes(s.pendingReboot, false)}</span>
        <span>Clock synced: {yes(s.time?.synced)}</span>
        <span>Clock offset: {s.time?.offsetMs != null ? `${Math.round(s.time.offsetMs)} ms` : "—"}</span>
        <span>
          Updates: {s.updates ? `${s.updates.total} (${s.updates.security} security)` : "—"}
        </span>
        {s.defender && <span>Defender real-time: {yes(s.defender.realtime)}</span>}
        <span>Sessions: {s.users?.count ?? "—"}</span>
        <span>Listening ports: {s.listening?.length ?? "—"}</span>
      </div>

      {(s.smart?.length || s.raid?.length || s.temps?.length) ? (
        <div className="grid grid-cols-1 gap-3 text-xs sm:grid-cols-3">
          {s.smart?.length ? (
            <div>
              <div className="mb-1 text-[var(--muted)]">Drives (SMART)</div>
              {s.smart.map((d) => (
                <div key={d.device}>
                  {d.device} {d.model ? `— ${d.model}` : ""}: {d.passed === false ? <span className="text-[var(--down)]">FAILING</span> : "OK"}
                  {d.wearPercent != null ? `, ${d.wearPercent}% worn` : ""}
                  {d.tempC != null ? `, ${d.tempC}°C` : ""}
                </div>
              ))}
            </div>
          ) : null}
          {s.raid?.length ? (
            <div>
              <div className="mb-1 text-[var(--muted)]">RAID / pools</div>
              {s.raid.map((r) => (
                <div key={r.name}>
                  {r.name} ({r.kind}): {r.healthy ? "healthy" : <span className="text-[var(--down)]">{r.state ?? "degraded"}</span>}
                </div>
              ))}
            </div>
          ) : null}
          {s.temps?.length ? (
            <div>
              <div className="mb-1 text-[var(--muted)]">Temperatures</div>
              {s.temps.slice(0, 6).map((t) => (
                <div key={t.sensor}>
                  {t.sensor}: {t.celsius}°C
                </div>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {detail.inventory && (
        <details className="text-xs">
          <summary className="cursor-pointer text-[var(--muted)]">Inventory</summary>
          <dl className="mt-1 grid grid-cols-[auto_1fr] gap-x-3">
            {Object.entries(detail.inventory).map(([k, v]) => (
              <Fragment key={k}>
                <dt className="text-[var(--muted)]">{k}</dt>
                <dd>{String(v)}</dd>
              </Fragment>
            ))}
          </dl>
        </details>
      )}
    </div>
  );
}

function SuggestionsTab({ host, channels, onApplied }: { host: Host; channels: Channel[]; onApplied: () => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState(emptyAlertOptions());
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => {
    api.hostSuggestions(host.id).then((s) => {
      setSuggestions(s);
      setPicked(new Set(s.map((x) => x.key)));
    });
  }, [host.id]);
  useEffect(load, [load]);
  if (!suggestions) return null;
  if (!suggestions.length) return <p className="text-sm text-[var(--muted)]">{host.hasSnapshot ? "Nothing more to suggest — this host already has every recommended check." : "Suggestions appear once a 3.x agent has reported in."}</p>;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-[var(--muted)]">Based on what the agent found on this host — its services, processes, containers, listening ports and logs. Untick anything you don&apos;t want; thresholds can be changed afterwards.</p>
      <div className="max-h-96 space-y-3 overflow-y-auto">
        {[...new Set(suggestions.map((s) => s.group ?? "Other"))].map((g) => {
          const inGroup = suggestions.filter((s) => (s.group ?? "Other") === g);
          const all = inGroup.every((s) => picked.has(s.key));
          return (
            <div key={g}>
              <label className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={() =>
                    setPicked((p) => {
                      const n = new Set(p);
                      for (const s of inGroup) {
                        if (all) n.delete(s.key);
                        else n.add(s.key);
                      }
                      return n;
                    })
                  }
                  className="accent-[var(--accent)]"
                />
                {g} ({inGroup.length})
              </label>
        {inGroup.map((s) => (
          <label key={s.key} className="flex items-start gap-2 rounded px-1 py-0.5 hover:bg-[var(--panel-2)]">
            <input
              type="checkbox"
              className="mt-0.5 accent-[var(--up)]"
              checked={picked.has(s.key)}
              onChange={(e) =>
                setPicked((p) => {
                  const n = new Set(p);
                  if (e.target.checked) n.add(s.key);
                  else n.delete(s.key);
                  return n;
                })
              }
            />
            <span>
              <span className="font-medium">{s.name.replace(`${host.name}: `, "")}</span> <span className="text-xs text-[var(--muted)]">— {typeLabel(s.type)}. {s.reason}</span>
            </span>
          </label>
        ))}
            </div>
          );
        })}
      </div>
      <details className="rounded-lg border border-[var(--border)] p-3" open={channels.length > 0}>
        <summary className="cursor-pointer text-sm font-medium">Alerts for the new checks</summary>
        <div className="mt-2">
          <AlertOptions channels={channels} value={alert} onChange={setAlert} />
        </div>
      </details>
      {done && <p className="text-xs text-[var(--up)]">{done}</p>}
      <div className="flex gap-2">
        <Button
          variant="primary"
          disabled={!picked.size || busy}
          onClick={async () => {
            setBusy(true);
            const r = await api.applySuggestions(host.id, [...picked], { alertRule: alertRulePayload(alert) });
            setBusy(false);
            setDone(`Created ${r.created} check(s)${alertRulePayload(alert) ? " with alert rules" : ""}.`);
            load();
            onApplied();
          }}
        >
          Add {picked.size} check{picked.size === 1 ? "" : "s"}
        </Button>
        <Button variant="ghost" onClick={() => setPicked(new Set(picked.size ? [] : suggestions.map((s) => s.key)))}>
          {picked.size ? "Select none" : "Select all"}
        </Button>
      </div>
    </div>
  );
}

function AgentTab({ host, latestAgentVersion, onChanged }: { host: Host; latestAgentVersion: string | null; onChanged: () => void }) {
  const [revealed, setRevealed] = useState<{ agentApiKey: string; installCommands: { unix: string; windows: string } } | null>(null);
  const [platform, setPlatform] = useState<"unix" | "windows">(/windows/i.test(host.os ?? "") ? "windows" : "unix");
  const outdated = Boolean(host.agentVersion && latestAgentVersion && host.agentVersion !== latestAgentVersion);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Agent: {host.agentVersion ? `v${host.agentVersion}` : "not reporting yet"}
        {outdated && <span className="text-[var(--warn)]"> — v{latestAgentVersion} available</span>} · last report {relativeTime(host.lastSeenAt)}
      </p>
      <div className="flex flex-wrap gap-2">
        {host.agentVersion && (
          <Button disabled={host.updateRequested} onClick={async () => (await api.requestHostUpdate(host.id), onChanged())}>
            {host.updateRequested ? "Update requested" : "Update agent"}
          </Button>
        )}
        <Button
          onClick={async () => {
            if (host.hasAgentKey && !confirm("Generate a new key? The current agent stops reporting until it's reinstalled with the new one.")) return;
            setRevealed(await api.issueAgentKey(host.id));
            onChanged();
          }}
        >
          {host.hasAgentKey ? "Regenerate key / install command" : "Generate install command"}
        </Button>
      </div>
      {revealed && (
        <div className="space-y-2 rounded-md border border-[var(--warn)]/40 bg-[var(--warn)]/10 p-2 text-xs">
          <p className="text-[var(--warn)]">
            Copy this now — the key won&apos;t be shown again. Run it on <strong>{host.name}</strong>, elevated (sudo on Linux/macOS, Administrator PowerShell on Windows):
          </p>
          <div className="flex gap-1">
            {(["unix", "windows"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPlatform(p)} className={`rounded px-2 py-0.5 ${platform === p ? "bg-[var(--warn)]/30 text-[var(--text)]" : "text-[var(--muted)]"}`}>
                {p === "unix" ? "Linux / macOS" : "Windows"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-[var(--code-bg)] p-1.5">{revealed.installCommands[platform]}</code>
            <CopyButton text={revealed.installCommands[platform]} />
          </div>
        </div>
      )}
    </div>
  );
}

function EditTab({ host, endpoints, onSaved }: { host: Host; endpoints: Endpoint[]; onSaved: () => void }) {
  const [form, setForm] = useState({ name: host.name, hostname: host.hostname ?? "", os: host.os ?? "", macAddress: host.macAddress ?? "", endpointId: host.endpointId, tags: (host.tags ?? []).join(", ") });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <form
      className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await api.updateHost(host.id, { name: form.name, hostname: form.hostname || null, os: form.os || null, macAddress: form.macAddress || null, endpointId: form.endpointId, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) });
        onSaved();
      }}
    >
      <Label label="Name">
        <input value={form.name} onChange={(e) => set("name", e.target.value)} required className={inputClass} />
      </Label>
      <Label label="Endpoint">
        <select value={form.endpointId} onChange={(e) => set("endpointId", e.target.value)} className={inputClass}>
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </Label>
      <Label label="Hostname / IP" help="For your reference and for discovery matching.">
        <input value={form.hostname} onChange={(e) => set("hostname", e.target.value)} className={inputClass} />
      </Label>
      <Label label="OS">
        <input value={form.os} onChange={(e) => set("os", e.target.value)} className={inputClass} />
      </Label>
      <Label label="MAC address" help="Enables Wake-on-LAN for this host.">
        <input value={form.macAddress} onChange={(e) => set("macAddress", e.target.value)} placeholder="aa:bb:cc:dd:ee:ff" className={inputClass} />
      </Label>
      <Label label="Tags">
        <input value={form.tags} onChange={(e) => set("tags", e.target.value)} placeholder="rack1, prod" className={inputClass} />
      </Label>
      <div className="sm:col-span-2">
        <Button variant="primary" type="submit">
          Save
        </Button>
      </div>
    </form>
  );
}

function InventoryTab({ host, kind }: { host: Host; kind: "processes" | "services" }) {
  const [inv, setInv] = useState<HostInventory | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [sort, setSort] = useState<"memory" | "cpu" | "name">("memory");
  useEffect(() => {
    api.hostInventory(host.id).then(setInv);
  }, [host.id, host.lastSeenAt]);
  if (!inv) return null;
  const query = q.trim().toLowerCase();
  const updated = inv.updatedAt ? `Updated ${relativeTime(inv.updatedAt)} (every ~5 minutes).` : "";
  if (kind === "processes") {
    const rows = inv.processes;
    if (!rows) return <p className="text-sm text-[var(--muted)]">{inv.processNames?.length ? `This agent only reports process names (${inv.processNames.length}). Update it to agent 4.0+ for PID, user, CPU and memory.` : "No process inventory yet — it arrives with the first 4.0+ agent report."}</p>;
    const shown = rows.filter((p) => !query || `${p.name} ${p.user ?? ""} ${p.command ?? ""} ${p.pid}`.toLowerCase().includes(query)).sort((a, b) => (sort === "name" ? a.name.localeCompare(b.name) : sort === "cpu" ? (b.cpuPercent ?? 0) - (a.cpuPercent ?? 0) : (b.memoryMb ?? 0) - (a.memoryMb ?? 0)));
    return (
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${rows.length} processes…`} className={`${inputClass} max-w-xs`} />
          <select value={sort} onChange={(e) => setSort(e.target.value as typeof sort)} className={`${inputClass} w-auto`} aria-label="Sort">
            <option value="memory">Most memory</option>
            <option value="cpu">Most CPU</option>
            <option value="name">Name</option>
          </select>
          <span className="text-xs text-[var(--muted)]">{updated}</span>
        </div>
        <div className="max-h-96 overflow-auto rounded border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
              <tr>
                <th className="px-2 py-1 font-normal">Name</th>
                <th className="px-2 py-1 font-normal">PID</th>
                <th className="px-2 py-1 font-normal">User</th>
                <th className="px-2 py-1 text-right font-normal">CPU %</th>
                <th className="px-2 py-1 text-right font-normal">Memory</th>
                <th className="px-2 py-1 font-normal">Command</th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, 1000).map((p) => (
                <tr key={p.pid} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 font-medium">{p.name}</td>
                  <td className="px-2 py-1 text-[var(--muted)]">{p.pid}</td>
                  <td className="px-2 py-1">{p.user}</td>
                  <td className="px-2 py-1 text-right">{p.cpuPercent?.toFixed(1)}</td>
                  <td className="px-2 py-1 text-right">{p.memoryMb != null ? `${Math.round(p.memoryMb)} MB` : ""}</td>
                  <td className="max-w-md truncate px-2 py-1 font-mono text-[var(--muted)]" title={p.command}>
                    {p.command}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    );
  }
  const rows = inv.services;
  if (!rows) return <p className="text-sm text-[var(--muted)]">{inv.serviceNames?.length ? `This agent only reports service names (${inv.serviceNames.length}). Update it to agent 4.0+ for state and start type.` : "No service inventory yet — it arrives with the first 4.0+ agent report."}</p>;
  const running = (s: { state: string }) => /running|active/i.test(s.state);
  const auto = (s: { startType?: string }) => /auto|enabled/i.test(s.startType ?? "");
  const shown = rows.filter((s) => (filter === "all" || (filter === "running" ? running(s) : filter === "stopped" ? !running(s) : auto(s) && !running(s))) && (!query || `${s.name} ${s.displayName ?? ""}`.toLowerCase().includes(query)));
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${rows.length} services…`} className={`${inputClass} max-w-xs`} />
        {(
          [
            ["all", "All"],
            ["running", "Running"],
            ["stopped", "Not running"],
            ["auto_stopped", "Automatic but stopped"],
          ] as const
        ).map(([k, label]) => (
          <FilterChip key={k} active={filter === k} onClick={() => setFilter(k)}>
            {label}
          </FilterChip>
        ))}
        <span className="text-xs text-[var(--muted)]">{updated}</span>
      </div>
      <div className="max-h-96 overflow-auto rounded border border-[var(--border)]">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
            <tr>
              <th className="px-2 py-1 font-normal">Service</th>
              <th className="px-2 py-1 font-normal">State</th>
              <th className="px-2 py-1 font-normal">Starts</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.name} className="border-t border-[var(--border)]">
                <td className="px-2 py-1">
                  <span className="font-medium">{s.name}</span>
                  {s.displayName && s.displayName !== s.name && <span className="block text-[var(--muted)]">{s.displayName}</span>}
                </td>
                <td className="px-2 py-1">
                  <StatusBadge status={running(s) ? "up" : auto(s) ? "down" : "unknown"} compact /> {s.state}
                </td>
                <td className="px-2 py-1 text-[var(--muted)]">{s.startType}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function AddressesTab({ host }: { host: Host }) {
  const [rows, setRows] = useState<AddressRow[] | null>(null);
  useEffect(() => {
    api.hostAddresses(host.id).then(setRows);
  }, [host.id]);
  if (!rows) return null;
  if (!rows.length) return <p className="text-sm text-[var(--muted)]">No address sightings yet. They come from the agent&apos;s interface list, discovery scans and ARP checks. Add an “IP address change” check to be alerted when this host&apos;s IP changes.</p>;
  const macs = [...new Set(rows.map((r) => r.mac))];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-[var(--muted)]">Every IP each of this host&apos;s MAC addresses has been seen with, newest first. Add an “IP address change (by MAC)” check to be alerted on a change.</p>
      {macs.map((mac) => (
        <div key={mac}>
          <div className="mb-1 font-mono text-xs">{mac}</div>
          <table className="w-full text-xs">
            <thead className="text-left text-[var(--muted)]">
              <tr>
                <th className="py-1 pr-2 font-normal">IP</th>
                <th className="pr-2 font-normal">First seen</th>
                <th className="pr-2 font-normal">Last seen</th>
                <th className="font-normal">Source</th>
              </tr>
            </thead>
            <tbody>
              {rows
                .filter((r) => r.mac === mac)
                .map((r, i) => (
                  <tr key={r.id} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-2 font-mono">
                      {r.ip} {i === 0 && <span className="text-[var(--up)]">(current)</span>}
                    </td>
                    <td className="pr-2">{new Date(r.firstSeenAt).toLocaleString()}</td>
                    <td className="pr-2">{relativeTime(r.lastSeenAt)}</td>
                    <td className="text-[var(--muted)]">{r.source}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function HostPanel({ host, endpoints, checks, channels, latestAgentVersion, onChanged }: { host: Host; endpoints: Endpoint[]; checks: Check[]; channels: Channel[]; latestAgentVersion: string | null; onChanged: () => void }) {
  const [tab, setTab] = useState<"overview" | "checks" | "suggest" | "processes" | "services" | "addresses" | "agent" | "edit">("overview");
  const [detail, setDetail] = useState<HostDetail | null>(null);
  const toast = useToast();
  useEffect(() => {
    api.host(host.id).then(setDetail);
  }, [host.id, host.lastSeenAt]);
  const mine = checks.filter((c) => c.hostId === host.id || c.probeHostId === host.id);
  const tabs = [
    ["overview", "Overview"],
    ["checks", `Checks (${mine.length})`],
    ["suggest", "Suggested checks"],
    ["processes", `Processes${host.processCount ? ` (${host.processCount})` : ""}`],
    ["services", `Services${host.serviceCount ? ` (${host.serviceCount})` : ""}`],
    ["addresses", "IP history"],
    ["agent", "Agent"],
    ["edit", "Edit"],
  ] as const;
  return (
    <div className="space-y-3 border-t border-[var(--border)] bg-[var(--bg)] p-3">
      <div className="flex flex-wrap items-center gap-1">
        {tabs.map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)} className={`rounded-md px-3 py-1 text-xs ${tab === k ? "bg-[var(--panel-2)] text-[var(--text)] ring-1 ring-[var(--border)]" : "text-[var(--muted)] hover:text-[var(--text)]"}`}>
            {label}
          </button>
        ))}
        <span className="flex-1" />
        {host.macAddress && (
          <Button
            className="!py-0.5 text-xs"
            onClick={async () => {
              try {
                const res = await api.wakeHost(host.id);
                toast.show(res.viaCollector ? `Wake-on-LAN queued on this site's collector for ${host.macAddress}.` : `Wake-on-LAN packet sent to ${host.macAddress}.`);
              } catch (err) {
                toast.show(err instanceof Error ? err.message : "Wake failed", "error");
              }
            }}
          >
            Wake (WoL)
          </Button>
        )}
      </div>
      {tab === "overview" && (detail ? <Overview detail={detail} /> : null)}
      {tab === "checks" &&
        (mine.length ? (
          <ul className="space-y-1 text-sm">
            {mine.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <StatusBadge status={displayStatus(c)} compact />
                <a href={`/checks/${c.id}`} className="hover:underline">
                  {c.name}
                </a>
                <span className="truncate text-xs text-[var(--muted)]">{c.lastMessage}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-[var(--muted)]">No checks on this host yet — try Suggested checks.</p>
        ))}
      {tab === "suggest" && <SuggestionsTab host={host} channels={channels} onApplied={onChanged} />}
      {tab === "processes" && <InventoryTab host={host} kind="processes" />}
      {tab === "services" && <InventoryTab host={host} kind="services" />}
      {tab === "addresses" && <AddressesTab host={host} />}
      {tab === "agent" && <AgentTab host={host} latestAgentVersion={latestAgentVersion} onChanged={onChanged} />}
      {tab === "edit" && <EditTab host={host} endpoints={endpoints} onSaved={onChanged} />}
      {toast.node}
    </div>
  );
}

export default function HostsPage() {
  const router = useRouter();
  const [authChecked, setAuthChecked] = useState(false);
  const [endpoints, setEndpoints] = useState<Endpoint[]>([]);
  const [hosts, setHosts] = useState<Host[]>([]);
  const [checks, setChecks] = useState<Check[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [locations, setLocations] = useState<Location[]>([]);
  const [latestAgentVersion, setLatestAgentVersion] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [search, setSearch] = useState("");
  const [endpointFilter, setEndpointFilter] = useState("");
  const [locationFilter, setLocationFilter] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [dialog, setDialog] = useState<"add" | "delete" | "move" | "tags" | "untag" | "maint" | "suggest" | null>(null);
  const toast = useToast();

  const load = useCallback(async () => {
    const [e, h, c, health, ch, l] = await Promise.all([api.endpoints(), api.hosts(), api.checks(), api.health(), api.channels(), api.locations()]);
    setEndpoints(e);
    setHosts(h);
    setChecks(c);
    setChannels(ch);
    setLocations(l);
    setLatestAgentVersion(health.agentVersion);
    setLoaded(true);
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
    load();
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [authChecked, load]);

  const endpointName = useMemo(() => new Map(endpoints.map((e) => [e.id, e.name])), [endpoints]);
  const collectorSites = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const e of endpoints) if (e.collectorHostId) m.set(e.collectorHostId, [...(m.get(e.collectorHostId) ?? []), e.name]);
    return m;
  }, [endpoints]);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const locOf = new Map(endpoints.map((e) => [e.id, e.locationId]));
    return hosts.filter((h) => (!endpointFilter || h.endpointId === endpointFilter) && (!locationFilter || locOf.get(h.endpointId) === locationFilter) && (!q || `${h.name} ${h.hostname ?? ""} ${h.os ?? ""} ${h.macAddress ?? ""} ${(h.tags ?? []).join(" ")} ${h.agentVersion ?? ""}`.toLowerCase().includes(q)));
  }, [hosts, search, endpointFilter, locationFilter, endpoints]);
  const sel = useSelection(filtered.map((h) => h.id));

  async function bulk(action: string, params: Record<string, unknown> = {}, verb = "Updated") {
    const res = await api.bulkHosts(sel.ids, action, params);
    toast.show(res.errors.length ? `${verb} ${res.affected}; ${res.errors.length} skipped: ${res.errors[0].error}` : `${verb} ${res.affected}.`, res.errors.length ? "error" : "info");
    if (action === "delete") sel.clear();
    await load();
  }

  if (!authChecked) return null;

  return (
    <main className="mx-auto max-w-6xl p-4 sm:p-6">
      <TopNav active="/hosts" />
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-lg font-medium">Hosts</h2>
        <Button variant="primary" onClick={() => setDialog("add")} disabled={!endpoints.length}>
          + Add host
        </Button>
      </div>
      <PageHelp anchor="hosts">A host is a machine running the Looksee agent. Open one to see its live state, install or update its agent, and add suggested checks in one click.</PageHelp>

      <div className="mb-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search name, IP, MAC, OS, tag…" className={`${inputClass} sm:col-span-2`} aria-label="Search hosts" />
        <select value={locationFilter} onChange={(e) => setLocationFilter(e.target.value)} className={inputClass} aria-label="Location filter">
          <option value="">All locations</option>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
        <select value={endpointFilter} onChange={(e) => setEndpointFilter(e.target.value)} className={inputClass} aria-label="Endpoint filter">
          <option value="">All endpoints</option>
          {endpoints.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
      </div>

      {loaded && hosts.length === 0 ? (
        <EmptyState>No hosts yet. Add one, then run its install command on that machine.</EmptyState>
      ) : (
        <div className="surface overflow-hidden rounded-xl">
          <div className="hidden grid-cols-[28px_100px_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_110px] gap-3 border-b border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-xs text-[var(--muted)] md:grid">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(filtered.map((h) => h.id), on)} label="Select all hosts" />
            <span>Agent</span>
            <span>Name</span>
            <span>Address / OS</span>
            <span>Endpoint</span>
            <span>Checks</span>
            <span>Last report</span>
          </div>
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 py-2 text-xs text-[var(--muted)] md:hidden">
            <Checkbox checked={sel.allSelected} indeterminate={sel.someSelected} onChange={(on) => sel.setMany(filtered.map((h) => h.id), on)} label="Select all hosts" />
            Select all {filtered.length}
          </div>
          {filtered.map((h) => {
            const state = hostState(h);
            const mine = checks.filter((c) => c.hostId === h.id);
            const bad = mine.filter((c) => ["down", "warn"].includes(displayStatus(c))).length;
            const outdated = Boolean(h.agentVersion && latestAgentVersion && h.agentVersion !== latestAgentVersion);
            const open = expanded === h.id;
            return (
              <Fragment key={h.id}>
                <div
                  onClick={() => setExpanded(open ? null : h.id)}
                  className={`grid cursor-pointer grid-cols-[28px_1fr] gap-x-3 gap-y-1 border-t border-[var(--border)] px-3 py-2 text-sm first:border-t-0 hover:bg-[var(--panel-2)] md:grid-cols-[28px_100px_minmax(0,2fr)_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_110px] md:items-center ${sel.selected.has(h.id) ? "bg-[var(--accent)]/10" : ""}`}
                >
                  <span className="row-span-6 md:row-span-1">
                    <Checkbox checked={sel.selected.has(h.id)} onChange={() => sel.toggle(h.id)} label={`Select ${h.name}`} />
                  </span>
                  <span className="text-xs">
                    <StatusBadge status={state === "online" ? "up" : state === "offline" ? "down" : "unknown"} compact /> {state}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium">{h.name}</span>
                    {collectorSites.has(h.id) && <CollectorLine host={h} sites={collectorSites.get(h.id)!} />}
                    <Tags tags={h.tags} />
                  </span>
                  <span className="min-w-0 truncate text-xs text-[var(--muted)]">
                    {[h.hostname, h.os].filter(Boolean).join(" · ") || "—"}
                    {h.macAddress && <span className="block font-mono">{h.macAddress}</span>}
                    {h.agentVersion && (
                      <span className="block">
                        agent v{h.agentVersion}
                        {outdated && <span className="text-[var(--warn)]"> (update available)</span>}
                      </span>
                    )}
                  </span>
                  <span className="truncate text-xs text-[var(--muted)]">{endpointName.get(h.endpointId)}</span>
                  <span className="text-xs">
                    {mine.length} {bad > 0 && <span className="text-[var(--down)]">· {bad} problem{bad === 1 ? "" : "s"}</span>}
                  </span>
                  <span className="text-xs text-[var(--muted)]">{relativeTime(h.lastSeenAt)}</span>
                </div>
                {open && <HostPanel host={h} endpoints={endpoints} checks={checks} channels={channels} latestAgentVersion={latestAgentVersion} onChanged={load} />}
              </Fragment>
            );
          })}
        </div>
      )}

      <BulkBar
        count={sel.ids.length}
        noun="host"
        onClear={sel.clear}
        actions={
          [
            { group: "Checks", key: "suggest", label: "Add suggested checks…", hint: "Everything recommended for each host", run: () => setDialog("suggest") },
            { group: "Checks", key: "on", label: "Enable their checks", run: () => bulk("enable_checks", {}, "Enabled checks:") },
            { group: "Checks", key: "off", label: "Disable their checks", run: () => bulk("disable_checks", {}, "Disabled checks:") },
            { group: "Checks", key: "maint", label: "Maintenance…", run: () => setDialog("maint") },
            { group: "Agent", key: "update", label: "Update agents", run: () => bulk("request_update", {}, "Requested an update on") },
            { group: "Agent", key: "wake", label: "Wake (WoL)", run: () => bulk("wake", {}, "Sent wake packet to") },
            { group: "Organize", key: "move", label: "Move to endpoint…", run: () => setDialog("move") },
            { group: "Organize", key: "tags", label: "Add tags…", run: () => setDialog("tags") },
            { group: "Organize", key: "untag", label: "Remove tags…", run: () => setDialog("untag") },
            { key: "delete", label: "Delete…", danger: true, run: () => setDialog("delete") },
          ] as BulkAction[]
        }
      />

      {dialog === "suggest" && <BulkSuggestDialog channels={channels} count={sel.ids.length} onClose={() => setDialog(null)} onSubmit={(alertRule) => bulk("apply_suggestions", { alertRule }, "Created checks:")} />}
      {dialog === "add" && <AddHostDialog endpoints={endpoints} defaultEndpointId={endpointFilter} onClose={() => setDialog(null)} onCreated={(h) => (load(), setExpanded(h.id))} />}
      {dialog === "delete" && (
        <ConfirmDialog title={`Delete ${sel.ids.length} host(s)?`} message={<p>Deletes the hosts, every check tied to them, and their metrics history.</p>} confirmWord="delete" actionLabel={`Delete ${sel.ids.length}`} onConfirm={() => bulk("delete", {}, "Deleted")} onClose={() => setDialog(null)} />
      )}
      {dialog === "move" && (
        <PromptDialog
          title={`Move ${sel.ids.length} host(s)`}
          label="Endpoint (their checks move too)"
          options={endpoints.map((e) => ({ value: e.id, label: e.name }))}
          onClose={() => setDialog(null)}
          onSubmit={(v) => bulk("move", { endpointId: v, moveChecks: true }, "Moved")}
        />
      )}
      {(dialog === "tags" || dialog === "untag") && (
        <PromptDialog title={dialog === "tags" ? "Add tags" : "Remove tags"} label="Tags (comma-separated)" onClose={() => setDialog(null)} onSubmit={(v) => bulk(dialog === "tags" ? "add_tags" : "remove_tags", { tags: v })} />
      )}
      {dialog === "maint" && (
        <PromptDialog title="Put in maintenance" label="For how many minutes?" help="Covers every check on these hosts, including checks run from their agents." type="number" initial="60" onClose={() => setDialog(null)} onSubmit={(v) => bulk("maintenance", { minutes: Number(v) }, "Maintenance started for")} />
      )}
      {toast.node}
    </main>
  );
}

function BulkSuggestDialog({ channels, count, onClose, onSubmit }: { channels: Channel[]; count: number; onClose: () => void; onSubmit: (alertRule: ReturnType<typeof alertRulePayload>) => Promise<void> }) {
  const [alert, setAlert] = useState(emptyAlertOptions());
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={`Add suggested checks to ${count} host(s)`} onClose={onClose} wide>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-[var(--muted)]">Adds every recommended check each host doesn&apos;t have yet (open a host&apos;s Suggested checks tab to pick individually). Optionally attach an alert rule to all of them:</p>
        <AlertOptions channels={channels} value={alert} onChange={setAlert} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              await onSubmit(alertRulePayload(alert));
              onClose();
            }}
          >
            Add checks
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CollectorLine({ host, sites }: { host: Host; sites: string[] }) {
  const state = collectorState(host);
  return (
    <span className={`block text-xs ${state.tone === "bad" ? "text-[var(--down)]" : state.tone === "warn" ? "text-[var(--warn)]" : "text-[var(--muted)]"}`} title={host.collectorError ?? undefined}>
      Site collector for {sites.join(", ")} — {state.label}
    </span>
  );
}

function AddHostDialog({ endpoints, defaultEndpointId, onClose, onCreated }: { endpoints: Endpoint[]; defaultEndpointId: string; onClose: () => void; onCreated: (h: Host) => void }) {
  const [form, setForm] = useState({ endpointId: defaultEndpointId || endpoints[0]?.id || "", name: "", hostname: "", os: "", macAddress: "" });
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Add a host" onClose={onClose}>
      <form
        className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            const h = await api.createHost({ endpointId: form.endpointId, name: form.name, hostname: form.hostname || undefined, os: form.os || undefined, macAddress: form.macAddress || undefined });
            onCreated(h);
            onClose();
          } catch (err) {
            setError(err instanceof Error ? err.message : "Failed");
          }
        }}
      >
        <Label label="Name *">
          <input autoFocus required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="nas" className={inputClass} />
        </Label>
        <Label label="Endpoint">
          <select value={form.endpointId} onChange={(e) => setForm({ ...form, endpointId: e.target.value })} className={inputClass}>
            {endpoints.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Label>
        <Label label="Hostname / IP">
          <input value={form.hostname} onChange={(e) => setForm({ ...form, hostname: e.target.value })} className={inputClass} />
        </Label>
        <Label label="OS">
          <input value={form.os} onChange={(e) => setForm({ ...form, os: e.target.value })} placeholder="Ubuntu 24.04 / Windows 11" className={inputClass} />
        </Label>
        <Label label="MAC address" help="Optional — enables Wake-on-LAN.">
          <input value={form.macAddress} onChange={(e) => setForm({ ...form, macAddress: e.target.value })} className={inputClass} />
        </Label>
        {error && <p className="text-[var(--down)] sm:col-span-2">{error}</p>}
        <p className="text-xs text-[var(--muted)] sm:col-span-2">After adding, open the host&apos;s Agent tab for its one-line install command.</p>
        <div className="flex justify-end gap-2 sm:col-span-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit">
            Add host
          </Button>
        </div>
      </form>
    </Modal>
  );
}
