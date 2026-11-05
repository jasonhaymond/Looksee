// Everything about one endpoint, in tabs: overview, checks, suggested checks
// and templates, processes, services, installed software and its history, IP
// history, agent install/update, watchdog and edit. Used on the Endpoints list
// and each endpoint's page. Every table sorts by clicking a column header
// (lib/useSort.ts).

"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import { cleanMemory } from "../lib/memoryDetail";
import { api, type AddressRow, type Channel, type Check, type Site, type Endpoint, type EndpointDetail, type EndpointInventory, type EndpointSession, type EndpointSnapshot, type EndpointSoftware, type Suggestion } from "../lib/api";
import { useSort, type SortState } from "../lib/useSort";
import { typeLabel } from "../lib/checkTypes";
import { AlertOptions, Button, FilterChip, Label, MultiPicker, SortPicker, SortTh, StatusBadge, alertRulePayload, emptyAlertOptions, formatBytes, inputClass, relativeTime, useToast } from "./ui";
import { displayStatus } from "./CheckDetail";
import { WatchdogSettings } from "./WatchdogSettings";
import { RoleTemplates } from "./RoleTemplates";
import { own } from "../lib/own";

// An agent that hasn't reported for 3 report intervals (90s by default) is
// considered offline here; the agent_heartbeat check is the alerting version.
const ONLINE_WINDOW_MS = 120_000;

export function endpointState(h: Endpoint): "online" | "offline" | "no agent" {
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

type Snapshot = NonNullable<EndpointDetail["lastSnapshot"]>;

/** The Overview tab's filesystems: mount, type, how full, free space. */
function FilesystemsTable({ disks }: { disks: NonNullable<Snapshot["disks"]> }) {
  type Disk = (typeof disks)[number];
  const sort = useSort<Disk>("endpointDisks", { mount: (d) => d.mount, type: (d) => d.fstype, used: (d) => d.percent, free: (d) => d.free });
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-xs text-[var(--muted)]">Filesystems</div>
      <table className="w-full whitespace-nowrap text-xs">
        <thead className="text-left text-[var(--muted)]">
          <tr>
            <SortTh sort={sort} column="mount" className="py-1 pr-2 font-normal">
              Mount
            </SortTh>
            <SortTh sort={sort} column="type" className="pr-2 font-normal">
              Type
            </SortTh>
            <SortTh sort={sort} column="used" className="pr-2 font-normal">
              Used
            </SortTh>
            <SortTh sort={sort} column="free" className="pr-2 font-normal">
              Free
            </SortTh>
            <th />
          </tr>
        </thead>
        <tbody>
          {sort.apply(disks).map((d) => (
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
  );
}

/** The Overview tab's network interfaces. */
function InterfacesTable({ net }: { net: NonNullable<Snapshot["net"]> }) {
  type Interface = (typeof net)[number];
  const sort = useSort<Interface>("endpointNet", { name: (n) => n.name, link: (n) => (n.up ? 0 : 1), speed: (n) => n.speedMbps, traffic: (n) => n.rxBytesPerSec + n.txBytesPerSec, mac: (n) => n.mac, addresses: (n) => (n.addrs ?? [])[0] });
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-xs text-[var(--muted)]">Interfaces</div>
      <table className="w-full whitespace-nowrap text-xs">
        <thead className="text-left text-[var(--muted)]">
          <tr>
            <SortTh sort={sort} column="name" className="py-1 pr-2 font-normal">
              Name
            </SortTh>
            <SortTh sort={sort} column="link" className="pr-2 font-normal">
              Link
            </SortTh>
            <SortTh sort={sort} column="speed" className="pr-2 font-normal">
              Speed
            </SortTh>
            <SortTh sort={sort} column="traffic" className="pr-2 font-normal">
              Traffic
            </SortTh>
            <SortTh sort={sort} column="mac" className="pr-2 font-normal">
              MAC
            </SortTh>
            <SortTh sort={sort} column="addresses" className="font-normal">
              Addresses
            </SortTh>
          </tr>
        </thead>
        <tbody>
          {sort.apply(net).map((n) => (
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
  );
}

/** "2 h 5 min" from seconds; "—" when unknown. */
function duration(seconds: number | undefined) {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** The Overview tab's signed-in users on Windows: user, connection, state, source. */
function SessionsTable({ sessions }: { sessions: EndpointSession[] }) {
  const connection = (s: EndpointSession) => (s.kind === "console" ? "console" : "RDP");
  const from = (s: EndpointSession) => [s.clientName, s.host].filter(Boolean).join(" ");
  const sort = useSort<EndpointSession>("endpointSessions", { user: (s) => s.user, connection, state: (s) => s.state, from, idle: (s) => s.idleSeconds, signedIn: (s) => s.started });
  return (
    <div className="overflow-x-auto">
      <div className="mb-1 text-xs text-[var(--muted)]">Signed-in users</div>
      <table className="w-full whitespace-nowrap text-xs">
        <thead className="text-left text-[var(--muted)]">
          <tr>
            <SortTh sort={sort} column="user" className="py-1 pr-2 font-normal">
              User
            </SortTh>
            <SortTh sort={sort} column="connection" className="pr-2 font-normal">
              Connection
            </SortTh>
            <SortTh sort={sort} column="state" className="pr-2 font-normal">
              State
            </SortTh>
            <SortTh sort={sort} column="from" className="pr-2 font-normal">
              From
            </SortTh>
            <SortTh sort={sort} column="idle" className="pr-2 font-normal">
              Idle
            </SortTh>
            <SortTh sort={sort} column="signedIn" className="font-normal">
              Signed in
            </SortTh>
          </tr>
        </thead>
        <tbody>
          {sort.apply(sessions).map((s, i) => (
            <tr key={s.id ?? i} className="border-t border-[var(--border)]">
              <td className="py-1 pr-2">{s.user}</td>
              <td className="pr-2 text-[var(--muted)]">{connection(s)}</td>
              <td className={`pr-2 ${s.state === "disconnected" ? "text-[var(--warn)]" : ""}`}>{s.state ?? "—"}</td>
              <td className="pr-2 text-[var(--muted)]">{from(s) || "—"}</td>
              <td className="pr-2 text-[var(--muted)]">{duration(s.idleSeconds)}</td>
              <td className="text-[var(--muted)]">{s.started ? new Date(s.started * 1000).toLocaleString() : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Where an endpoint's memory is: commit, kernel pools, what processes hold, what
 * they don't, swap and paging. Only shows rows the agent reported.
 * @param mem the memory section of the agent's latest report
 * @param os the endpoint's operating system, for what to call swap and the pools
 */
function MemoryDetail({ mem: reported, os }: { mem: NonNullable<EndpointSnapshot["mem"]>; os: string | null }) {
  const mem = cleanMemory(reported);
  const windows = /windows/i.test(os ?? "");
  const ofTotal = (used?: number, total?: number) => (used != null && total ? `${formatBytes(used)} of ${formatBytes(total)} (${Math.round((used / total) * 100)}%)` : null);
  const rows: [string, string | null, string?][] = [
    ["Physical memory", ofTotal(mem.total - mem.available, mem.total)],
    ["System commit", ofTotal(mem.commitUsed, mem.commitLimit), windows ? "Promised to programs and the system, against RAM plus page file. Programs start failing at 100%." : "Promised to programs. Linux usually doesn't enforce this limit, so above 100% can be normal."],
    ["Kernel nonpaged pool", mem.kernelNonpaged != null ? formatBytes(mem.kernelNonpaged) : null, windows ? "Kernel and driver memory that must stay in RAM. Steady growth usually means a driver leak." : "Closest Linux equivalent: unreclaimable slab, page tables and kernel stacks."],
    ["Kernel paged pool", mem.kernelPaged != null ? formatBytes(mem.kernelPaged) : null, windows ? "Kernel memory that can move to disk." : "Closest Linux equivalent: reclaimable slab."],
    ["Process private", mem.processPrivate != null ? formatBytes(mem.processPrivate) : null, "Memory held by processes and services for themselves, added up."],
    ["Not in processes", mem.nonProcess != null ? formatBytes(mem.nonProcess) : null, "Memory in use that no process or service holds: kernel, drivers, shared memory."],
    [windows ? "Page file" : "Swap", mem.swapTotal ? ofTotal(mem.swapUsed ?? 0, mem.swapTotal) : "None"],
    ["Paging (read / written per sec)", mem.pagesInPerSec != null && mem.pagesOutPerSec != null ? `${Math.round(mem.pagesInPerSec)} / ${Math.round(mem.pagesOutPerSec)}` : null, "Pages moved between RAM and disk. Sustained writes mean real memory pressure."],
  ];
  return (
    <div>
      <div className="mb-1 text-xs text-[var(--muted)]">Memory detail</div>
      <div className="grid grid-cols-1 gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
        {rows
          .filter(([, value]) => value != null)
          .map(([label, value, help]) => (
            <div key={label} className="flex justify-between gap-3 border-b border-[var(--border)] py-0.5" title={help}>
              <span className="text-[var(--muted)]">{label}</span>
              <span className="text-right">{value}</span>
            </div>
          ))}
      </div>
      {!!mem.topPrivate?.length && (
        <p className="mt-1 text-xs text-[var(--muted)]">
          Largest private memory: {mem.topPrivate.map((p) => `${p.name} ${formatBytes(p.bytes)}`).join(", ")}
        </p>
      )}
      {!!mem.privateUnread && <p className="mt-1 text-xs text-[var(--muted)]">{mem.privateUnread} processes couldn&apos;t be read, so their memory counts as not in processes.</p>}
      {mem.commitLimit == null && mem.processPrivate == null && <p className="mt-1 text-xs text-[var(--muted)]">Commit, kernel pool and process detail need agent 5.5 or later on Windows or Linux.</p>}
    </div>
  );
}

function Overview({ detail }: { detail: EndpointDetail }) {
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

      {s.mem && <MemoryDetail mem={s.mem} os={detail.os} />}
      {s.disks && s.disks.length > 0 && <FilesystemsTable disks={s.disks} />}
      {s.net && s.net.length > 0 && <InterfacesTable net={s.net} />}
      {s.users?.detail && s.users.sessions?.length > 0 && <SessionsTable sessions={s.users.sessions} />}

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

function SuggestionsTab({ host, channels, onApplied }: { host: Endpoint; channels: Channel[]; onApplied: () => void }) {
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [alert, setAlert] = useState(emptyAlertOptions());
  const [done, setDone] = useState<string | null>(null);
  const load = useCallback(() => {
    api.endpointSuggestions(host.id).then((s) => {
      setSuggestions(s);
      setPicked(new Set(s.map((x) => x.key)));
    });
  }, [host.id]);
  useEffect(load, [load]);
  if (!suggestions) return null;
  if (!suggestions.length) return <p className="text-sm text-[var(--muted)]">{host.hasSnapshot ? "Nothing more to suggest — this endpoint already has every recommended check." : "Suggestions appear once a 3.x agent has reported in."}</p>;
  return (
    <div className="space-y-2 text-sm">
      <p className="text-xs text-[var(--muted)]">Based on what the agent found on this endpoint — its services, processes, containers, listening ports and logs. Untick anything you don&apos;t want; thresholds can be changed afterwards.</p>
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

/**
 * The Agent tab: the agent's version (with "Update agent" when a newer one
 * is available), its connection diagnostics, and generating a key plus the
 * one-line install command (shown once, never again).
 */
function AgentTab({ host, sites, latestAgentVersion, onChanged }: { host: Endpoint; sites: Site[]; latestAgentVersion: string | null; onChanged: () => void }) {
  const [revealed, setRevealed] = useState<{ agentApiKey: string; installCommands: { unix: string; windows: string; android?: string } } | null>(null);
  // Which install command to show first: guessed from the endpoint's OS.
  const [platform, setPlatform] = useState<"unix" | "windows" | "android">(/windows/i.test(host.os ?? "") ? "windows" : /android/i.test(host.os ?? "") ? "android" : "unix");
  const outdated = Boolean(host.agentVersion && latestAgentVersion && host.agentVersion !== latestAgentVersion);
  return (
    <div className="space-y-3 text-sm">
      <p>
        Agent: {host.agentVersion ? `v${host.agentVersion}` : "not reporting yet"}
        {outdated && <span className="text-[var(--warn)]"> — v{latestAgentVersion} available</span>} · last report {relativeTime(host.lastSeenAt)}
      </p>
      <AgentDiagnostics host={host} />
      {host.hasAgentKey && <CollectorSites host={host} sites={sites} onChanged={onChanged} />}
      <div className="flex flex-wrap gap-2">
        {host.agentVersion && (
          <Button disabled={host.updateRequested} onClick={async () => (await api.requestEndpointUpdate(host.id), onChanged())}>
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
            Copy this now — the key won&apos;t be shown again. Run it on <strong>{host.name}</strong>, elevated (sudo on Linux/macOS, Administrator PowerShell on Windows; on Android, in the Termux app — see the agent guide → Android first):
          </p>
          <div className="flex gap-1">
            {(["unix", "windows", "android"] as const).map((p) => (
              <button key={p} type="button" onClick={() => setPlatform(p)} className={`rounded px-2 py-0.5 ${platform === p ? "bg-[var(--warn)]/30 text-[var(--text)]" : "text-[var(--muted)]"}`}>
                {p === "unix" ? "Linux / macOS" : p === "windows" ? "Windows" : "Android"}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <code className="flex-1 break-all rounded bg-[var(--code-bg)] p-1.5">{own(revealed.installCommands, platform)}</code>
            <CopyButton text={own(revealed.installCommands, platform) ?? ""} />
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Which sites (networks) this endpoint's agent is the site collector for.
 * One agent can collect for several sites — e.g. a box on a trunk port that
 * reaches several VLANs. Saving makes this agent the collector for exactly
 * the chosen sites (replacing another collector a site had) and hands back
 * the ones left out to the Looksee server; the agent starts or stops the
 * collector on its next config poll.
 */
function CollectorSites({ host, sites, onChanged }: { host: Endpoint; sites: Site[]; onChanged: () => void }) {
  const current = sites.filter((s) => s.collectorEndpointId === host.id).map((s) => s.id);
  const [chosen, setChosen] = useState<string[]>(current);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const changed = chosen.length !== current.length || chosen.some((id) => !current.includes(id));
  // Sites collected by another endpoint are marked, since choosing them here moves them.
  const items = sites.map((s) => ({ id: s.id, label: s.name, sub: s.collectorEndpointId && s.collectorEndpointId !== host.id ? "has another collector — would move here" : s.networks?.length ? s.networks.join(", ") : undefined }));
  return (
    <div className="space-y-1">
      <div className="text-xs text-[var(--muted)]">Site collector for — this agent runs the network checks, discovery and event receivers of these sites. Give each site its address ranges (Sites → edit) so received events are filed under the right one.</div>
      <MultiPicker items={items} selected={chosen} onChange={setChosen} placeholder="Search sites…" height="max-h-32" />
      <div className="flex items-center gap-2">
        <Button
          disabled={!changed || saving}
          onClick={async () => {
            setSaving(true);
            setMessage(null);
            try {
              const now = await api.setCollectorSites(host.id, chosen);
              setMessage(now.length ? `Collector for ${now.map((s) => s.name).join(", ")}.` : "No longer a site collector.");
              onChanged();
            } catch (err) {
              setMessage(err instanceof Error ? err.message : "Couldn't save");
            } finally {
              setSaving(false);
            }
          }}
        >
          Save collector sites
        </Button>
        {message && <span className="text-xs text-[var(--muted)]">{message}</span>}
      </div>
    </div>
  );
}

/**
 * Connection diagnostics for an endpoint's agent: when it last fetched its
 * config, when its last report was stored, the address it connects from,
 * and why its last report couldn't be fully stored, if it couldn't. This is
 * what tells "the agent never reaches Looksee" (no config poll at all) from
 * "it connects but its reports are rejected" (recent polls, old or failing
 * reports) without looking in the database.
 */
function AgentDiagnostics({ host }: { host: Endpoint }) {
  if (!host.hasAgentKey) return null;
  // The engine started recording polls in 5.1; older data has none yet.
  const polled = host.lastConfigAt ? relativeTime(host.lastConfigAt) : "never (or before Looksee 5.1)";
  return (
    <div className="space-y-1 rounded-md border border-[var(--border)] p-2 text-xs">
      <p className="text-[var(--muted)]">
        Last config poll: <span className="text-[var(--text)]">{polled}</span>
        {" · "}last report stored: <span className="text-[var(--text)]">{host.lastSeenAt ? relativeTime(host.lastSeenAt) : "never"}</span>
        {host.lastAgentIp && (
          <>
            {" · "}connects from <span className="text-[var(--text)]">{host.lastAgentIp}</span>
          </>
        )}
      </p>
      {host.lastReportError && (
        <p className="text-[var(--warn)]">
          Warning: the last report{host.lastReportErrorAt ? ` (${relativeTime(host.lastReportErrorAt)})` : ""} couldn&apos;t be fully stored — the endpoint still counts as online, but some inventory, software or check data may be missing: <span className="break-words">{host.lastReportError}</span>
        </p>
      )}
    </div>
  );
}

function EditTab({ host, sites, onSaved }: { host: Endpoint; sites: Site[]; onSaved: () => void }) {
  const [form, setForm] = useState({ name: host.name, hostname: host.hostname ?? "", os: host.os ?? "", macAddress: host.macAddress ?? "", siteId: host.siteId, tags: (host.tags ?? []).join(", ") });
  const set = (k: keyof typeof form, v: string) => setForm((f) => ({ ...f, [k]: v }));
  return (
    <form
      className="grid grid-cols-1 gap-3 text-sm sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        await api.updateEndpoint(host.id, { name: form.name, hostname: form.hostname || null, os: form.os || null, macAddress: form.macAddress || null, siteId: form.siteId, tags: form.tags.split(",").map((t) => t.trim()).filter(Boolean) });
        onSaved();
      }}
    >
      <Label label="Name">
        <input value={form.name} onChange={(e) => set("name", e.target.value)} required className={inputClass} />
      </Label>
      <Label label="Site">
        <select value={form.siteId} onChange={(e) => set("siteId", e.target.value)} className={inputClass}>
          {sites.map((e) => (
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
      <Label label="MAC address" help="Enables Wake-on-LAN for this endpoint.">
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

// Most memory first until a column is chosen.
const MOST_MEMORY: SortState = { key: "memory", dir: "desc" };

function InventoryTab({ host, kind }: { host: Endpoint; kind: "processes" | "services" }) {
  const [inv, setInv] = useState<EndpointInventory | null>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const procSort = useSort<NonNullable<EndpointInventory["processes"]>[number]>("endpointProcesses", { name: (p) => p.name, pid: (p) => p.pid, user: (p) => p.user, cpu: (p) => p.cpuPercent, memory: (p) => p.memoryMb, private: (p) => p.privateMb, command: (p) => p.command }, MOST_MEMORY);
  const svcSort = useSort<NonNullable<EndpointInventory["services"]>[number]>("endpointServices", { name: (s) => s.displayName ?? s.name, state: (s) => s.state, starts: (s) => s.startType });
  useEffect(() => {
    api.endpointInventory(host.id).then(setInv);
  }, [host.id, host.lastSeenAt]);
  if (!inv) return null;
  const query = q.trim().toLowerCase();
  const updated = inv.updatedAt ? `Updated ${relativeTime(inv.updatedAt)} (every ~5 minutes).` : "";
  if (kind === "processes") {
    const rows = inv.processes;
    if (!rows) return <p className="text-sm text-[var(--muted)]">{inv.processNames?.length ? `This agent only reports process names (${inv.processNames.length}). Update it to agent 4.0+ for PID, user, CPU and memory.` : "No process inventory yet — it arrives with the first 4.0+ agent report."}</p>;
    const shown = procSort.apply(rows.filter((p) => !query || `${p.name} ${p.user ?? ""} ${p.command ?? ""} ${p.pid}`.toLowerCase().includes(query)));
    return (
      <div className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${rows.length} processes…`} className={`${inputClass} max-w-xs`} />
          <span className="text-xs text-[var(--muted)]">{updated}</span>
        </div>
        <div className="max-h-96 overflow-auto rounded border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
              <tr>
                <SortTh sort={procSort} column="name" className="px-2 py-1 font-normal">
                  Name
                </SortTh>
                <SortTh sort={procSort} column="pid" className="px-2 py-1 font-normal">
                  PID
                </SortTh>
                <SortTh sort={procSort} column="user" className="px-2 py-1 font-normal">
                  User
                </SortTh>
                <SortTh sort={procSort} column="cpu" className="px-2 py-1 text-right font-normal">
                  CPU %
                </SortTh>
                <SortTh sort={procSort} column="memory" className="px-2 py-1 text-right font-normal">
                  Memory
                </SortTh>
                <SortTh sort={procSort} column="private" className="px-2 py-1 text-right font-normal">
                  Private
                </SortTh>
                <SortTh sort={procSort} column="command" className="px-2 py-1 font-normal">
                  Command
                </SortTh>
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
                  <td className="px-2 py-1 text-right">{p.privateMb != null ? `${Math.round(p.privateMb)} MB` : ""}</td>
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
              <SortTh sort={svcSort} column="name" className="px-2 py-1 font-normal">
                Service
              </SortTh>
              <SortTh sort={svcSort} column="state" className="px-2 py-1 font-normal">
                State
              </SortTh>
              <SortTh sort={svcSort} column="starts" className="px-2 py-1 font-normal">
                Starts
              </SortTh>
            </tr>
          </thead>
          <tbody>
            {svcSort.apply(shown).map((s) => (
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

/**
 * The Software tab: what's installed now and the history of what changed. The
 * history starts from the first report the engine received with it turned on, and
 * agents collect every 6 hours, so a date here is when Looksee noticed, not the
 * moment of the install.
 */
function SoftwareTab({ host }: { host: Endpoint }) {
  const [data, setData] = useState<EndpointSoftware | null>(null);
  const [view, setView] = useState<"history" | "installed">("history");
  const [q, setQ] = useState("");
  const [action, setAction] = useState("all");
  const historySort = useSort<EndpointSoftware["history"][number]>("softwareHistory", { when: (h) => new Date(h.detectedAt), action: (h) => h.action, name: (h) => h.name, source: (h) => h.source, from: (h) => h.fromVersion, to: (h) => h.toVersion });
  const packageSort = useSort<EndpointSoftware["packages"][number]>("softwarePackages", { name: (p) => p.name, version: (p) => p.version, source: (p) => p.source });
  useEffect(() => {
    api.endpointSoftware(host.id).then(setData);
  }, [host.id, host.lastSeenAt]);
  if (!data) return null;
  if (!data.updatedAt) return <p className="text-sm text-[var(--muted)]">No software report yet. It arrives from agents 5.0 and newer, within about 6 hours of the agent starting.</p>;
  const query = q.trim().toLowerCase();
  const matches = (text: string) => !query || text.toLowerCase().includes(query);
  const history = historySort.apply(data.history.filter((h) => (action === "all" || h.action === action) && matches(`${h.name} ${h.source} ${h.fromVersion ?? ""} ${h.toVersion ?? ""}`)));
  const packages = packageSort.apply(data.packages.filter((p) => matches(`${p.name} ${p.version} ${p.source} ${p.path ?? ""}`)));
  const actionLabel = (a: string) => (a === "installed" ? <span className="text-[var(--up)]">installed</span> : a === "removed" ? <span className="text-[var(--warn)]">removed</span> : "updated");
  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <FilterChip active={view === "history"} onClick={() => setView("history")}>
          History ({data.history.length})
        </FilterChip>
        <FilterChip active={view === "installed"} onClick={() => setView("installed")}>
          Installed now ({data.packages.length})
        </FilterChip>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" aria-label="Search software" className={`${inputClass} max-w-xs`} />
        {view === "history" && (
          <select value={action} onChange={(e) => setAction(e.target.value)} className={`${inputClass} !w-auto`} aria-label="Show which changes">
            <option value="all">All changes</option>
            <option value="installed">Installed</option>
            <option value="removed">Removed</option>
            <option value="updated">Updated</option>
          </select>
        )}
        <span className="text-xs text-[var(--muted)]">Last report {relativeTime(data.updatedAt)}. Agents check about every 6 hours.</span>
      </div>
      {data.errors.length > 0 && <p className="text-xs text-[var(--warn)]">The agent couldn&apos;t list everything: {data.errors.join("; ")}</p>}
      {view === "history" ? (
        data.history.length === 0 ? (
          <p className="text-sm text-[var(--muted)]">No changes recorded yet. The first report is the starting point, so changes appear from the next one on.</p>
        ) : (
          <div className="max-h-96 overflow-auto rounded border border-[var(--border)]">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
                <tr>
                  <SortTh sort={historySort} column="when" className="px-2 py-1 font-normal">
                    Noticed
                  </SortTh>
                  <SortTh sort={historySort} column="action" className="px-2 py-1 font-normal">
                    Change
                  </SortTh>
                  <SortTh sort={historySort} column="name" className="px-2 py-1 font-normal">
                    Name
                  </SortTh>
                  <SortTh sort={historySort} column="from" className="px-2 py-1 font-normal">
                    From
                  </SortTh>
                  <SortTh sort={historySort} column="to" className="px-2 py-1 font-normal">
                    To
                  </SortTh>
                  <SortTh sort={historySort} column="source" className="px-2 py-1 font-normal">
                    Source
                  </SortTh>
                </tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={h.id} className="border-t border-[var(--border)]">
                    <td className="whitespace-nowrap px-2 py-1 text-[var(--muted)]">{new Date(h.detectedAt).toLocaleString()}</td>
                    <td className="px-2 py-1">{actionLabel(h.action)}</td>
                    <td className="px-2 py-1 font-medium">{h.name}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">{h.fromVersion ?? "—"}</td>
                    <td className="px-2 py-1">{h.toVersion ?? "—"}</td>
                    <td className="px-2 py-1 text-[var(--muted)]">{h.source}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <div className="max-h-96 overflow-auto rounded border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-[var(--panel-2)] text-left text-[var(--muted)]">
              <tr>
                <SortTh sort={packageSort} column="name" className="px-2 py-1 font-normal">
                  Name
                </SortTh>
                <SortTh sort={packageSort} column="version" className="px-2 py-1 font-normal">
                  Version
                </SortTh>
                <SortTh sort={packageSort} column="source" className="px-2 py-1 font-normal">
                  Source
                </SortTh>
              </tr>
            </thead>
            <tbody>
              {packages.slice(0, 2000).map((p, i) => (
                <tr key={`${p.source}:${p.name}:${p.path ?? ""}:${i}`} className="border-t border-[var(--border)]">
                  <td className="px-2 py-1 font-medium">{p.name}</td>
                  <td className="px-2 py-1">{p.version}</td>
                  <td className="px-2 py-1 text-[var(--muted)]" title={p.path ?? undefined}>
                    {p.source}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function AddressesTab({ host }: { host: Endpoint }) {
  const [rows, setRows] = useState<AddressRow[] | null>(null);
  const sort = useSort<AddressRow>("endpointAddresses", { ip: (r) => r.ip, first: (r) => new Date(r.firstSeenAt), last: (r) => new Date(r.lastSeenAt), source: (r) => r.source });
  useEffect(() => {
    api.endpointAddresses(host.id).then(setRows);
  }, [host.id]);
  if (!rows) return null;
  if (!rows.length) return <p className="text-sm text-[var(--muted)]">No address sightings yet. They come from the agent&apos;s interface list, discovery scans and ARP checks. Add an “IP address change” check to be alerted when this endpoint&apos;s IP changes.</p>;
  const macs = [...new Set(rows.map((r) => r.mac))];
  return (
    <div className="space-y-3 text-sm">
      <p className="text-xs text-[var(--muted)]">Every IP each of this endpoint&apos;s MAC addresses has been seen with, newest first. Add an “IP address change (by MAC)” check to be alerted on a change.</p>
      {macs.map((mac) => (
        <div key={mac}>
          <div className="mb-1 font-mono text-xs">{mac}</div>
          <table className="w-full text-xs">
            <thead className="text-left text-[var(--muted)]">
              <tr>
                <SortTh sort={sort} column="ip" className="py-1 pr-2 font-normal">
                  IP
                </SortTh>
                <SortTh sort={sort} column="first" className="pr-2 font-normal">
                  First seen
                </SortTh>
                <SortTh sort={sort} column="last" className="pr-2 font-normal">
                  Last seen
                </SortTh>
                <SortTh sort={sort} column="source" className="font-normal">
                  Source
                </SortTh>
              </tr>
            </thead>
            <tbody>
              {sort.apply(rows.filter((r) => r.mac === mac))
                .map((r) => (
                  <tr key={r.id} className="border-t border-[var(--border)]">
                    <td className="py-1 pr-2 font-mono">
                      {r.ip} {r.id === rows.find((x) => x.mac === mac)?.id && <span className="text-[var(--up)]">(current)</span>}
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

export function EndpointPanel({ host, sites, checks, channels, latestAgentVersion, onChanged }: { host: Endpoint; sites: Site[]; checks: Check[]; channels: Channel[]; latestAgentVersion: string | null; onChanged: () => void }) {
  const [tab, setTab] = useState<"overview" | "checks" | "suggest" | "processes" | "services" | "software" | "addresses" | "agent" | "watchdog" | "edit">("overview");
  const checkSort = useSort<Check>("endpointChecks", { name: (c) => c.name, status: (c) => displayStatus(c), type: (c) => typeLabel(c.type), message: (c) => c.lastMessage });
  const [detail, setDetail] = useState<EndpointDetail | null>(null);
  const toast = useToast();
  useEffect(() => {
    api.endpoint(host.id).then(setDetail);
  }, [host.id, host.lastSeenAt]);
  const mine = checks.filter((c) => c.endpointId === host.id || c.probeEndpointId === host.id);
  const tabs = [
    ["overview", "Overview"],
    ["checks", `Checks (${mine.length})`],
    ["suggest", "Suggested checks"],
    ["processes", `Processes${host.processCount ? ` (${host.processCount})` : ""}`],
    ["services", `Services${host.serviceCount ? ` (${host.serviceCount})` : ""}`],
    ["software", "Software"],
    ["addresses", "IP history"],
    ["agent", "Agent"],
    ["watchdog", host.watchdog?.enabled ? "Watchdog ✓" : "Watchdog"],
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
                const res = await api.wakeEndpoint(host.id);
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
            <li className="mb-1">
              <SortPicker sort={checkSort} options={[["name", "Name"], ["status", "Status"], ["type", "Type"], ["message", "Message"]]} />
            </li>
            {checkSort.apply(mine).map((c) => (
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
          <p className="text-sm text-[var(--muted)]">No checks on this endpoint yet — try Suggested checks.</p>
        ))}
      {tab === "suggest" && (
        <>
          <SuggestionsTab host={host} channels={channels} onApplied={onChanged} />
          <RoleTemplates host={host} onApplied={onChanged} />
        </>
      )}
      {tab === "processes" && <InventoryTab host={host} kind="processes" />}
      {tab === "services" && <InventoryTab host={host} kind="services" />}
      {tab === "software" && <SoftwareTab host={host} />}
      {tab === "addresses" && <AddressesTab host={host} />}
      {tab === "agent" && <AgentTab host={host} sites={sites} latestAgentVersion={latestAgentVersion} onChanged={onChanged} />}
      {tab === "watchdog" && <WatchdogSettings host={host} channels={channels} onChanged={onChanged} />}
      {tab === "edit" && <EditTab host={host} sites={sites} onSaved={onChanged} />}
      {toast.node}
    </div>
  );
}

