// Looksee site collector: runs a remote site's network checks, receives its
// syslog/traps/flows, and runs its discovery scans and Wake-on-LAN, posting
// everything to the engine over outbound HTTPS. Started and supervised by
// the Looksee agent on the host chosen as the site's collector; bundled into
// a single file (scripts/build-collector.sh) and run on a stock Node runtime.
//
// Only database-free engine modules may be imported here.
import fs from "node:fs";
import path from "node:path";
import { runNetworkProbe } from "../services/probes/network.js";
import { sendWakeOnLan } from "../services/probes/protocols.js";
import { type EventInput, type FlowRow, type ReceiverPorts, FlowAggregator, sourceAllowed, startListeners } from "../services/receivers/core.js";
import { scanNetwork } from "../services/discoveryCore.js";

declare const __COLLECTOR_VERSION__: string;
const VERSION = typeof __COLLECTOR_VERSION__ === "string" ? __COLLECTOR_VERSION__ : "dev";

const ENGINE_URL = (process.env.LOOKSEE_ENGINE_URL ?? "").replace(/\/+$/, "");
const AGENT_KEY = process.env.LOOKSEE_AGENT_KEY ?? "";
const STATE_DIR = process.env.LOOKSEE_COLLECTOR_STATE ?? process.cwd();

// Same ceilings as the engine scheduler.
const TYPE_LIMITS: Record<string, number> = { browser: 2, email_roundtrip: 3, traceroute: 4, dhcp: 1 };
const GLOBAL_LIMIT = 25;
const MAX_BUFFERED_RESULTS = 5000;
const MAX_BUFFERED_EVENTS = 20000;
const MAX_BUFFERED_FLOWS = 50000;

type CollectorCheck = {
  id: string;
  type: string;
  config: Record<string, unknown>;
  intervalSeconds: number;
  retryIntervalSeconds: number | null;
  lastStatus: string | null;
  lastRunAt: string | null;
  state: Record<string, unknown>;
  createdAt: string;
};
type Receivers = ReceiverPorts & { allowedSources: string | null };
type CollectorConfig = {
  pollSeconds: number;
  sites: { id: string; name: string }[];
  checks: CollectorCheck[];
  receivers: Receivers;
  scans: { id: string; cidr: string; community: string }[];
  jobs: { id: string; kind: string; payload: Record<string, unknown> }[];
};

const log = (msg: string) => console.log(`${new Date().toISOString()} collector: ${msg}`);
// fetch() reports every network failure as just "fetch failed"; the cause
// (ECONNREFUSED, a certificate problem, …) is what's useful.
const errText = (err: unknown): string => {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: { code?: string; message?: string } }).cause;
  return cause ? `${err.message}: ${cause.code ?? cause.message ?? String(cause)}` : err.message;
};

async function api<T>(method: "GET" | "POST", route: string, body?: unknown): Promise<T> {
  const res = await fetch(`${ENGINE_URL}/api/collector${route}`, {
    method,
    headers: { authorization: `Bearer ${AGENT_KEY}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`${method} ${route}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

// ---- state --------------------------------------------------------------

let config: CollectorConfig | null = null;
// When the config in hand was requested, and when the engine acknowledged
// each check's latest result — together they tell a real "Run now" (a null
// lastRunAt) from a result that just hadn't landed yet.
let configRequestedAt = 0;
const resultAckedAt = new Map<string, number>();
const lastRun = new Map<string, { at: number; status: string }>();
const running = new Set<string>();
const runningByType = new Map<string, number>();
let pendingResults: Record<string, unknown>[] = [];
let pendingEvents: EventInput[] = [];
let pendingFlows: FlowRow[] = [];
// Problems worth showing on the dashboard (a receiver port in use, …),
// sent with the next config poll.
const problems = new Map<string, string>();

// The last good config is kept on disk so a collector restarted while the
// engine is unreachable keeps monitoring its site.
const cachePath = path.join(STATE_DIR, "collector-config.json");
function loadCachedConfig() {
  try {
    config = JSON.parse(fs.readFileSync(cachePath, "utf-8"));
    log(`loaded cached config (${config?.checks.length ?? 0} checks)`);
  } catch {
    // first run
  }
}
function saveCachedConfig(c: CollectorConfig) {
  try {
    fs.writeFileSync(cachePath, JSON.stringify({ ...c, scans: [], jobs: [] }));
  } catch {
    // best-effort
  }
}

// ---- checks -------------------------------------------------------------

function isDue(c: CollectorCheck, now: number): boolean {
  const local = lastRun.get(c.id);
  // A null lastRunAt from the engine is a "Run now" request — unless this
  // collector has run it since and the engine hadn't recorded that yet when
  // the config was fetched.
  if (c.lastRunAt === null) {
    if (!local) return true;
    const acked = resultAckedAt.get(c.id) ?? 0;
    return acked >= local.at && acked < configRequestedAt && !pendingResults.some((r) => r.checkId === c.id);
  }
  const status = local?.status ?? c.lastStatus;
  const interval = status && status !== "up" && c.retryIntervalSeconds ? c.retryIntervalSeconds : c.intervalSeconds;
  const last = Math.max(local?.at ?? 0, Date.parse(c.lastRunAt));
  return now - last >= interval * 1000;
}

function runDueChecks() {
  if (!config) return;
  const now = Date.now();
  for (const c of config.checks) {
    if (running.size >= GLOBAL_LIMIT) break;
    if (running.has(c.id) || !isDue(c, now)) continue;
    const limit = TYPE_LIMITS[c.type];
    if (limit && (runningByType.get(c.type) ?? 0) >= limit) continue;
    void runCheck(c);
  }
}

async function runCheck(c: CollectorCheck) {
  running.add(c.id);
  runningByType.set(c.type, (runningByType.get(c.type) ?? 0) + 1);
  const ranAt = new Date();
  lastRun.set(c.id, { at: ranAt.getTime(), status: lastRun.get(c.id)?.status ?? c.lastStatus ?? "up" });
  try {
    const outcome = await runNetworkProbe(c.type, c.config, {
      checkId: c.id,
      hostId: null,
      intervalSeconds: c.intervalSeconds,
      state: c.state ?? {},
      createdAt: new Date(c.createdAt),
    });
    if (outcome.state) c.state = outcome.state;
    if (outcome.skip) return;
    lastRun.set(c.id, { at: ranAt.getTime(), status: outcome.status });
    queueResult({ checkId: c.id, ranAt: ranAt.toISOString(), status: outcome.status, message: outcome.message, latencyMs: outcome.latencyMs, value: outcome.value, details: outcome.details, state: outcome.state });
  } catch (err) {
    queueResult({ checkId: c.id, ranAt: ranAt.toISOString(), status: "unknown", message: `Collector error: ${errText(err)}` });
  } finally {
    running.delete(c.id);
    runningByType.set(c.type, (runningByType.get(c.type) ?? 1) - 1);
  }
}

function queueResult(r: Record<string, unknown>) {
  pendingResults.push(r);
  if (pendingResults.length > MAX_BUFFERED_RESULTS) pendingResults = pendingResults.slice(-MAX_BUFFERED_RESULTS);
}

// ---- receivers ----------------------------------------------------------

const flows = new FlowAggregator();
let receiverKey = "";
let stopListeners: (() => void) | null = null;

function applyReceivers(r: Receivers) {
  const key = JSON.stringify(r);
  if (key === receiverKey) return;
  receiverKey = key;
  stopListeners?.();
  for (const k of [...problems.keys()]) if (k.startsWith("receiver:")) problems.delete(k);
  stopListeners = startListeners({
    ports: { syslog: r.syslog, trap: r.trap, flow: r.flow, sflow: r.sflow },
    flows,
    allow: (ip) => sourceAllowed(ip, r.allowedSources ?? undefined),
    onEvent: (e) => {
      pendingEvents.push(e);
      if (pendingEvents.length > MAX_BUFFERED_EVENTS) pendingEvents = pendingEvents.slice(-MAX_BUFFERED_EVENTS);
    },
    onError: (what, err) => {
      problems.set(`receiver:${what}`, `${what}: ${errText(err)}`);
      log(`${what} listener error: ${errText(err)}`);
    },
  });
  log(`receivers: syslog ${r.syslog ?? "off"}, traps ${r.trap ?? "off"}, NetFlow/IPFIX ${r.flow ?? "off"}, sFlow ${r.sflow ?? "off"}`);
}

// ---- one-off work -------------------------------------------------------

async function runScan(scan: { id: string; cidr: string; community: string }) {
  log(`discovery scan of ${scan.cidr}`);
  try {
    const devices = await scanNetwork(scan.cidr, scan.community, (found) => api("POST", `/scans/${scan.id}`, { devices: found }).then(() => undefined).catch(() => undefined));
    await api("POST", `/scans/${scan.id}`, { devices, done: true });
  } catch (err) {
    await api("POST", `/scans/${scan.id}`, { error: errText(err) }).catch(() => undefined);
  }
}

async function runJob(job: { id: string; kind: string; payload: Record<string, unknown> }) {
  let ok = false;
  let message = "";
  try {
    if (job.kind !== "wake") throw new Error(`Unknown job kind "${job.kind}" — update the collector`);
    await sendWakeOnLan(String(job.payload.mac ?? ""), job.payload.broadcast ? String(job.payload.broadcast) : undefined);
    ok = true;
    message = `Magic packet sent to ${job.payload.mac}`;
  } catch (err) {
    message = errText(err);
  }
  await api("POST", `/jobs/${job.id}`, { ok, message }).catch((err) => log(`job ${job.id} report failed: ${errText(err)}`));
}

// ---- loops --------------------------------------------------------------

async function poll() {
  try {
    const error = [...problems.values()].join("; ");
    const requestedAt = Date.now();
    const next = await api<CollectorConfig>("GET", `/config?version=${encodeURIComponent(VERSION)}${error ? `&error=${encodeURIComponent(error)}` : ""}`);
    const byId = new Map(config?.checks.map((c) => [c.id, c]) ?? []);
    // Keep state from runs whose result hasn't been posted yet.
    for (const c of next.checks) {
      const prev = byId.get(c.id);
      if (prev && pendingResults.some((r) => r.checkId === c.id)) c.state = prev.state;
    }
    config = next;
    configRequestedAt = requestedAt;
    saveCachedConfig(next);
    applyReceivers(next.receivers);
    for (const s of next.scans) void runScan(s);
    for (const j of next.jobs) void runJob(j);
  } catch (err) {
    log(`config poll failed (keeps running on the last config): ${errText(err)}`);
  }
  setTimeout(poll, Math.max(5, config?.pollSeconds ?? 15) * 1000);
}

let flushing = false;
async function flush() {
  if (flushing) return;
  flushing = true;
  try {
    if (pendingResults.length) {
      const batch = pendingResults.slice(0, 500);
      await api("POST", "/results", { results: batch });
      const ackedAt = Date.now();
      for (const r of batch) resultAckedAt.set(String(r.checkId), ackedAt);
      pendingResults = pendingResults.slice(batch.length);
    }
    if (pendingEvents.length || pendingFlows.length) {
      const evs = pendingEvents.slice(0, 2000);
      const fls = pendingFlows.slice(0, 10000);
      await api("POST", "/events", { events: evs, flows: fls });
      pendingEvents = pendingEvents.slice(evs.length);
      pendingFlows = pendingFlows.slice(fls.length);
    }
  } catch (err) {
    log(`posting to the engine failed, will retry (${pendingResults.length} results, ${pendingEvents.length} events buffered): ${errText(err)}`);
  } finally {
    flushing = false;
  }
}

function main() {
  if (!ENGINE_URL || !AGENT_KEY) {
    console.error("collector: LOOKSEE_ENGINE_URL and LOOKSEE_AGENT_KEY must be set (the agent sets them)");
    process.exit(2);
  }
  log(`Looksee site collector ${VERSION} (Node ${process.version}) reporting to ${ENGINE_URL}`);
  // The agent holds our stdin open; when it goes away (crashed, killed),
  // so do we, so an orphaned collector never keeps the receiver ports.
  if (process.env.LOOKSEE_COLLECTOR_WATCH_STDIN === "1") {
    const finish = () => void flush().finally(() => process.exit(0));
    process.stdin.on("end", finish);
    process.stdin.on("close", finish);
    process.stdin.resume();
  }
  loadCachedConfig();
  if (config) applyReceivers(config.receivers);
  void poll();
  setInterval(runDueChecks, 1000);
  setInterval(() => void flush(), 3000);
  setInterval(() => {
    const drained = flows.drain();
    pendingFlows.push(...drained);
    if (pendingFlows.length > MAX_BUFFERED_FLOWS) pendingFlows = pendingFlows.slice(-MAX_BUFFERED_FLOWS);
  }, 60_000);
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void flush().finally(() => process.exit(0)));
}

main();
