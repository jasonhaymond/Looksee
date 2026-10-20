// Unauthenticated API routes: heartbeat/push URLs (/api/hb/<token>) and public
// status pages (/api/public/status/<slug>).
//
// Where this sits: mounted under /api in app.ts. Heartbeat URLs are called by
// cron jobs, backup scripts and other machines to say "I ran" (heartbeat
// checks) or to report a number (push_value checks). Status pages are read by
// the dashboard's public /status/<slug> page, which anyone can open.
//
// Security: nothing here needs a session, so each route reveals only what it
// was asked about. A heartbeat token is the credential for its one check;
// unknown tokens are logged as security events (so guessing is detected and
// can be auto-blocked by a security rule) and rate-limited. A status page
// returns only the names, status and uptime of the checks the admin put on
// it — never endpoints, messages or configuration.

import { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, statusPages } from "../db/schema.js";
import { recordCheckResult, resolveCheck } from "../services/alerting.js";
import { recordSecurityEvent } from "../services/security.js";
import { applyThresholds, type Status } from "../services/thresholds.js";
import { isValidTimeZone, localMidnight, recentDates } from "../lib/timeZone.js";

export const publicRouter = Router();

// At most 120 heartbeat calls per minute from one address — ample for real
// cron jobs, and slows down anyone trying token after token.
const pushLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });

// The words a script may send as ?status=, mapped to a check status. Exit
// codes are accepted too ("0" = ok, "1" = warning, "2" = failure, as in
// Nagios plugins) so a script can pass `$?` straight through.
const STATUS_WORDS: Record<string, Status> = { up: "up", ok: "up", success: "up", "0": "up", down: "down", fail: "down", failure: "down", error: "down", "1": "warn", "2": "down", warn: "warn", warning: "warn" };

// GET or POST /api/hb/<token>[?status=up|down|warn&msg=...&value=42&latency=120]
// POST bodies may carry the same fields as JSON. Answers 200 "OK" so a plain
// `curl -fsS` in a cron job succeeds without parsing anything.
publicRouter.all("/hb/:token", pushLimiter, async (req, res) => {
  // The token is the only credential: look up the one check it belongs to.
  const check = await db.query.checks.findFirst({ where: eq(checks.pushToken, String(req.params.token)) });
  if (!check) {
    // The token itself is masked in the log (path "/api/hb/…") so a real
    // token mistyped by one character isn't written down anywhere.
    await recordSecurityEvent("bad_push_token", { req, path: "/api/hb/…" });
    res.status(404).type("text/plain").send("Unknown push token");
    return;
  }
  // Any other kind of check with a token has a "recovery URL": the only
  // thing it accepts is status=up (or ok/success/0), which marks the check
  // recovered. It can't report a failure or a value — the check's own probe
  // does that.
  if (check.type !== "heartbeat" && check.type !== "push_value") {
    const input = { ...(req.body && typeof req.body === "object" ? req.body : {}), ...req.query } as Record<string, unknown>;
    if (STATUS_WORDS[String(input.status ?? "up").toLowerCase()] !== "up") {
      res.status(400).type("text/plain").send("This is a recovery URL: it only accepts status=up");
      return;
    }
    const msg = input.msg ?? input.message;
    await resolveCheck(check.id, `Recovered by an external "up" event${msg != null ? `: ${String(msg).slice(0, 200)}` : ""}`, "push");
    res.type("text/plain").send("OK (recovered)");
    return;
  }
  if (!check.enabled) {
    res.status(200).type("text/plain").send("OK (check is disabled)");
    return;
  }
  // Query-string values win over body values when both are sent.
  const input = { ...(req.body && typeof req.body === "object" ? req.body : {}), ...req.query } as Record<string, unknown>;
  const status = STATUS_WORDS[String(input.status ?? "up").toLowerCase()] ?? "up";
  const message = input.msg ?? input.message;
  const rawValue = input.value;
  const value = rawValue === undefined || rawValue === "" ? null : Number(rawValue);
  if (check.type === "push_value" && (value == null || !Number.isFinite(value))) {
    res.status(400).type("text/plain").send("A numeric ?value= is required for this check");
    return;
  }
  const latency = Number(input.latency ?? input.ping);
  // The check's own thresholds (e.g. "warn above 80") are applied to the
  // pushed value exactly as for checks Looksee runs itself. Messages are
  // capped at 1000 characters so a script can't fill the database.
  const result = applyThresholds(
    { status, latencyMs: Number.isFinite(latency) ? Math.round(latency) : null, message: message != null ? String(message).slice(0, 1000) : null, value: value != null && Number.isFinite(value) ? value : null },
    (check.config as Record<string, unknown>) ?? {}
  );
  // lastPingAt is what the heartbeat's "no ping for N minutes" timer reads.
  await db.update(checks).set({ state: { ...((check.state as object) ?? {}), lastPingAt: new Date().toISOString() } }).where(eq(checks.id, check.id));
  await recordCheckResult(check.id, result);
  res.type("text/plain").send("OK");
});

// GET /api/public/status/<slug>[?tz=America/Chicago] — a published status
// page: each listed check's status, 90-day uptime, and 90 daily uptime bars.
// Results recorded during a maintenance window don't count toward (or
// against) uptime. `tz` is the visitor's time zone, so each bar covers the
// visitor's own calendar day; without it (or if it's not a known zone),
// days are UTC.
publicRouter.get("/public/status/:slug", async (req, res) => {
  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, req.params.slug) });
  // An unpublished page answers exactly like a missing one, so its existence
  // isn't revealed.
  if (!page || !page.published) {
    res.status(404).json({ error: "Status page not found" });
    return;
  }
  const zone = isValidTimeZone(req.query.tz) ? req.query.tz : "UTC";
  const ids = page.checkIds ?? [];
  const rows = ids.length ? await db.query.checks.findMany({ where: inArray(checks.id, ids) }) : [];
  const byId = new Map(rows.map((c) => [c.id, c]));

  // The 90 dates the bars show, oldest first, ending today in the visitor's
  // zone, and the instant each one starts there — plus tomorrow's start as
  // the end of today. These are worked out in Node (lib/timeZone.ts), so
  // Postgres never needs to understand the zone name: browsers still send
  // legacy names like "Asia/Calcutta" that some Postgres builds reject.
  const days = recentDates(90, zone);
  const [ty, tm, td] = days[days.length - 1].split("-").map(Number);
  const tomorrow = new Date(Date.UTC(ty, tm - 1, td + 1)).toISOString().slice(0, 10);
  const bounds = [...days, tomorrow].map((d) => localMidnight(d, zone).toISOString());

  // Counts results per check per local day: total, and how many were up or
  // warn ("good"). width_bucket(t, bounds) returns which interval of the
  // sorted boundary list t falls in: 1 = the first day, 90 = today (0 or 91
  // = outside the range, filtered out by the WHERE clause). The boundaries
  // and check IDs are bound parameters (Drizzle's sql`` template sends ${...}
  // values separately from the query text), so they can't inject SQL.
  const daily = ids.length
    ? (
        await db.execute<{ check_id: string; bucket: number; total: number; good: number }>(sql`
          SELECT check_id, width_bucket(checked_at, ${`{${bounds.join(",")}}`}::timestamptz[]) AS bucket,
                 count(*)::int AS total, count(*) FILTER (WHERE status IN ('up', 'warn'))::int AS good
          FROM check_results
          WHERE check_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)})
            AND checked_at >= ${bounds[0]}::timestamptz AND checked_at < ${bounds[bounds.length - 1]}::timestamptz
            AND NOT (in_maintenance OR excluded)
          GROUP BY check_id, bucket`)
      ).rows.map((r) => ({ ...r, day: days[Number(r.bucket) - 1] }))
    : [];
  const items = ids
    .map((id) => byId.get(id))
    // Drops IDs of checks deleted since the page was set up.
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => {
      const mine = daily.filter((d) => d.check_id === c.id && days.includes(d.day));
      const total = mine.reduce((a, d) => a + d.total, 0);
      const good = mine.reduce((a, d) => a + d.good, 0);
      return {
        name: c.name,
        status: c.enabled ? (c.lastStatus ?? "unknown") : "unknown",
        lastCheckedAt: c.lastCheckedAt,
        // Percentages rounded to two decimals; null = no results at all.
        uptime90: total ? Math.round((good / total) * 10000) / 100 : null,
        days: days.map((day) => {
          const d = mine.find((m) => m.day === day);
          return { day, uptime: d && d.total ? Math.round((d.good / d.total) * 10000) / 100 : null };
        }),
      };
    });
  const anyDown = items.some((i) => i.status === "down");
  const anyWarn = items.some((i) => i.status === "warn");
  res.json({ title: page.title, description: page.description, overall: anyDown ? "down" : anyWarn ? "degraded" : "operational", checks: items, timeZone: zone, generatedAt: new Date().toISOString() });
});
