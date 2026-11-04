// RDP sessions check (check type host_rdp_sessions): who is connected to a Windows
// endpoint over Remote Desktop, and in what state.
//
// Where this sits: routes/agent.ts calls evaluateRdpSessions on each agent report,
// using the session list in the report (agent/internal/metrics/sessions_windows.go).
// The agent only lists; every judgement is made here, as with other thresholds.
//
// A disconnected session is counted as RDP unless Windows says it's the console:
// once disconnected, a session no longer has a connection type to report, and
// those are the sessions this check most needs to show, since they hold a user's
// programs and sign-in open on the server.
//
// Security: "Expected users" flags anyone else who connects, which is how this check
// catches a stolen account being used for remote access. Matching ignores case and
// the domain part, so "alice" also matches "CORP\alice".

import { applyThresholds, type MeasuredResult } from "./thresholds.js";
import { nameExcluded } from "./probes/exclude.js";

/** One session from an agent's report. */
export type ReportedSession = { user: string; terminal?: string; host?: string; started?: number; id?: number; state?: string; kind?: string; clientName?: string; idleSeconds?: number; disconnectedAt?: number };
/** The report's session list. Detail is set by Windows agents 5.4 and newer. */
export type ReportedUsers = { count?: number; sessions?: ReportedSession[]; detail?: boolean };

/** Splits a settings box's lines or commas into a list. */
const lines = (v: unknown) =>
  String(v ?? "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

/** "2 h 5 min" from seconds. */
function span(seconds: number): string {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/**
 * Judges the sessions in one report.
 *
 * @param users the report's session list
 * @param config includeConsole; allowedUsers (names, * wildcards) and
 *   unexpectedSeverity; disconnectedMaxMinutes and severity; the usual value
 *   thresholds on the number of sessions
 * @param nowSeconds the current time, for how long sessions have been disconnected
 * @returns the check result: value = number of sessions, details = the session
 *   table on the check's page. Unknown when the agent can't report session detail.
 */
export function evaluateRdpSessions(users: ReportedUsers | undefined, config: Record<string, unknown>, nowSeconds = Date.now() / 1000): MeasuredResult {
  if (!users?.detail) return { status: "unknown", latencyMs: null, message: "RDP session detail needs a Windows agent, version 5.4 or newer" };

  const includeConsole = config.includeConsole === true || config.includeConsole === "true";
  const shown = (users.sessions ?? []).filter((s) => includeConsole || s.kind !== "console");
  const bareName = (user: string) => user.split("\\").pop() ?? user;

  const rows = shown.map((s) => ({
    user: s.user,
    state: s.state ?? "unknown",
    connection: s.kind === "console" ? "console" : "RDP",
    from: [s.clientName, s.host].filter(Boolean).join(" ") || null,
    signedIn: s.started ? new Date(s.started * 1000).toISOString() : null,
    idle: s.idleSeconds != null ? span(s.idleSeconds) : null,
    disconnected: s.state === "disconnected" && s.disconnectedAt ? span(Math.max(0, nowSeconds - s.disconnectedAt)) : null,
  }));
  const describe = (s: (typeof rows)[number]) => `${s.user} (${s.state}${s.disconnected ? ` ${s.disconnected}` : ""}${s.from ? `, from ${s.from}` : ""})`;
  const summary = rows.length ? `${rows.length} session${rows.length === 1 ? "" : "s"}: ${rows.map(describe).join("; ")}` : "No RDP sessions";

  const problems: string[] = [];
  let status: MeasuredResult["status"] = "up";

  // Anyone not on the expected list. Checked against both the full and the bare
  // name, so the list works with or without the domain.
  const allowed = lines(config.allowedUsers);
  if (allowed.length) {
    const unexpected = shown.filter((s) => !nameExcluded(s.user, allowed) && !nameExcluded(bareName(s.user), allowed));
    if (unexpected.length) {
      problems.push(`unexpected user: ${[...new Set(unexpected.map((s) => s.user))].join(", ")}`);
      status = String(config.unexpectedSeverity ?? "down") === "warn" ? "warn" : "down";
    }
  }

  // Sessions left disconnected for too long: they tie up licences and memory, and
  // keep the user's programs running unattended.
  const maxMinutes = Number(config.disconnectedMaxMinutes);
  if (Number.isFinite(maxMinutes) && maxMinutes > 0) {
    const stale = shown.filter((s) => s.state === "disconnected" && s.disconnectedAt && nowSeconds - s.disconnectedAt > maxMinutes * 60);
    if (stale.length) {
      problems.push(`disconnected over ${maxMinutes} min: ${stale.map((s) => s.user).join(", ")}`);
      if (status !== "down") status = String(config.severity ?? "warn") === "down" ? "down" : "warn";
    }
  }

  return applyThresholds({ status, latencyMs: null, message: problems.length ? `${problems.join(" · ")} — ${summary}` : summary, value: rows.length, details: { columns: ["user", "state", "connection", "from", "signedIn", "idle", "disconnected"], sessions: rows } }, config);
}
