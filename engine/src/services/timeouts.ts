// How a timeout is judged. A check that gets no answer in time (ping with no
// reply, a TCP/HTTP/SNMP request that timed out) is often just a busy or
// briefly overloaded machine — the engine host, or the agent/collector that
// ran the check — rather than the device being down. So a timeout first
// reports WARN, and only becomes DOWN when it keeps happening: after
// `timeoutsBeforeDown` timeouts in a row (default 3, set per check; 1 means
// "down at the first timeout", the behaviour before 5.3).
//
// Where this sits: alerting.ts's recordCheckResult calls judgeTimeout on
// every result before storing it, so the rule is the same for checks run by
// the engine, an agent, or a site collector. Only "down" results whose
// message reads like a timeout are touched; a refused connection, a wrong
// HTTP status, a threshold breach etc. stay down immediately.

import { own } from "../lib/own.js";
import type { ResultInput } from "./alerting.js";

/** Used when a check has no `timeoutsBeforeDown` of its own. */
export const DEFAULT_TIMEOUTS_BEFORE_DOWN = 3;
/** The setting is clamped to 1–20 so a typo can't make a dead device warn forever. */
const MAX_TIMEOUTS_BEFORE_DOWN = 20;

// Matches the wording every probe uses for "no answer in time", whichever
// side ran it. The `i` flag ignores case; `\b` is a word boundary.
// Examples it matches: "Timed out connecting to 10.0.0.5:443",
// "Request timed out", "RequestTimedOutError" (SNMP), "No reply from nas",
// "No UDP reply from …", "SNMP: No response", "read udp …: i/o timeout"
// and "context deadline exceeded" (Go agent), "connect ETIMEDOUT".
// Not matched: "connect ECONNREFUSED", "HTTP 500", "getaddrinfo ENOTFOUND".
const TIMEOUT_PATTERN = /timed ?out|\btimeout\b|ETIMEDOUT|deadline exceeded|\bno (udp )?(reply|response)\b/i;

// Types whose message is someone else's text (a script's output, a log or
// event line, a pushed value) or whose "no answer" is the very thing being
// watched (heartbeats) — a timeout-sounding word there is not a probe
// timeout, so their result is never softened.
const EXEMPT_TYPES = new Set([
  "agent_script",
  "agent_log",
  "agent_eventlog",
  "agent_journal",
  "trap_match",
  "syslog_match",
  "push_value",
  "heartbeat",
  "agent_heartbeat",
  "calculated",
  "anomaly",
]);

/** True when a result message describes a probe getting no answer in time. */
export function isTimeoutMessage(message: string | null | undefined): boolean {
  return Boolean(message && TIMEOUT_PATTERN.test(message));
}

/**
 * The check's "timeouts in a row before down" setting, clamped to 1–20.
 * A blank, missing or non-numeric value falls back to the default of 3.
 */
export function timeoutsBeforeDown(config: Record<string, unknown> | null | undefined): number {
  const raw = config ? own(config, "timeoutsBeforeDown") : undefined;
  const n = raw === "" || raw == null ? NaN : Math.floor(Number(raw));
  if (!Number.isFinite(n)) return DEFAULT_TIMEOUTS_BEFORE_DOWN;
  return Math.min(MAX_TIMEOUTS_BEFORE_DOWN, Math.max(1, n));
}

/**
 * Decides what a new result should really say when it is a timeout.
 *
 * @param check the check's type and config (for the exemptions and setting)
 * @param input the result as the probe reported it
 * @param recent the check's latest stored results, newest first — at least
 *   `timeoutsBeforeDown - 1` of them, so the run of earlier timeouts can be counted
 * @returns the input unchanged when it isn't a timeout (or the type is
 *   exempt); otherwise a copy with status WARN and a message saying how many
 *   more timeouts lead to DOWN — or status DOWN once the run is long enough.
 *   No side effects; the caller stores what this returns.
 */
export function judgeTimeout(
  check: { type: string; config: unknown },
  input: ResultInput,
  recent: { status: string; message: string | null }[]
): ResultInput {
  // Only a down result that reads like a timeout is ever changed.
  if (input.status !== "down" || EXEMPT_TYPES.has(check.type) || !isTimeoutMessage(input.message)) return input;
  const limit = timeoutsBeforeDown(check.config as Record<string, unknown>);
  if (limit <= 1) return input;

  // Count the unbroken run of earlier timeouts (warn or down, timeout
  // wording) right before this one; any other result ends the run.
  let earlier = 0;
  for (const r of recent) {
    if ((r.status !== "warn" && r.status !== "down") || !isTimeoutMessage(r.message)) break;
    earlier++;
    if (earlier >= limit - 1) break;
  }
  const inARow = earlier + 1;
  if (inARow >= limit) return { ...input, status: "down", message: `No response ${limit} times in a row — ${input.message}` };
  return { ...input, status: "warn", message: `Timeout ${inARow} of ${limit} before down — ${input.message}` };
}
