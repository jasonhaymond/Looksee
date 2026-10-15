// Result parser for the release security gate (scripts/security-check.sh).
//
// Where this sits: the gate runs each scanner (Semgrep, ESLint, ShellCheck,
// PSScriptAnalyzer, npm audit, gitleaks, Vitest) and saves its raw output to
// a temporary file. It then calls this script once per scanner to turn that
// output into (1) one summary line — status and a short detail — printed on
// standard output as "STATUS<TAB>detail", and (2) a Markdown section listing
// every finding, written to the file named by --md, which the gate appends to
// the saved report.
//
// Statuses: PASS (nothing blocking), FAIL (something blocking), NOT RUN (the
// scanner's output was missing or unreadable — never silently treated as a
// pass).
//
// Blocking rules, in one place so they're easy to audit:
// - Semgrep, ESLint security rules, ShellCheck, PSScriptAnalyzer: any finding
//   in a file changed since the last release tag blocks, as does any
//   ERROR-severity finding anywhere. Findings in unchanged files are listed as
//   the existing baseline. A reviewed false positive is silenced in the code
//   itself with a comment that states why (`// nosemgrep: <rule> -- reason`,
//   `// eslint-disable-next-line <rule> -- reason`), so the decision is
//   visible in review rather than hidden in a scanner setting.
// - npm audit: any high/critical advisory in a production dependency blocks.
//   In a development-only dependency it blocks unless the advisory is listed
//   in security-accepted-risks.json with a review date that hasn't passed.
// - gitleaks: any finding blocks.
// - Vitest: any failed test blocks.
//
// Usage: node scripts/lib/security-parse.mjs <kind> <input> --md <out.md>
//          [--changed <list.txt>] [--accepted <risks.json>] [--root <repo>]
//          [--prod <prod-audit.json>]

import fs from "node:fs";
import path from "node:path";

// ---- Command-line arguments --------------------------------------------------

const [kind, input, ...rest] = process.argv.slice(2);
// Reads "--name value" pairs into an object, e.g. { md: "out.md" }.
const opts = {};
for (let i = 0; i < rest.length; i += 2) opts[rest[i].replace(/^--/, "")] = rest[i + 1];
const root = path.resolve(opts.root ?? process.cwd());

// Files changed since the last release tag, repo-relative with forward
// slashes, one per line (written by the gate).
const changed = new Set(
  opts.changed && fs.existsSync(opts.changed)
    ? fs.readFileSync(opts.changed, "utf8").split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
    : []
);

/**
 * Turns a path from any scanner (absolute, Windows-style, or prefixed with a
 * container folder) into the repo-relative form used in the changed list.
 *
 * @param p the path as the scanner printed it
 * @param strip an optional leading folder the scanner adds, e.g. "tree/"
 * @returns e.g. "engine/src/app.ts"
 */
function rel(p, strip = "") {
  let s = String(p ?? "").replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/");
  // Case-insensitive prefix match: Windows paths may differ only in case.
  if (s.toLowerCase().startsWith(r.toLowerCase() + "/")) s = s.slice(r.length + 1);
  if (strip && s.startsWith(strip)) s = s.slice(strip.length);
  return s.replace(/^\.\//, "").replace(/^\/src\//, "");
}

/** Reads and parses a JSON file; returns null if it's missing or not JSON. */
function readJson(file) {
  try {
    const text = fs.readFileSync(file, "utf8").trim();
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

/** Escapes a value for a Markdown table cell (pipes and line breaks). */
const cell = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ").slice(0, 300);

/**
 * Prints the summary line, writes the Markdown section, and exits.
 *
 * @param status "PASS", "FAIL" or "NOT RUN"
 * @param detail one short line for the summary table
 * @param md the Markdown body listing the findings
 */
function done(status, detail, md) {
  if (opts.md) fs.writeFileSync(opts.md, md.endsWith("\n") ? md : md + "\n");
  process.stdout.write(`${status}\t${detail}\n`);
  process.exit(0);
}

/**
 * Shared handling for code scanners whose findings carry a file, line, rule
 * and severity: splits them into blocking and baseline, and builds the
 * summary and Markdown table.
 *
 * @param name scanner name for the Markdown text
 * @param findings [{ file, line, rule, severity, message, error }] where
 *        `error` is true for ERROR-severity findings
 * @param extraMd optional Markdown appended after the findings (notes)
 */
function codeFindings(name, findings, extraMd = "") {
  const blocking = findings.filter((f) => f.error || changed.has(f.file));
  const baseline = findings.filter((f) => !blocking.includes(f));
  const table = (rows) =>
    rows.length
      ? ["| Severity | File:line | Rule | Message |", "|---|---|---|---|", ...rows.map((f) => `| ${cell(f.severity)} | ${cell(`${f.file}:${f.line}`)} | ${cell(f.rule)} | ${cell(f.message)} |`)].join("\n")
      : "_None._";
  // Baseline findings are summarised per rule, so a large existing backlog
  // doesn't bury the new ones.
  const byRule = {};
  for (const f of baseline) byRule[f.rule] = (byRule[f.rule] ?? 0) + 1;
  const baselineSummary = Object.entries(byRule)
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `- ${n} × \`${r}\``)
    .join("\n");
  const md = [
    `**Blocking** (in files changed since the last release, or ERROR severity): ${blocking.length}`,
    "",
    table(blocking),
    "",
    `**Existing baseline** (unchanged files, not blocking): ${baseline.length}`,
    "",
    baselineSummary || "_None._",
    "",
    baseline.length ? `<details><summary>All ${baseline.length} baseline findings</summary>\n\n${table(baseline)}\n\n</details>` : "",
    extraMd,
  ].join("\n");
  done(blocking.length ? "FAIL" : "PASS", `${blocking.length} blocking, ${baseline.length} baseline in unchanged files`, md);
}

// ---- Parsers, one per scanner ------------------------------------------------

switch (kind) {
  // Semgrep JSON: { results: [{ path, start: { line }, check_id, extra: { severity, message } }], errors: [...] }
  case "semgrep": {
    const d = readJson(input);
    if (!d || !Array.isArray(d.results)) done("NOT RUN", "no Semgrep output (see the gate's console for the error)", "_Semgrep produced no readable output._");
    const findings = d.results.map((r) => ({
      file: rel(r.path),
      line: r.start?.line,
      rule: String(r.check_id).split(".").pop(),
      severity: r.extra?.severity,
      message: r.extra?.message,
      error: r.extra?.severity === "ERROR",
    }));
    // Rule timeouts mean a file was only partly analysed; reported, not hidden.
    // `type` is a plain string ("Timeout") or a list (["PartialParsing", ...]).
    const errs = (d.errors ?? []).map((e) => `- ${cell((Array.isArray(e.type) ? e.type[0] : e.type) ?? "error")}: ${cell(e.path ?? e.message ?? "")}`);
    if (errs.length) process.stderr.write(`semgrep: ${errs.length} rule errors/timeouts (listed in the report)\n`);
    const extra = errs.length ? `\n**Scanner errors / timeouts** (those files were only partly analysed): ${errs.length}\n\n${errs.join("\n")}` : "";
    codeFindings("Semgrep", findings, extra);
    break;
  }

  // ESLint JSON: [{ filePath, messages: [{ ruleId, severity (1 warn, 2 error), line, message }] }]
  // Only security/* rules are gate items; general lint errors are counted for information.
  case "eslint": {
    const files = [];
    // `input` may list several ESLint outputs separated by commas (engine, dashboard).
    for (const one of String(input).split(",")) {
      const d = readJson(one);
      if (!Array.isArray(d)) done("NOT RUN", `no ESLint output in ${path.basename(one)}`, "_ESLint produced no readable output._");
      files.push(...d);
    }
    const all = files.flatMap((f) => f.messages.map((m) => ({ ...m, file: rel(f.filePath) })));
    const sec = all.filter((m) => String(m.ruleId ?? "").startsWith("security/"));
    const general = all.filter((m) => !String(m.ruleId ?? "").startsWith("security/") && m.severity === 2);
    const findings = sec.map((m) => ({ file: m.file, line: m.line, rule: m.ruleId, severity: m.severity === 2 ? "error" : "warning", message: m.message, error: m.severity === 2 }));
    const note = `\n_General (non-security) lint errors, for information — fix with \`npm run lint\` in engine/ or dashboard/: ${general.length}._`;
    codeFindings("ESLint security rules", findings, note);
    break;
  }

  // ShellCheck gcc format, one finding per line: "file:line:col: warning: message [SC1234]"
  case "shellcheck": {
    if (!fs.existsSync(input)) done("NOT RUN", "no ShellCheck output", "_ShellCheck produced no output file._");
    const findings = fs
      .readFileSync(input, "utf8")
      .split(/\r?\n/)
      // Example match: "scripts/update.sh:12:5: warning: Quote this. [SC2086]"
      .map((l) => l.match(/^(.+?):(\d+):\d+: (\w+): (.*?)(?: \[(SC\d+)\])?$/))
      .filter(Boolean)
      .map((m) => ({ file: rel(m[1]), line: Number(m[2]), severity: m[3], message: m[4], rule: m[5] ?? "shellcheck", error: m[3] === "error" }));
    codeFindings("ShellCheck", findings);
    break;
  }

  // PSScriptAnalyzer JSON (ConvertTo-Json of Invoke-ScriptAnalyzer):
  // [{ ScriptPath, Line, RuleName, Severity (0 Information,1 Warning,2 Error,3 ParseError), Message }]
  case "psscriptanalyzer": {
    let d = readJson(input);
    if (d === null) d = []; // no output at all = no findings (the gate checks the tool ran)
    if (!Array.isArray(d)) d = [d]; // a single finding serialises as an object, not a list
    const sev = (s) => (typeof s === "number" ? ["Information", "Warning", "Error", "ParseError"][s] : String(s));
    const findings = d.map((f) => ({ file: rel(f.ScriptPath), line: f.Line, rule: f.RuleName, severity: sev(f.Severity), message: f.Message, error: /Error/.test(sev(f.Severity)) }));
    codeFindings("PSScriptAnalyzer", findings);
    break;
  }

  // npm audit JSON (npm 7+): { vulnerabilities: { pkg: { severity, via: [advisory | "pkg"] } } }.
  // `input` is the full audit; --prod is the same audit with dev dependencies left out.
  case "npm-audit": {
    const all = readJson(input);
    const prod = readJson(opts.prod);
    if (!all?.vulnerabilities || !prod?.vulnerabilities) done("NOT RUN", "npm audit gave no readable result (offline?)", "_npm audit produced no readable output._");
    // Accepted risks: [{ id: "GHSA-...", package, reason, acceptedBy, acceptedOn, reviewBy: "YYYY-MM-DD" }]
    const accepted = readJson(opts.accepted)?.accepted ?? [];
    const today = new Date().toISOString().slice(0, 10);
    // Collects each distinct advisory (the objects in `via`; strings just
    // point at another vulnerable package) with the packages it affects.
    const advisories = (audit) => {
      const map = new Map();
      for (const [pkg, v] of Object.entries(audit.vulnerabilities)) {
        for (const a of v.via ?? []) {
          if (typeof a !== "object") continue;
          const id = String(a.url ?? a.source).split("/").pop();
          const entry = map.get(id) ?? { id, title: a.title, severity: a.severity, range: a.range, packages: new Set() };
          entry.packages.add(pkg);
          map.set(id, entry);
        }
      }
      return [...map.values()];
    };
    const prodIds = new Set(advisories(prod).map((a) => a.id));
    const rows = advisories(all).map((a) => {
      const inProd = prodIds.has(a.id);
      const acc = accepted.find((x) => x.id === a.id);
      const high = a.severity === "high" || a.severity === "critical";
      // An accepted risk only counts while its review date hasn't passed,
      // and never for a production dependency.
      const acceptedNow = acc && !inProd && (!acc.reviewBy || acc.reviewBy >= today);
      const status = !high ? "listed" : inProd ? "BLOCKING (production)" : acceptedNow ? `accepted until ${acc.reviewBy}` : acc ? `BLOCKING (acceptance expired ${acc.reviewBy})` : "BLOCKING (dev, not accepted)";
      return { ...a, inProd, status };
    });
    const blocking = rows.filter((r) => r.status.startsWith("BLOCKING"));
    const md = rows.length
      ? ["| Advisory | Severity | Scope | Packages | Status |", "|---|---|---|---|---|", ...rows.map((r) => `| [${cell(r.id)}](https://github.com/advisories/${r.id}) ${cell(r.title)} | ${r.severity} | ${r.inProd ? "production" : "dev only"} | ${cell([...r.packages].join(", "))} | ${cell(r.status)} |`)].join("\n")
      : "_No advisories._";
    const counts = all.metadata?.vulnerabilities ?? {};
    done(blocking.length ? "FAIL" : "PASS", `prod: ${prod.metadata?.vulnerabilities?.total ?? 0} vulns; all: ${counts.critical ?? 0} critical, ${counts.high ?? 0} high, ${counts.moderate ?? 0} moderate; ${blocking.length} blocking`, md);
    break;
  }

  // gitleaks JSON reports from one or more scans: [{ File, StartLine, RuleID, Description }]
  // (the secret itself is redacted by the gate's --redact flag and never printed).
  case "gitleaks": {
    const findings = [];
    for (const one of String(input).split(",")) {
      const d = readJson(one);
      if (!Array.isArray(d)) done("NOT RUN", `no gitleaks report from ${path.basename(one)}`, "_gitleaks produced no readable report._");
      findings.push(...d.map((f) => ({ ...f, scan: path.basename(one, ".json") })));
    }
    const md = findings.length
      ? ["| Scan | File:line | Rule | Description |", "|---|---|---|---|", ...findings.map((f) => `| ${f.scan} | ${cell(`${rel(f.File, "tree/")}:${f.StartLine}`)} | ${cell(f.RuleID)} | ${cell(f.Description)} |`)].join("\n")
      : "_No secrets found._";
    done(findings.length ? "FAIL" : "PASS", `${findings.length} finding(s)`, md);
    break;
  }

  // Vitest JSON reporter: { numTotalTests, numFailedTests, testResults: [{ name, status, assertionResults: [{ status, fullName }] }] }
  case "vitest": {
    const d = readJson(input);
    if (!d || typeof d.numTotalTests !== "number") done("NOT RUN", "no Vitest results", "_Vitest produced no readable results._");
    const rows = d.testResults.map((f) => {
      const passed = f.assertionResults.filter((a) => a.status === "passed").length;
      const failed = f.assertionResults.filter((a) => a.status === "failed");
      // Anything neither passed nor failed: skipped, pending or todo tests.
      const skipped = f.assertionResults.filter((a) => a.status !== "passed" && a.status !== "failed");
      // A file whose setup itself failed (e.g. beforeAll threw) has status
      // "failed" even if no individual test is marked failed.
      return { file: rel(f.name), passed, failed, skipped, fileFailed: f.status === "failed", fileMessage: f.message };
    });
    const skippedTotal = rows.reduce((n, r) => n + r.skipped.length, 0);
    const brokenFiles = rows.filter((r) => r.fileFailed && !r.failed.length);
    // Test files are listed one per row, so each security area (auth,
    // security, multi-site, ...) shows its own result.
    const md = [
      "| Test file | Passed | Failed | Skipped |",
      "|---|---|---|---|",
      ...rows.map((r) => `| ${cell(r.file)} | ${r.passed} | ${r.failed.length} | ${r.skipped.length} |`),
      "",
      // Each failure with the first line of its error, so the report alone
      // says what went wrong; skips are listed too, never hidden in a count.
      ...rows.flatMap((r) => r.failed.map((a) => `- FAILED: ${cell(r.file)} — ${cell(a.fullName)}: ${cell(String(a.failureMessages?.[0] ?? "").split("\n")[0])}`)),
      ...brokenFiles.map((r) => `- FILE FAILED: ${cell(r.file)} — ${cell(String(r.fileMessage ?? "").split("\n")[0])}`),
      ...rows.flatMap((r) => r.skipped.map((a) => `- ${a.status.toUpperCase()}: ${cell(r.file)} — ${cell(a.fullName)}`)),
    ].join("\n");
    const failing = d.numFailedTests || brokenFiles.length;
    done(failing ? "FAIL" : "PASS", `${d.numPassedTests}/${d.numTotalTests} passed${d.numFailedTests ? `, ${d.numFailedTests} failed` : ""}${skippedTotal ? `, ${skippedTotal} skipped (listed)` : ""} in ${rows.length} files`, md);
    break;
  }

  default:
    process.stderr.write(`security-parse: unknown kind "${kind}"\n`);
    process.exit(2);
}
