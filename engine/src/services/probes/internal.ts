// Checks the engine works out from its own database: trap/syslog matches
// (with clear patterns, auto-recovery and excluded texts), anomalies against
// history, overdue heartbeats/pushes, agents gone silent, and disk-full
// forecasts.
//
// Event filters reach the database as query parameters, never as query text.

import { and, desc, eq, gt, gte, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { checkResults, events, endpoints } from "../../db/schema.js";
import { readValueThresholds, hasThresholds } from "../thresholds.js";
import { type Config, type ProbeContext, type ProbeOutcome, down, errMsg, numOr, str, up, warn } from "./types.js";
import { excludeItems } from "./exclude.js";

/**
 * H3/H5: trap and syslog checks. Counts received events matching the
 * check's filter and fails while matches are recent.
 *
 * Settings (all optional except what the filter needs):
 * - pattern, sourceIp, maxSeverity (syslog): which events count.
 * - windowMinutes (default 5): the period the count (the check's value,
 *   for thresholds) covers.
 * - autoRecoverMinutes (default = windowMinutes): with no thresholds, the
 *   check stays failing until this long after the newest matching event,
 *   then recovers on its own.
 * - clearPattern: an event matching this (same source/site/IP filters) that
 *   arrives after a failure clears it — e.g. "linkUp" after "linkDown".
 * - exclude: list of texts; events whose message contains any of them
 *   (case-insensitive) are ignored entirely.
 * Events received before the check's state.resolvedAt (set when the check
 * is resolved by hand, by its "recover with" check, or by an up push) are
 * ignored too, so old events can't re-trigger it.
 *
 * @param source which kind of event to count
 * @param config the check's settings
 * @param ctx the check's ID, site and remembered state
 */
export async function probeEventMatch(source: "snmp_trap" | "syslog", config: Config, ctx?: ProbeContext): Promise<ProbeOutcome> {
  const windowMinutes = numOr(config, "windowMinutes", 5);
  const recoverMinutes = numOr(config, "autoRecoverMinutes", windowMinutes);
  const now = Date.now();
  // Look back far enough for both the count window and the recovery delay.
  const since = new Date(now - Math.max(windowMinutes, recoverMinutes) * 60_000);
  // Conditions every query below shares: event kind, how far back, site, sender.
  const base = [eq(events.source, source), gte(events.receivedAt, since)];
  // Multi-site: a remote site's check (one with a collector or public IPs)
  // counts only its own events; a check for the engine's own site also counts
  // events received directly on the engine's LAN (siteId null). Sites
  // sharing a collector or a public IP are one physical place, and events are
  // stored against just one of them, so the whole set is matched.
  if (ctx?.siteId) {
    const all = await db.query.sites.findMany();
    const ep = all.find((e) => e.id === ctx.siteId);
    const remote = Boolean(ep?.collectorEndpointId || ep?.publicIps?.length);
    if (ep && remote) {
      const ips = new Set(ep.publicIps ?? []);
      const site = all.filter((e) => e.id === ep.id || (ep.collectorEndpointId && e.collectorEndpointId === ep.collectorEndpointId) || (e.publicIps ?? []).some((ip) => ips.has(ip)));
      base.push(inArray(events.siteId, site.map((e) => e.id)));
    } else base.push(or(isNull(events.siteId), eq(events.siteId, ctx.siteId))!);
  }
  const ip = str(config, "sourceIp");
  if (ip) base.push(eq(events.sourceIp, ip));
  // Excluded texts: strpos(...) = 0 means "the message doesn't contain it".
  // Passed as bound parameters, never pasted into the query text.
  // Accepts a list, or text with one entry per line (the dashboard's textarea).
  // At most 200 texts (the check's own plus reusable exclusion lists), each
  // one more condition in the query.
  const exclude = excludeItems(config.exclude).slice(0, 200);
  for (const x of exclude) base.push(sql`strpos(lower(${events.message}), lower(${x})) = 0`);

  // Failing events: the filter's pattern (a Postgres regular expression,
  // ~* = case-insensitive match) and, for syslog, a severity ceiling.
  const conds = [...base];
  const pattern = str(config, "pattern");
  if (pattern) conds.push(sql`${events.message} ~* ${pattern}`);
  if (source === "syslog" && config.maxSeverity !== "" && config.maxSeverity != null) conds.push(sql`${events.severity} <= ${numOr(config, "maxSeverity", 7)}`);

  try {
    // Everything before this moment is ignored: the later of a resolve
    // (state.resolvedAt) and the newest "clear" event.
    let ignoreBefore = 0;
    let clearedBy: { at: Date; from: string; message: string } | null = null;
    const resolvedAt = typeof ctx?.state?.resolvedAt === "string" ? Date.parse(ctx.state.resolvedAt) : NaN;
    if (Number.isFinite(resolvedAt)) ignoreBefore = resolvedAt;
    const clearPattern = str(config, "clearPattern");
    if (clearPattern) {
      const [clear] = await db.select().from(events).where(and(...base, sql`${events.message} ~* ${clearPattern}`)).orderBy(desc(events.receivedAt)).limit(1);
      if (clear && clear.receivedAt.getTime() > ignoreBefore) {
        ignoreBefore = clear.receivedAt.getTime();
        clearedBy = { at: clear.receivedAt, from: clear.sourceIp, message: clear.message };
      }
    }
    if (ignoreBefore) conds.push(gt(events.receivedAt, new Date(ignoreBefore)));

    const rows = await db.select().from(events).where(and(...conds)).orderBy(desc(events.receivedAt)).limit(200);
    // The value: matches within the count window.
    const inWindow = rows.filter((r) => r.receivedAt.getTime() >= now - windowMinutes * 60_000);
    const count = inWindow.length;
    const last = rows[0];
    const what = source === "snmp_trap" ? "trap" : "syslog message";
    const details = rows.slice(0, 10).map((r) => ({ at: r.receivedAt, from: r.sourceIp, severity: r.severity, message: r.message.slice(0, 500) }));
    // With no thresholds, any match newer than the recovery delay fails the check.
    const recent = last && last.receivedAt.getTime() >= now - recoverMinutes * 60_000;
    if (!hasThresholds(readValueThresholds(config)) && recent) {
      const message = `${count || rows.length} matching ${what}(s) — latest from ${last.sourceIp} at ${last.receivedAt.toISOString()}: ${last.message.slice(0, 200)}`;
      return { status: str(config, "severity", "down") as "down", latencyMs: null, message, value: count, details };
    }
    const message = clearedBy && !recent
      ? `Cleared by a matching message from ${clearedBy.from} at ${clearedBy.at.toISOString()}: ${clearedBy.message.slice(0, 160)}`
      : count
        ? `${count} matching ${what}(s) in ${windowMinutes} min`
        : `No matching ${what}s in the last ${recoverMinutes} min`;
    return { status: "up", latencyMs: null, message, value: count, details };
  } catch (err) {
    return warn(`Filter failed: ${errMsg(err)}`);
  }
}

// L6: compares a source check's newest value with the same hour on previous
// days (or the same hour-of-week), in standard deviations. Seasonality is
// what keeps "nightly backup makes the disk busy at 2am" from alerting.
export async function probeAnomaly(config: Config): Promise<ProbeOutcome> {
  const sourceId = str(config, "sourceCheckId");
  if (!sourceId) return warn("Pick a source check");
  const field = str(config, "field", "value") === "latency" ? checkResults.latencyMs : checkResults.value;
  const [latest] = await db.select({ v: field, at: checkResults.checkedAt }).from(checkResults).where(and(eq(checkResults.checkId, sourceId), isNotNull(field))).orderBy(desc(checkResults.checkedAt)).limit(1);
  if (!latest || latest.v == null) return warn("Source check has no numeric results yet");
  const lookbackDays = numOr(config, "lookbackDays", 14);
  const seasonality = str(config, "seasonality", "hour_of_day");
  const at = latest.at;
  // Both sides of the hour/day comparison are computed by Postgres, so the
  // engine's local time zone and the database session's can't disagree.
  const seasonCond =
    seasonality === "hour_of_week"
      ? sql`extract(dow from ${checkResults.checkedAt}) = extract(dow from ${at}::timestamptz) and extract(hour from ${checkResults.checkedAt}) = extract(hour from ${at}::timestamptz)`
      : seasonality === "hour_of_day"
        ? sql`extract(hour from ${checkResults.checkedAt}) = extract(hour from ${at}::timestamptz)`
        : sql`true`;
  const [stats] = await db
    .select({ mean: sql<number>`avg(${field})::float`, sd: sql<number>`stddev_samp(${field})::float`, n: sql<number>`count(${field})::int` })
    .from(checkResults)
    .where(and(eq(checkResults.checkId, sourceId), isNotNull(field), gte(checkResults.checkedAt, new Date(at.getTime() - lookbackDays * 86_400_000)), sql`${checkResults.checkedAt} < ${new Date(at.getTime() - 3_600_000)}`, seasonCond));
  const minSamples = numOr(config, "minSamples", 20);
  const value = Number(latest.v);
  if (!stats || stats.n < minSamples) return up(`Learning baseline (${stats?.n ?? 0}/${minSamples} samples)`, { value: 0, details: { samples: stats?.n ?? 0 } });
  const sd = stats.sd > 0 ? stats.sd : Math.max(Math.abs(stats.mean) * 0.01, 1e-9);
  const z = (value - stats.mean) / sd;
  const sensitivity = numOr(config, "sensitivity", 3);
  const direction = str(config, "direction", "both");
  const relevant = direction === "above" ? z : direction === "below" ? -z : Math.abs(z);
  const details = { value, mean: stats.mean, stddev: stats.sd, samples: stats.n, z };
  const msg = `${Math.round(value * 100) / 100} vs usual ${Math.round(stats.mean * 100) / 100} ± ${Math.round(stats.sd * 100) / 100} (${z >= 0 ? "+" : ""}${z.toFixed(1)}σ)`;
  if (relevant >= sensitivity * 1.5) return { status: "down", latencyMs: null, message: `Anomaly: ${msg}`, value: z, details };
  if (relevant >= sensitivity) return { status: "warn", latencyMs: null, message: `Unusual: ${msg}`, value: z, details };
  return { status: "up", latencyMs: null, message: msg, value: z, details };
}

// K1/K2 staleness. Results themselves arrive through /api/hb/<token>; the
// scheduler only steps in to record "down" once a ping is overdue.
export function probePushStaleness(config: Config, ctx: ProbeContext): ProbeOutcome {
  const grace = numOr(config, "graceSeconds", 60);
  const last = ctx.state.lastPingAt ? new Date(String(ctx.state.lastPingAt)) : null;
  const reference = last ?? ctx.createdAt ?? new Date();
  const overdueBy = (Date.now() - reference.getTime()) / 1000 - ctx.intervalSeconds - grace;
  if (overdueBy <= 0) return { status: "up", latencyMs: null, message: null, skip: true };
  const ago = Math.round((Date.now() - reference.getTime()) / 60_000);
  return down(last ? `No ping for ${ago} min (expected every ${Math.round(ctx.intervalSeconds / 60)} min + ${grace}s grace)` : `No ping received yet (created ${ago} min ago)`);
}

// L11.
export async function probeAgentHeartbeat(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  if (!ctx.endpointId) return warn("No host selected");
  const host = await db.query.endpoints.findFirst({ where: eq(endpoints.id, ctx.endpointId) });
  if (!host) return warn("Endpoint not found");
  if (!host.lastSeenAt) return down("This host's agent has never reported in");
  const silence = (Date.now() - host.lastSeenAt.getTime()) / 1000;
  const max = numOr(config, "maxSilenceSeconds", 120);
  const value = Math.round(silence);
  // Advanced: report a silent agent as warn instead of down (e.g. laptops).
  if (silence > max) {
    const msg = `Agent silent for ${silence >= 120 ? `${Math.round(silence / 60)} min` : `${value}s`} (last report ${host.lastSeenAt.toISOString()})`;
    return str(config, "severity") === "warn" ? warn(msg, { value }) : down(msg, { value });
  }
  return up(`Last report ${value}s ago (agent v${host.agentVersion ?? "?"})`, { value });
}

type DiskSample = { mount: string; total: number; used: number };

// Least-squares slope of used bytes over time — "full in N days" at the
// recent growth rate (Checkmk/Zabbix timeleft-style).
export function forecastDaysToFull(points: { t: number; used: number }[], total: number): { days: number | null; bytesPerDay: number } {
  if (points.length < 2) return { days: null, bytesPerDay: 0 };
  const n = points.length;
  const mt = points.reduce((a, p) => a + p.t, 0) / n;
  const mu = points.reduce((a, p) => a + p.used, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.t - mt) * (p.used - mu);
    den += (p.t - mt) ** 2;
  }
  const slope = den > 0 ? num / den : 0; // bytes per ms
  const bytesPerDay = slope * 86_400_000;
  if (slope <= 0) return { days: null, bytesPerDay };
  const latest = points.reduce((a, b) => (b.t > a.t ? b : a));
  return { days: (total - latest.used) / bytesPerDay, bytesPerDay };
}

// C4.
export async function probeDiskForecast(config: Config, ctx: ProbeContext): Promise<ProbeOutcome> {
  if (!ctx.endpointId) return warn("No host selected");
  const lookbackDays = numOr(config, "lookbackDays", 7);
  // One sample per hour is plenty for a multi-day trend and keeps this
  // query cheap no matter how often the agent reports.
  const rows = await db.execute<{ t: Date; disks: DiskSample[] }>(sql`
    SELECT DISTINCT ON (date_trunc('hour', recorded_at)) recorded_at AS t, extended->'disks' AS disks
    FROM endpoint_metrics
    WHERE endpoint_id = ${ctx.endpointId} AND recorded_at > now() - (${lookbackDays} || ' days')::interval AND extended IS NOT NULL
    ORDER BY date_trunc('hour', recorded_at), recorded_at DESC`);
  const samples = rows.rows;
  if (samples.length < 3) return up(`Collecting history (${samples.length} hourly samples so far; needs 3+)`, { skip: samples.length === 0 });
  const wanted = str(config, "mount");
  const mounts = new Set<string>();
  for (const s of samples) for (const d of s.disks ?? []) mounts.add(d.mount);
  const targets = wanted ? [wanted] : [...mounts];
  const results: { mount: string; days: number | null; bytesPerDay: number; total: number; used: number }[] = [];
  for (const mount of targets) {
    const pts = samples.flatMap((s) => (s.disks ?? []).filter((d) => d.mount === mount).map((d) => ({ t: new Date(s.t).getTime(), used: d.used, total: d.total })));
    if (pts.length < 3) continue;
    const latest = pts.reduce((a, b) => (b.t > a.t ? b : a));
    const f = forecastDaysToFull(pts, latest.total);
    results.push({ mount, ...f, total: latest.total, used: latest.used });
  }
  if (!results.length) return warn(wanted ? `No history for mount ${wanted}` : "No disk history yet");
  const soonest = results.reduce((a, b) => ((b.days ?? Infinity) < (a.days ?? Infinity) ? b : a));
  const warnDays = numOr(config, "warnDays", 14);
  const critDays = numOr(config, "criticalDays", 3);
  const details = results.map((r) => ({ ...r, days: r.days != null ? Math.round(r.days * 10) / 10 : null, gbPerDay: Math.round((r.bytesPerDay / 1e9) * 100) / 100 }));
  if (soonest.days == null) return { status: "up", latencyMs: null, message: `Not growing over the last ${lookbackDays} days`, value: 9999, details };
  const days = Math.round(soonest.days * 10) / 10;
  const msg = `${soonest.mount} full in ~${days} days at ${(soonest.bytesPerDay / 1e9).toFixed(2)} GB/day`;
  const status = days <= critDays ? "down" : days <= warnDays ? "warn" : "up";
  return { status, latencyMs: null, message: msg, value: Math.min(days, 9999), details };
}
