import { type Config, type ProbeContext, type ProbeOutcome, bool, down, errMsg, str, warn } from "./types.js";
import { httpRequest, jsonPathGet, parseHeaders } from "./http.js";

export type PromSample = { name: string; labels: Record<string, string>; value: number };

// Prometheus text exposition format: `name{a="b",c="d"} 12.5 [ts]`.
export function parsePrometheus(text: string): PromSample[] {
  const out: PromSample[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/);
    if (!m) continue;
    const labels: Record<string, string> = {};
    if (m[3]) for (const l of m[3].matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) labels[l[1]] = l[2].replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    const v = m[4] === "+Inf" ? Infinity : m[4] === "-Inf" ? -Infinity : Number(m[4]);
    if (!Number.isNaN(v)) out.push({ name: m[1], labels, value: v });
  }
  return out;
}

// "job=node, mode!=idle, instance=~web.*" -> predicate.
export function labelMatcher(spec: string): (labels: Record<string, string>) => boolean {
  const rules = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(=~|!~|!=|=)\s*"?(.*?)"?$/);
      if (!m) throw new Error(`Bad label matcher: ${s}`);
      return { key: m[1], op: m[2], val: m[3] };
    });
  return (labels) =>
    rules.every(({ key, op, val }) => {
      const actual = labels[key] ?? "";
      if (op === "=") return actual === val;
      if (op === "!=") return actual !== val;
      const re = new RegExp(`^(?:${val})$`);
      return op === "=~" ? re.test(actual) : !re.test(actual);
    });
}

function aggregate(values: number[], how: string): number {
  if (how === "count") return values.length;
  if (how === "min") return Math.min(...values);
  if (how === "max") return Math.max(...values);
  if (how === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + b, 0);
}

// Turns a monotonically increasing counter into a per-second rate using the
// previous run's raw value. A counter reset (value went down) restarts the
// baseline instead of reporting a negative rate.
export function counterRate(raw: number, ctx: ProbeContext, key = "raw"): { rate: number | null; state: Record<string, unknown> } {
  const now = Date.now();
  const prevRaw = ctx.state[key] as number | undefined;
  const prevAt = ctx.state[`${key}At`] as number | undefined;
  const state = { ...ctx.state, [key]: raw, [`${key}At`]: now };
  if (prevRaw == null || prevAt == null || raw < prevRaw || now <= prevAt) return { rate: null, state };
  return { rate: (raw - prevRaw) / ((now - prevAt) / 1000), state };
}

const round2 = (n: number) => Math.round(n * 100) / 100;

// J3: read any metric from any Prometheus exporter (node_exporter, cAdvisor,
// Caddy, Traefik, ...) and put thresholds on it.
export async function probePrometheus(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const url = str(config, "url");
  const metric = str(config, "metric");
  if (!url || !metric) return warn("Missing url or metric");
  try {
    const headers = parseHeaders(str(config, "headers"));
    if (str(config, "bearerToken")) headers.Authorization = `Bearer ${str(config, "bearerToken")}`;
    const res = await httpRequest(url, { headers, insecure: bool(config, "insecureSkipVerify"), maxBodyBytes: 20_000_000 });
    if (res.status !== 200) return { status: "down", latencyMs: res.latencyMs, message: `Scrape returned HTTP ${res.status}` };
    const match = labelMatcher(str(config, "labels"));
    const samples = parsePrometheus(res.body).filter((s) => s.name === metric && match(s.labels));
    if (!samples.length) return { status: "down", latencyMs: res.latencyMs, message: `No samples for ${metric}${str(config, "labels") ? `{${str(config, "labels")}}` : ""}` };
    let value = aggregate(samples.map((s) => s.value), str(config, "aggregation", "sum"));
    let state: Record<string, unknown> | undefined;
    if (bool(config, "rate")) {
      const r = counterRate(value, ctx);
      state = r.state;
      if (r.rate == null) return { status: "up", latencyMs: res.latencyMs, message: "Collecting a baseline for the rate", state, skip: true };
      value = r.rate;
    }
    return { status: "up", latencyMs: res.latencyMs, message: `${metric} = ${round2(value)}${bool(config, "rate") ? "/s" : ""} (${samples.length} series)`, value, state };
  } catch (err) {
    return down(errMsg(err));
  }
}

// J2: nginx stub_status, Apache mod_status (?auto), Caddy's Prometheus
// /metrics. Request rates come from the servers' cumulative counters.
export async function probeWebserverStatus(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  const url = str(config, "url");
  const kind = str(config, "kind", "nginx");
  const metric = str(config, "metric", "requests_per_sec");
  if (!url) return warn("Missing url");
  try {
    const res = await httpRequest(kind === "apache" && !url.includes("?auto") ? `${url}${url.includes("?") ? "&" : "?"}auto` : url, { insecure: bool(config, "insecureSkipVerify"), headers: parseHeaders(str(config, "headers")) });
    if (res.status !== 200) return { status: "down", latencyMs: res.latencyMs, message: `Status page returned HTTP ${res.status}` };
    const latencyMs = res.latencyMs;
    const values: Record<string, number> = {};
    const counters: Record<string, number> = {};
    if (kind === "nginx") {
      const active = res.body.match(/Active connections:\s*(\d+)/);
      const totals = res.body.match(/\n\s*(\d+)\s+(\d+)\s+(\d+)\s*\n/);
      const rw = res.body.match(/Reading:\s*(\d+)\s*Writing:\s*(\d+)\s*Waiting:\s*(\d+)/);
      if (!active || !totals) return { status: "down", latencyMs, message: "Response isn't nginx stub_status output" };
      values.active_connections = Number(active[1]);
      if (rw) values.waiting = Number(rw[3]);
      counters.requests = Number(totals[3]);
      counters.dropped = Number(totals[1]) - Number(totals[2]);
    } else if (kind === "apache") {
      const kv = Object.fromEntries(res.body.split(/\r?\n/).filter((l) => l.includes(":")).map((l) => [l.slice(0, l.indexOf(":")).trim(), l.slice(l.indexOf(":") + 1).trim()]));
      if (kv.BusyWorkers == null) return { status: "down", latencyMs, message: "Response isn't Apache mod_status ?auto output" };
      values.busy_workers = Number(kv.BusyWorkers);
      values.idle_workers = Number(kv.IdleWorkers);
      values.busy_percent = round2((values.busy_workers / Math.max(1, values.busy_workers + values.idle_workers)) * 100);
      if (kv["Total Accesses"] != null) counters.requests = Number(kv["Total Accesses"]);
    } else {
      const samples = parsePrometheus(res.body);
      const sum = (name: string) => samples.filter((s) => s.name === name).reduce((a, s) => a + s.value, 0);
      if (!samples.some((s) => s.name.startsWith("caddy_"))) return { status: "down", latencyMs, message: "No caddy_* metrics at this URL (enable the `metrics` global option)" };
      values.active_connections = sum("caddy_http_requests_in_flight");
      counters.requests = sum("caddy_http_requests_total");
      counters.errors = sum("caddy_http_request_errors_total");
    }
    let state: Record<string, unknown> = ctx.state;
    for (const [k, raw] of Object.entries(counters)) {
      const r = counterRate(raw, { ...ctx, state }, k);
      state = r.state;
      if (r.rate != null) values[`${k}_per_sec`] = round2(r.rate);
    }
    const value = values[metric];
    if (value == null) return { status: "up", latencyMs, message: `Collecting a baseline for ${metric}`, state, skip: metric.endsWith("_per_sec") };
    return { status: "up", latencyMs, message: Object.entries(values).map(([k, v]) => `${k.replace(/_/g, " ")} ${v}`).join(", "), value, details: values, state };
  } catch (err) {
    return down(errMsg(err));
  }
}

// J4: first-party APIs of common self-hosted apps.
export async function probeAppIntegration(config: Config): Promise<ProbeOutcome> {
  const app = str(config, "app", "nextcloud");
  const base = str(config, "url").replace(/\/$/, "");
  const token = str(config, "token");
  const metric = str(config, "metric", "status");
  const insecure = bool(config, "insecureSkipVerify");
  if (!base) return warn("Missing url");
  const start = Date.now();
  const getJson = async (path: string, headers: Record<string, string> = {}, opts: { method?: string; body?: string } = {}) => {
    const res = await httpRequest(`${base}${path}`, { headers: { Accept: "application/json", ...headers }, insecure, ...opts });
    if (res.status === 401 || res.status === 403) throw new Error(`${app} rejected the credentials (HTTP ${res.status})`);
    if (res.status >= 400) throw new Error(`${path} returned HTTP ${res.status}`);
    return JSON.parse(res.body) as any;
  };
  const done = (value: number | null, message: string, status: ProbeOutcome["status"] = "up", details?: unknown): ProbeOutcome => ({ status, latencyMs: Date.now() - start, message, value, details });
  try {
    switch (app) {
      case "nextcloud": {
        const st = await getJson("/status.php");
        if (st.maintenance) return done(null, "Nextcloud is in maintenance mode", "warn");
        if (st.needsDbUpgrade) return done(null, "Nextcloud needs a database upgrade (run occ upgrade)", "warn");
        if (metric === "status") return done(null, `Nextcloud ${st.versionstring} OK`);
        const info = await getJson("/ocs/v2.php/apps/serverinfo/api/v1/info?format=json", { "NC-Token": token, "OCS-APIRequest": "true" });
        const data = info.ocs?.data;
        const map: Record<string, number | undefined> = {
          free_space_gb: data?.nextcloud?.system?.freespace != null ? data.nextcloud.system.freespace / 1e9 : undefined,
          active_users: data?.activeUsers?.last5minutes,
          updates_available: data?.nextcloud?.system?.apps?.num_updates_available,
        };
        const v = map[metric];
        return v == null ? done(null, `${metric} not reported by serverinfo`, "warn") : done(round2(v), `${metric.replace(/_/g, " ")}: ${round2(v)}`);
      }
      case "home_assistant": {
        const auth = { Authorization: `Bearer ${token}` };
        const api = await getJson("/api/", auth);
        const entity = str(config, "entityId");
        if (!entity) return done(null, api.message ?? "API running");
        const state = await getJson(`/api/states/${entity}`, auth);
        const expected = str(config, "expectedState");
        const n = Number(state.state);
        if (expected && state.state !== expected) return done(Number.isFinite(n) ? n : null, `${entity} is "${state.state}", expected "${expected}"`, "down");
        if (state.state === "unavailable" || state.state === "unknown") return done(null, `${entity} is ${state.state}`, "down");
        return done(Number.isFinite(n) ? n : null, `${entity} = ${state.state}${state.attributes?.unit_of_measurement ?? ""}`);
      }
      case "plex": {
        const id = await getJson("/identity");
        if (metric === "status") return done(null, `Plex ${id.MediaContainer?.version ?? ""} up`.trim());
        const s = await getJson(`/status/sessions?X-Plex-Token=${encodeURIComponent(token)}`);
        const n = Number(s.MediaContainer?.size ?? 0);
        return done(n, `${n} active stream(s)`);
      }
      case "jellyfin": {
        const info = await getJson("/System/Info/Public");
        if (metric === "status") return done(null, `${info.ProductName ?? "Jellyfin"} ${info.Version} up`);
        const sessions = (await getJson("/Sessions", { "X-Emby-Token": token })) as { NowPlayingItem?: unknown }[];
        const n = sessions.filter((x) => x.NowPlayingItem).length;
        return done(n, `${n} active stream(s)`);
      }
      case "pihole": {
        // Pi-hole v6 REST API: password -> session id.
        let sid: string | null = null;
        try {
          const auth = await getJson("/api/auth", { "Content-Type": "application/json" }, { method: "POST", body: JSON.stringify({ password: token }) });
          sid = auth.session?.sid ?? null;
        } catch {
          sid = null;
        }
        if (sid) {
          const blocking = await getJson("/api/dns/blocking", { sid });
          const summary = await getJson("/api/stats/summary", { sid });
          const values = { percent_blocked: summary.queries?.percent_blocked, queries_today: summary.queries?.total, domains_blocked: summary.gravity?.domains_being_blocked };
          if (blocking.blocking !== "enabled") return done(null, `Ad blocking is ${blocking.blocking}`, "down", values);
          const v = (values as Record<string, number | undefined>)[metric];
          return done(v != null ? round2(v) : null, `Blocking enabled — ${round2(values.percent_blocked ?? 0)}% of ${values.queries_today ?? 0} queries blocked`, "up", values);
        }
        const v5 = await getJson(`/admin/api.php?summaryRaw&auth=${encodeURIComponent(token)}`);
        if (v5.status !== "enabled") return done(null, `Ad blocking is ${v5.status ?? "unknown"}`, "down");
        const values: Record<string, number> = { percent_blocked: v5.ads_percentage_today, queries_today: v5.dns_queries_today, domains_blocked: v5.domains_being_blocked };
        return done(values[metric] != null ? round2(values[metric]) : null, `Blocking enabled — ${round2(values.percent_blocked)}% blocked`, "up", values);
      }
      case "custom_json": {
        const res = await getJson(str(config, "path", "/"), token ? { Authorization: `Bearer ${token}` } : {});
        const v = jsonPathGet(res, str(config, "jsonPath", "$"));
        const n = Number(v);
        return done(Number.isFinite(n) ? n : null, `${str(config, "jsonPath")} = ${JSON.stringify(v)}`);
      }
      default:
        return warn(`Unknown app: ${app}`);
    }
  } catch (err) {
    return down(errMsg(err));
  }
}
