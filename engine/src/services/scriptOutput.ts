// Judges a custom script check's output on the engine (the agent only runs the
// script and reports its output and exit code — CLAUDE.md: thresholds and
// judgements are always the engine's job).
//
// Two independent settings, both optional:
// - Expected output: the output must contain / not contain / equal / match a
//   pattern (and, optionally, the script must exit with a given code);
//   anything else is a failure with the chosen status.
// - Alert patterns: "warn if the output contains/matches X" and "down if the
//   output contains/matches Y" — for scripts whose output names a problem
//   ("DEGRADED", "ERROR: …") rather than confirming success. The down pattern
//   wins when both match.
// The final status is the worse of the two settings' verdicts.
//
// Patterns run on RE2 (lib/userRegex.ts), which has no catastrophic
// backtracking — a pattern typed into the dashboard can't hang the engine.

import { worst, type Status } from "./thresholds.js";
import { compileUserRegex } from "../lib/userRegex.js";

type Result = { status: Status; message: string | null; value?: number | null; details?: unknown; latencyMs: number | null };

/** True for a checkbox that's ticked (stored as a boolean or as "true"). */
const ticked = (v: unknown) => v === true || v === "true";

/**
 * Applies a custom script check's expected-output and alert-pattern settings
 * to the result its agent reported.
 *
 * @param config the check's settings: expectMode/expectText/expectIgnoreCase/
 *   expectExitCode/expectSeverity (expected output) and warnIfMatches/
 *   downIfMatches/alertMatchMode/alertIgnoreCase (alert patterns)
 * @param result what the agent reported; details carries `output` and
 *   `exitCode` from agent 4.0 on
 * @returns the judged result, or null when neither setting is used (the
 *   script's own exit code then decides, Nagios-style, as the agent set it)
 */
export function evaluateScriptOutput<T extends Result>(config: Record<string, unknown>, result: T): T | null {
  const mode = String(config.expectMode ?? "");
  const text = String(config.expectText ?? "");
  const wantExit = config.expectExitCode === undefined || config.expectExitCode === "" || config.expectExitCode === null ? null : Number(config.expectExitCode);
  const warnPattern = String(config.warnIfMatches ?? "");
  const downPattern = String(config.downIfMatches ?? "");
  const expecting = (mode && mode !== "none") || wantExit != null;
  const alerting = Boolean(warnPattern || downPattern);
  if (!expecting && !alerting) return null;

  // Both settings need the full output, which agents before 4.0 don't send.
  const details = (result.details ?? {}) as { output?: string; exitCode?: number };
  if (details.output === undefined || details.exitCode === undefined) {
    return { ...result, status: "warn", message: "Matching a script's output needs agent 4.0.0+ — update this endpoint's agent" };
  }
  const out = details.output.replace(/\r\n/g, "\n");
  const firstLine = out.split("\n").find((l) => l.trim()) ?? "";
  const got = firstLine ? ` — got: ${firstLine.slice(0, 200)}` : "";

  // Step 1 — expected output (if set): a mismatch fails with the chosen
  // status; a match is "up". Without it, the script's exit code (as the
  // agent already judged it) stands.
  let judged: T = result;
  if (expecting) {
    const fail: Status = String(config.expectSeverity ?? "down") === "warn" ? "warn" : "down";
    const problems: string[] = [];
    if (wantExit != null && details.exitCode !== wantExit) problems.push(`exited ${details.exitCode}, expected ${wantExit}`);
    if (mode && mode !== "none") {
      const caseless = ticked(config.expectIgnoreCase);
      const hay = caseless ? out.toLowerCase() : out;
      const needle = caseless ? text.toLowerCase() : text;
      let ok = true;
      if (mode === "contains") ok = hay.includes(needle);
      else if (mode === "not_contains") ok = !hay.includes(needle);
      else if (mode === "equals") ok = hay.trim() === needle.trim();
      else if (mode === "regex") {
        try {
          ok = compileUserRegex(text, { ignoreCase: caseless }).test(out);
        } catch {
          return { ...result, status: "warn", message: `Invalid expected-output regex: ${text}` };
        }
      }
      if (!ok) problems.push(mode === "not_contains" ? `output contains "${text}"` : mode === "equals" ? `output isn't "${text}"` : `output doesn't ${mode === "regex" ? "match" : "contain"} "${text}"`);
    }
    judged = problems.length ? { ...result, status: fail, message: `${problems.join("; ")}${got}` } : { ...result, status: "up", message: result.message || firstLine || "Output matched" };
  }

  // Step 2 — alert patterns (if set): down first, then warn. The result is
  // the worse of step 1's status and the pattern's.
  if (alerting) {
    const regex = String(config.alertMatchMode ?? "contains") === "regex";
    const caseless = ticked(config.alertIgnoreCase);
    for (const [pattern, status] of [
      [downPattern, "down"],
      [warnPattern, "warn"],
    ] as const) {
      if (!pattern) continue;
      // Regex mode runs on RE2 (no catastrophic backtracking); text mode is
      // a plain substring search.
      let hit: boolean;
      if (regex) {
        try {
          hit = compileUserRegex(pattern, { ignoreCase: caseless }).test(out);
        } catch {
          return { ...result, status: "warn", message: `Invalid alert pattern regex: ${pattern}` };
        }
      } else {
        hit = caseless ? out.toLowerCase().includes(pattern.toLowerCase()) : out.includes(pattern);
      }
      if (hit) {
        const message = `output ${regex ? "matches" : "contains"} "${pattern}"${got}`;
        const combined = worst(judged.status, status);
        // A step-1 failure that's at least as bad keeps its own message.
        return combined === judged.status && judged.status !== "up" ? judged : { ...judged, status: combined, message };
      }
    }
  }
  return judged;
}
