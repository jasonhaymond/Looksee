import type { Status } from "./thresholds.js";

type Result = { status: Status; message: string | null; value?: number | null; details?: unknown; latencyMs: number | null };

// Custom script checks with an expected output. Without any expectation set
// the script's exit code decides (Nagios convention, done by the agent).
// With one, the expectation decides: the output must match and, if an exit
// code is given, the script must exit with it.
export function evaluateScriptOutput<T extends Result>(config: Record<string, unknown>, result: T): T | null {
  const mode = String(config.expectMode ?? "");
  const text = String(config.expectText ?? "");
  const wantExit = config.expectExitCode === undefined || config.expectExitCode === "" || config.expectExitCode === null ? null : Number(config.expectExitCode);
  if ((!mode || mode === "none") && wantExit == null) return null;
  const details = (result.details ?? {}) as { output?: string; exitCode?: number };
  if (details.output === undefined || details.exitCode === undefined) {
    return { ...result, status: "warn", message: "Expected-output matching needs agent 4.0.0+ — update this host's agent" };
  }
  const fail: Status = String(config.expectSeverity ?? "down") === "warn" ? "warn" : "down";
  const out = details.output.replace(/\r\n/g, "\n");
  const problems: string[] = [];
  if (wantExit != null && details.exitCode !== wantExit) problems.push(`exited ${details.exitCode}, expected ${wantExit}`);
  if (mode && mode !== "none") {
    const caseless = config.expectIgnoreCase === true || config.expectIgnoreCase === "true";
    const hay = caseless ? out.toLowerCase() : out;
    const needle = caseless ? text.toLowerCase() : text;
    let ok = true;
    if (mode === "contains") ok = hay.includes(needle);
    else if (mode === "not_contains") ok = !hay.includes(needle);
    else if (mode === "equals") ok = hay.trim() === needle.trim();
    else if (mode === "regex") {
      try {
        ok = new RegExp(text, caseless ? "i" : "").test(out);
      } catch {
        return { ...result, status: "warn", message: `Invalid expected-output regex: ${text}` };
      }
    }
    if (!ok) problems.push(mode === "not_contains" ? `output contains "${text}"` : mode === "equals" ? `output isn't "${text}"` : `output doesn't ${mode === "regex" ? "match" : "contain"} "${text}"`);
  }
  const firstLine = out.split("\n").find((l) => l.trim()) ?? "";
  if (problems.length) return { ...result, status: fail, message: `${problems.join("; ")}${firstLine ? ` — got: ${firstLine.slice(0, 200)}` : ""}` };
  return { ...result, status: "up", message: result.message || firstLine || "Output matched" };
}
