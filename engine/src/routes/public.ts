import { Router } from "express";
import rateLimit from "express-rate-limit";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { checks, statusPages } from "../db/schema.js";
import { recordCheckResult } from "../services/alerting.js";
import { applyThresholds, type Status } from "../services/thresholds.js";

// Everything here is reachable without a session: the public status pages
// (L8) and the heartbeat/push URLs (K1/K2) that cron jobs and scripts call.
// Neither reveals more than the page or check it was asked about.
export const publicRouter = Router();

const pushLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-7", legacyHeaders: false });

const STATUS_WORDS: Record<string, Status> = { up: "up", ok: "up", success: "up", "0": "up", down: "down", fail: "down", failure: "down", error: "down", "1": "warn", "2": "down", warn: "warn", warning: "warn" };

// GET or POST /api/hb/<token>[?status=up|down|warn&msg=...&value=42&latency=120]
// POST bodies may carry the same fields as JSON. Answers 200 "OK" so a
// plain `curl -fsS` in a cron job succeeds without parsing anything.
publicRouter.all("/hb/:token", pushLimiter, async (req, res) => {
  const check = await db.query.checks.findFirst({ where: eq(checks.pushToken, req.params.token) });
  if (!check || (check.type !== "heartbeat" && check.type !== "push_value")) {
    res.status(404).type("text/plain").send("Unknown push token");
    return;
  }
  if (!check.enabled) {
    res.status(200).type("text/plain").send("OK (check is disabled)");
    return;
  }
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
  const result = applyThresholds(
    { status, latencyMs: Number.isFinite(latency) ? Math.round(latency) : null, message: message != null ? String(message).slice(0, 1000) : null, value: value != null && Number.isFinite(value) ? value : null },
    (check.config as Record<string, unknown>) ?? {}
  );
  await db.update(checks).set({ state: { ...((check.state as object) ?? {}), lastPingAt: new Date().toISOString() } }).where(eq(checks.id, check.id));
  await recordCheckResult(check.id, result);
  res.type("text/plain").send("OK");
});

// 90 daily uptime buckets per check. Maintenance-window results don't
// count toward (or against) uptime.
publicRouter.get("/public/status/:slug", async (req, res) => {
  const page = await db.query.statusPages.findFirst({ where: eq(statusPages.slug, req.params.slug) });
  if (!page || !page.published) {
    res.status(404).json({ error: "Status page not found" });
    return;
  }
  const ids = page.checkIds ?? [];
  const rows = ids.length ? await db.query.checks.findMany({ where: inArray(checks.id, ids) }) : [];
  const byId = new Map(rows.map((c) => [c.id, c]));
  const daily = ids.length
    ? (
        await db.execute<{ check_id: string; day: string; total: number; good: number }>(sql`
          SELECT check_id, to_char(date_trunc('day', checked_at), 'YYYY-MM-DD') AS day,
                 count(*)::int AS total, count(*) FILTER (WHERE status IN ('up', 'warn'))::int AS good
          FROM check_results
          WHERE check_id IN (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) AND checked_at > now() - interval '90 days' AND NOT in_maintenance
          GROUP BY check_id, day`)
      ).rows
    : [];
  const days: string[] = [];
  for (let i = 89; i >= 0; i--) days.push(new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10));
  const items = ids
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => Boolean(c))
    .map((c) => {
      const mine = daily.filter((d) => d.check_id === c.id);
      const total = mine.reduce((a, d) => a + d.total, 0);
      const good = mine.reduce((a, d) => a + d.good, 0);
      return {
        name: c.name,
        status: c.enabled ? (c.lastStatus ?? "unknown") : "unknown",
        lastCheckedAt: c.lastCheckedAt,
        uptime90: total ? Math.round((good / total) * 10000) / 100 : null,
        days: days.map((day) => {
          const d = mine.find((m) => m.day === day);
          return { day, uptime: d && d.total ? Math.round((d.good / d.total) * 10000) / 100 : null };
        }),
      };
    });
  const anyDown = items.some((i) => i.status === "down");
  const anyWarn = items.some((i) => i.status === "warn");
  res.json({ title: page.title, description: page.description, overall: anyDown ? "down" : anyWarn ? "degraded" : "operational", checks: items, generatedAt: new Date().toISOString() });
});
