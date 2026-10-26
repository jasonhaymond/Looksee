#!/usr/bin/env bash
# Release security gate: runs every security check this project has, prints a
# PASS / FAIL / NOT RUN summary, and saves a full report to security-reports/
# (gitignored — reports describe unpatched weaknesses and the repo is public).
#
# Where this sits: the global development standards require this gate before
# every commit, push, tag or deploy, with the results shown to the developer
# and approved by them. Run it from a development machine with Docker, Node
# and the project's dependencies installed (`npm ci` in engine/ and
# dashboard/). The approval is then recorded in the release's annotated git
# tag, which scripts/update.sh checks before deploying (see
# scripts/verify-release-tag.sh).
#
# Usage:
#   scripts/security-check.sh                  # full pre-release gate
#   scripts/security-check.sh --since v4.1.0   # compare against a specific tag
#   scripts/security-check.sh --live https://looksee.example.com
#                                              # post-deploy checks only
#   (also: `npm run security` in engine/)
#
# What it runs (each reported individually; a tool that can't run is NOT RUN,
# never silently skipped or counted as a pass):
#   1. Static analysis — Semgrep (OWASP Top 10, TypeScript, Node, Go and
#      secrets rulesets), ESLint with eslint-plugin-security (engine and
#      dashboard), ShellCheck (every .sh), PSScriptAnalyzer (every .ps1),
#      go vet (agent).
#   2. Dependency vulnerabilities — npm audit (engine, dashboard) and
#      govulncheck (agent). Plus `npm outdated` for currency (information only).
#   3. Secret scanning — gitleaks over the working tree, the staged diff, and
#      every commit since the last release tag.
#   4. Project tests — the engine's Vitest suite against the real local test
#      database (includes the security tests), the agent's Go tests, and
#      TypeScript typechecks of engine and dashboard.
#   5. AI-assisted diff review — can't be scripted; always listed as a manual
#      step (run /security-review in Claude Code on the pending change).
#
# What blocks (FAIL): see the rules at the top of scripts/lib/security-parse.mjs.
# In short: new findings in files changed since the last release tag, any
# ERROR-severity finding, any high/critical advisory in a production
# dependency (or an unaccepted/expired one in a dev dependency — see
# security-accepted-risks.json), any secret, any failed test or typecheck.
# Exit code: 0 if nothing failed, 1 if anything failed, 2 for bad usage.
#
# Docker note: scanners run in pinned Docker images. Source files are streamed
# into each container as a tar archive rather than bind-mounted, which avoids
# Docker Desktop's slow file sharing from synced (Nextcloud/OneDrive) folders
# on Windows. A full run takes about 8–9 minutes, most of it Semgrep's rule
# sets (~6 minutes). Only `--live` mode works without Docker.

# -u: using an unset variable is an error; -o pipefail: a pipeline fails if
# any part fails. Not -e: one failing check must not stop the others.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT" || exit 2

# Pinned scanner images (update deliberately, then re-run the gate).
SEMGREP_IMAGE="semgrep/semgrep:1.180.0"
GITLEAKS_IMAGE="zricethezav/gitleaks:v8.30.1"
SHELLCHECK_IMAGE="koalaman/shellcheck-alpine:v0.11.0"
GO_IMAGE="golang:1.27"

# Prints the "Usage:" block from the header comment above.
usage() {
  sed -n '/^# Usage:/,/^#   (also/p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---- Arguments --------------------------------------------------------------
SINCE=""
LIVE_URL=""
while [ $# -gt 0 ]; do
  case "$1" in
    --since) [ $# -ge 2 ] || { echo "--since needs a git ref" >&2; exit 2; }; SINCE="$2"; shift 2 ;;
    --live) [ $# -ge 2 ] || { echo "--live needs a URL" >&2; exit 2; }; LIVE_URL="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

# ---- Shared helpers ---------------------------------------------------------

# Scratch space for raw scanner output; removed however the script exits.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
SECTIONS="$TMP/sections.md"
: > "$SECTIONS"

# Parallel lists of results: check name, status, one-line detail.
R_NAME=(); R_STATUS=(); R_DETAIL=()
FAILED=0

# Records one check's result and echoes it as it happens, with the seconds
# since the gate started ($SECONDS is bash's built-in counter), so progress
# and slow steps are visible during a long run.
record() {
  R_NAME+=("$1"); R_STATUS+=("$2"); R_DETAIL+=("$3")
  [ "$2" = "FAIL" ] && FAILED=1
  printf '  %-8s %-34s %s  [%ss]\n' "$2" "$1" "$3" "$SECONDS"
}

# Appends a titled section (from a Markdown file or literal text) to the report.
add_section() {
  printf '\n## %s\n\n' "$1" >> "$SECTIONS"
  if [ -f "${2:-}" ]; then cat "$2" >> "$SECTIONS"; else printf '%s\n' "${2:-}" >> "$SECTIONS"; fi
}

# Node on Windows can't open Git Bash-style paths (/tmp/...) unless the shell
# converts them, which it only does for a path that is a whole argument — not
# one inside a comma-separated list. This converts each list item to the
# native form (cygpath exists only under Git Bash/Cygwin; elsewhere the paths
# pass through unchanged).
native() {
  if have cygpath; then
    local out="" part
    IFS=',' read -r -a parts <<<"$1"
    for part in "${parts[@]}"; do out+="${out:+,}$(cygpath -m "$part")"; done
    printf '%s' "$out"
  else
    printf '%s' "$1"
  fi
}

# Runs the result parser for one scanner and records its verdict.
# $1 check name, $2 parser kind, $3 input file(s), rest = extra parser options.
parse_and_record() {
  local name="$1" kind="$2" input="$3"; shift 3
  local md="$TMP/$kind-$RANDOM.md" line status detail
  line="$(node scripts/lib/security-parse.mjs "$kind" "$(native "$input")" --md "$(native "$md")" --changed "$(native "$TMP/changed.txt")" --root "$REPO_ROOT" "$@")"
  status="${line%%$'\t'*}"; detail="${line#*$'\t'}"
  [ -n "$status" ] || { status="NOT RUN"; detail="result parser failed"; }
  record "$name" "$status" "$detail"
  add_section "$name" "$md"
}

have() { command -v "$1" >/dev/null 2>&1; }

# Wraps text in a Markdown code block. The fence is built from character codes
# (three backticks) so no literal backticks sit in quotes, which ShellCheck
# would misread as command substitution.
FENCE=$'\x60\x60\x60'
fenced() { printf '%s\n%s\n%s' "$FENCE" "$1" "$FENCE"; }

# Docker on Windows (Git Bash) rewrites arguments that look like paths;
# MSYS_NO_PATHCONV stops that. Harmless on Linux/macOS.
dockr() { MSYS_NO_PATHCONV=1 docker "$@"; }

# Lists files that exist in the working tree under the given paths: tracked
# ones plus new untracked ones, never gitignored ones (so .env files and
# node_modules are never sent anywhere).
repo_files() {
  git ls-files -co --exclude-standard -- "$@" | while IFS= read -r f; do [ -f "$f" ] && printf '%s\n' "$f"; done
}

# Packs the listed files (one path per line on stdin) into a tar stream.
tar_list() { tar -cf - -T -; }

# ---- Post-deploy mode -------------------------------------------------------
# Checks a running instance from the outside, the way an attacker would see
# it. Needs only curl. Sends one deliberately empty sign-in request (answered
# 400 before any password is checked, so it records no failed sign-in and
# can't trigger a lockout) and otherwise only reads.
live_checks() {
  local url="${LIVE_URL%/}" h body code
  echo "Post-deploy security checks against $url"
  case "$url" in
    https://*) record "HTTPS URL" "PASS" "served over HTTPS" ;;
    *) record "HTTPS URL" "FAIL" "not an https:// URL — production must be HTTPS only" ;;
  esac

  # Health endpoint: up, database reachable, and which version answered.
  body="$(curl -s --max-time 15 "$url/api/health" || true)"
  if printf '%s' "$body" | grep -q '"status":"ok"'; then
    record "Health endpoint" "PASS" "$(printf '%s' "$body" | grep -o '"version":"[^"]*"' || echo "ok")"
  else
    record "Health endpoint" "FAIL" "no ok status from /api/health: ${body:-no response}"
  fi

  # TLS: curl verifies the certificate chain and hostname by default; this
  # fails on an expired, self-signed or wrong-name certificate.
  if [[ "$url" == https://* ]]; then
    if curl -s --max-time 15 -o /dev/null "$url/api/health"; then
      record "TLS certificate" "PASS" "valid chain and hostname"
    else
      record "TLS certificate" "FAIL" "curl rejected the certificate (expired, self-signed or wrong name)"
    fi
  fi

  # Security headers on the dashboard (/) and the API.
  h="$(curl -s --max-time 15 -D - -o /dev/null "$url/" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  local missing=""
  [[ "$url" == https://* ]] && ! grep -q '^strict-transport-security:' <<<"$h" && missing+=" HSTS"
  grep -q '^x-content-type-options: nosniff' <<<"$h" || missing+=" X-Content-Type-Options"
  grep -qE "^content-security-policy:.*frame-ancestors 'none'|^x-frame-options: deny" <<<"$h" || missing+=" frame-ancestors/X-Frame-Options"
  grep -q '^x-powered-by:' <<<"$h" && missing+=" (X-Powered-By present)"
  if [ -z "$missing" ]; then record "Security headers (dashboard)" "PASS" "$([[ "$url" == https://* ]] && echo "HSTS, ")nosniff, framing blocked"; else record "Security headers (dashboard)" "FAIL" "missing:$missing"; fi
  h="$(curl -s --max-time 15 -D - -o /dev/null "$url/api/health" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  missing=""
  grep -q '^x-content-type-options: nosniff' <<<"$h" || missing+=" X-Content-Type-Options"
  grep -q '^x-frame-options: deny' <<<"$h" || missing+=" X-Frame-Options"
  grep -q '^x-powered-by:' <<<"$h" && missing+=" (X-Powered-By present)"
  if [ -z "$missing" ]; then record "Security headers (API)" "PASS" "nosniff, X-Frame-Options, no X-Powered-By"; else record "Security headers (API)" "FAIL" "missing:$missing"; fi

  # Protected endpoints must refuse an anonymous request with 401.
  local bad=""
  for p in /api/checks /api/hosts /api/endpoints /api/channels /api/security/overview /api/backups/settings /api/logs /api/maintenance /api/watchdog; do
    code="$(curl -s --max-time 15 -o /dev/null -w '%{http_code}' "$url$p")"
    [ "$code" = "401" ] || bad+=" $p→$code"
  done
  if [ -z "$bad" ]; then record "Auth required on admin API" "PASS" "9 admin routes answer 401 without a session"; else record "Auth required on admin API" "FAIL" "not 401:$bad"; fi

  # CORS: a foreign website's origin must not be granted access.
  h="$(curl -s --max-time 15 -D - -o /dev/null -H 'Origin: https://attacker.example' "$url/api/health" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  # No headers at all means no answer — that must not read as "restricted".
  if [ -z "$h" ]; then
    record "CORS restricted" "FAIL" "no response from $url/api/health"
  elif grep -qE '^access-control-allow-origin: (\*|https://attacker\.example)' <<<"$h"; then
    record "CORS restricted" "FAIL" "a foreign origin was allowed"
  else
    record "CORS restricted" "PASS" "foreign origin not allowed"
  fi

  # Rate limiting on sign-in: the limiter announces itself with RateLimit-*
  # headers. One empty request, answered 400 without checking any password.
  h="$(curl -s --max-time 15 -D - -o /dev/null -X POST -H 'Content-Type: application/json' -d '{}' "$url/api/auth/login" | tr -d '\r' | tr '[:upper:]' '[:lower:]')"
  if grep -q '^ratelimit-limit:' <<<"$h"; then record "Sign-in rate limiting" "PASS" "$(grep '^ratelimit-limit:' <<<"$h")"; else record "Sign-in rate limiting" "FAIL" "no RateLimit headers on /api/auth/login"; fi
}

# ---- Report writer ----------------------------------------------------------
write_report() {
  local file="$1" title="$2"
  mkdir -p security-reports
  {
    echo "# $title"
    echo
    echo "$HEADER"
    echo
    echo "| Check | Result | Detail |"
    echo "|---|---|---|"
    for i in "${!R_NAME[@]}"; do echo "| ${R_NAME[$i]} | ${R_STATUS[$i]} | ${R_DETAIL[$i]//|/\\|} |"; done
    cat "$SECTIONS"
  } > "$file"
}

TS="$(date +%Y%m%d-%H%M%S)"

if [ -n "$LIVE_URL" ]; then
  have curl || { echo "curl is required for --live" >&2; exit 2; }
  HEADER="Target: $LIVE_URL · $(date '+%Y-%m-%d %H:%M %Z')"
  live_checks
  HOST="$(printf '%s' "$LIVE_URL" | sed -E 's#^https?://##; s#[/:].*##')"
  REPORT="security-reports/live-$HOST-$TS.md"
  write_report "$REPORT" "Post-deploy security check — $HOST"
  echo; echo "Report: $REPORT"
  [ "$FAILED" = 0 ] && echo "RESULT: PASS" || echo "RESULT: FAIL"
  exit "$FAILED"
fi

# ---- Pre-release gate -------------------------------------------------------

have node || { echo "Node.js is required (it parses scanner output)." >&2; exit 2; }
VERSION="$(node -p "require('./engine/package.json').version")"
SHA="$(git rev-parse --short HEAD)"
DIRTY=""; [ -n "$(git status --porcelain)" ] && DIRTY="-dirty"

# The release to compare against: the newest v* tag at or before this commit.
# Re-checking a committed release (clean tree, HEAD is the tagged release)
# compares against the release before it instead, so its own changes count.
if [ -z "$SINCE" ]; then
  if [ -z "$DIRTY" ] && [ -n "$(git tag --points-at HEAD --list 'v*')" ]; then
    SINCE="$(git describe --tags --abbrev=0 --match 'v*' HEAD^ 2>/dev/null || true)"
  else
    SINCE="$(git describe --tags --abbrev=0 --match 'v*' HEAD 2>/dev/null || true)"
  fi
fi
[ -n "$SINCE" ] || SINCE="$(git rev-list --max-parents=0 HEAD | tail -1)"

# Files changed since that release (committed or not), plus new files —
# the set where findings block.
{ git diff --name-only "$SINCE" --; git ls-files -o --exclude-standard; } | sort -u > "$TMP/changed.txt"

HEADER="Version $VERSION · commit $SHA$DIRTY · compared with $SINCE ($(wc -l < "$TMP/changed.txt" | tr -d ' ') changed files) · $(date '+%Y-%m-%d %H:%M %Z')"
echo "Security gate — $HEADER"
echo

DOCKER_OK=0
if have docker && docker info >/dev/null 2>&1; then DOCKER_OK=1; fi
nodocker() { record "$1" "NOT RUN" "Docker isn't available"; }

# 1a. Semgrep over engine, dashboard and agent source (tests excluded: they
# hold deliberate attack strings and fixtures, and aren't shipped).
if [ "$DOCKER_OK" = 1 ]; then
  repo_files engine/src engine/scripts dashboard/app agent scripts | grep -E '\.(ts|tsx|mjs|js|go)$' | grep -vE '(\.test\.ts|_test\.go)$' \
    | tar_list | dockr run -i --rm "$SEMGREP_IMAGE" sh -c 'mkdir -p /src && cd /src && tar -xf - && semgrep scan --config p/owasp-top-ten --config p/typescript --config p/nodejsscan --config p/golang --config p/secrets --metrics=off --quiet --json --timeout 60 .' \
    > "$TMP/semgrep.json" 2> "$TMP/semgrep.err"
  parse_and_record "SAST: Semgrep" semgrep "$TMP/semgrep.json"
else nodocker "SAST: Semgrep"; fi

# 1b. ESLint with the security plugin, in each workspace (needs `npm ci` done).
ESL=""
for ws in engine dashboard; do
  if [ -d "$ws/node_modules/eslint-plugin-security" ]; then
    (cd "$ws" && npx --no-install eslint . -f json -o "$TMP/eslint-$ws.json" >/dev/null 2>"$TMP/eslint-$ws.err")
    ESL+="${ESL:+,}$TMP/eslint-$ws.json"
  fi
done
if [ -n "$ESL" ]; then parse_and_record "SAST: ESLint security rules" eslint "$ESL"
else record "SAST: ESLint security rules" "NOT RUN" "run npm ci in engine/ and dashboard/ first"; fi

# 1c. ShellCheck on every shell script, in its own image (or a local copy).
repo_files . | grep -E '\.sh$' > "$TMP/sh.txt"
if have shellcheck; then
  xargs -a "$TMP/sh.txt" -d '\n' shellcheck -f gcc > "$TMP/shellcheck.txt" 2>&1
  parse_and_record "SAST: ShellCheck" shellcheck "$TMP/shellcheck.txt"
elif [ "$DOCKER_OK" = 1 ]; then
  tar_list < "$TMP/sh.txt" | dockr run -i --rm --entrypoint sh "$SHELLCHECK_IMAGE" -c 'mkdir -p /src && cd /src && tar -xf - && find . -name "*.sh" | sed "s#^\./##" | xargs shellcheck -f gcc -x' > "$TMP/shellcheck.txt" 2>&1
  parse_and_record "SAST: ShellCheck" shellcheck "$TMP/shellcheck.txt"
else nodocker "SAST: ShellCheck"; fi

# 1d. PSScriptAnalyzer on the agent's PowerShell installers (needs PowerShell 7
# with the module: Install-Module PSScriptAnalyzer -Scope CurrentUser).
if have pwsh && pwsh -NoProfile -Command 'if (Get-Module -ListAvailable PSScriptAnalyzer) { exit 0 } else { exit 1 }' >/dev/null 2>&1; then
  pwsh -NoProfile -Command "\$r = Get-ChildItem -Recurse -Filter *.ps1 -Path agent, scripts -ErrorAction SilentlyContinue | ForEach-Object { Invoke-ScriptAnalyzer -Path \$_.FullName -Severity Warning,Error,ParseError }; if (\$r) { \$r | Select-Object ScriptPath, Line, RuleName, Severity, Message | ConvertTo-Json -Depth 3 }" > "$TMP/pssa.json" 2> "$TMP/pssa.err"
  parse_and_record "SAST: PSScriptAnalyzer" psscriptanalyzer "$TMP/pssa.json"
else record "SAST: PSScriptAnalyzer" "NOT RUN" "PowerShell 7 + PSScriptAnalyzer not installed"; fi

# 1e/2b/4b. The agent: go vet (static checks), go test, govulncheck (known
# vulnerabilities in the Go modules and standard library actually called).
# Named volumes cache downloaded modules between runs.
if [ "$DOCKER_OK" = 1 ]; then
  # shellcheck disable=SC2016  # single quotes on purpose: $ expands inside the container / awk, not here
  repo_files agent | grep -vE '^agent/bin/' | tar_list | dockr run -i --rm -v looksee-gomod:/go/pkg/mod -v looksee-gocache:/root/.cache/go-build "$GO_IMAGE" sh -c '
    mkdir -p /src && cd /src && tar -xf - && cd agent
    go vet ./... > /tmp/vet.txt 2>&1; echo "VET_EXIT=$?"
    go test ./... > /tmp/test.txt 2>&1; echo "TEST_EXIT=$?"
    # Installed, then run directly: "go run" turns any non-zero exit of the
    # program into its own exit 1, which hid govulncheck'"'"'s 3 ("found
    # vulnerabilities") and made a real finding look like "couldn'"'"'t run".
    { go install golang.org/x/vuln/cmd/govulncheck@latest && "$(go env GOPATH)/bin/govulncheck" ./...; } > /tmp/vuln.txt 2>&1; echo "VULN_EXIT=$?"
    for f in vet test vuln; do echo "==== $f"; cat /tmp/$f.txt; done' > "$TMP/go.txt" 2>&1
  vexit="$(grep -o 'VET_EXIT=[0-9]*' "$TMP/go.txt" | cut -d= -f2)"
  texit="$(grep -o 'TEST_EXIT=[0-9]*' "$TMP/go.txt" | cut -d= -f2)"
  gexit="$(grep -o 'VULN_EXIT=[0-9]*' "$TMP/go.txt" | cut -d= -f2)"
  # Each Go step: exit 0 = clean; govulncheck exits 3 when it finds a vulnerability.
  case "$vexit" in 0) record "SAST: go vet (agent)" "PASS" "clean" ;; "") record "SAST: go vet (agent)" "NOT RUN" "Go container didn't run" ;; *) record "SAST: go vet (agent)" "FAIL" "go vet reported problems" ;; esac
  case "$gexit" in 0) record "Deps: govulncheck (agent)" "PASS" "no known vulnerabilities in called code" ;; 3) record "Deps: govulncheck (agent)" "FAIL" "vulnerable code is called — see report" ;; "") record "Deps: govulncheck (agent)" "NOT RUN" "Go container didn't run" ;; *) record "Deps: govulncheck (agent)" "NOT RUN" "govulncheck couldn't run (offline?) — see report" ;; esac
  case "$texit" in 0) record "Tests: agent (go test)" "PASS" "$(grep -c '^ok' "$TMP/go.txt") packages ok" ;; "") record "Tests: agent (go test)" "NOT RUN" "Go container didn't run" ;; *) record "Tests: agent (go test)" "FAIL" "failing Go tests — see report" ;; esac
  add_section "Agent (Go): vet, tests, govulncheck" "$(fenced "$(grep -v '_EXIT=' "$TMP/go.txt" | tail -80)")"
else nodocker "SAST: go vet (agent)"; nodocker "Deps: govulncheck (agent)"; nodocker "Tests: agent (go test)"; fi

# 2a. npm audit per workspace, full and production-only. npm 10 matches the
# servers, so results agree with what `npm ci` installs there.
for ws in engine dashboard; do
  (cd "$ws" && npx --yes npm@10 audit --json > "$TMP/audit-$ws.json" 2>/dev/null; npx --yes npm@10 audit --omit=dev --json > "$TMP/audit-$ws-prod.json" 2>/dev/null)
  parse_and_record "Deps: npm audit ($ws)" npm-audit "$TMP/audit-$ws.json" --prod "$TMP/audit-$ws-prod.json" --accepted "$REPO_ROOT/security-accepted-risks.json"
done

# 2c. Currency (information only): packages with a newer version available.
{
  for ws in engine dashboard; do
    echo "### $ws"; echo; echo "$FENCE"
    (cd "$ws" && npx --yes npm@10 outdated 2>/dev/null) || true
    echo "$FENCE"; echo
  done
} > "$TMP/outdated.md"
add_section "Package currency (npm outdated — information, not a gate item)" "$TMP/outdated.md"

# 3. gitleaks: the working tree (tracked + new files, never gitignored ones),
# the staged diff, and every commit since the last release. All three are
# streamed into one container; --redact keeps secrets out of the report.
if [ "$DOCKER_OK" = 1 ]; then
  mkdir -p "$TMP/gl/tree"
  repo_files . | grep -vE '^agent/bin/' | tar_list | tar -xf - -C "$TMP/gl/tree"
  cp .gitleaks.toml "$TMP/gl/config.toml"
  git diff --cached > "$TMP/gl/staged.diff"
  git log -p "$SINCE..HEAD" > "$TMP/gl/commits.diff" 2>/dev/null || : > "$TMP/gl/commits.diff"
  # shellcheck disable=SC2016  # single quotes on purpose: $ expands inside the container / awk, not here
  tar -cf - -C "$TMP/gl" . | dockr run -i --rm --entrypoint sh "$GITLEAKS_IMAGE" -c '
    mkdir -p /s && cd /s && tar -xf -
    gitleaks dir /s/tree --config /s/config.toml --redact --no-banner --exit-code 0 --report-format json --report-path /s/tree.json >/dev/null 2>&1
    for f in staged commits; do
      # An empty diff (nothing staged, no commits since the release) gives
      # gitleaks nothing to report; that is a clean result, not a missing one.
      if [ ! -s /s/$f.diff ]; then echo "[]" > /s/$f.json; continue; fi
      gitleaks stdin --config /s/config.toml --redact --no-banner --exit-code 0 --report-format json --report-path /s/$f.json < /s/$f.diff >/dev/null 2>&1
    done
    for f in tree staged commits; do echo "==== $f"; cat /s/$f.json; echo; done' > "$TMP/gitleaks.txt" 2>&1
  # Split the combined output back into one JSON file per scan.
  for f in tree staged commits; do
    # shellcheck disable=SC2016  # single quotes on purpose: $ expands inside the container / awk, not here
    awk -v want="==== $f" '$0 ~ /^==== / { on = ($0 == want); next } on' "$TMP/gitleaks.txt" > "$TMP/gl-$f.json"
  done
  parse_and_record "Secrets: gitleaks" gitleaks "$TMP/gl-tree.json,$TMP/gl-staged.json,$TMP/gl-commits.json"
else nodocker "Secrets: gitleaks"; fi

# 4a. Typechecks.
for ws in engine dashboard; do
  if (cd "$ws" && npx --no-install tsc --noEmit -p . > "$TMP/tsc-$ws.txt" 2>&1); then
    record "Typecheck ($ws)" "PASS" "tsc --noEmit clean"
  else
    record "Typecheck ($ws)" "FAIL" "$(grep -c 'error TS' "$TMP/tsc-$ws.txt") type errors"
    add_section "Typecheck errors ($ws)" "$(fenced "$(head -40 "$TMP/tsc-$ws.txt")")"
  fi
done

# 4c. The engine's test suite, including the security tests (auth, lockouts,
# 2FA, authorization, input validation, multi-site isolation). It needs the
# local test database from docker-compose; without it the suite is NOT RUN
# rather than reported as failing.
if (cd engine && node --input-type=module -e "import 'dotenv/config'; import pg from 'pg'; const c = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 3000 }); await c.connect(); await c.end();") >/dev/null 2>&1; then
  (cd engine && npx --no-install vitest run --reporter=json --outputFile="$TMP/vitest.json" > "$TMP/vitest.txt" 2>&1)
  parse_and_record "Tests: engine (Vitest)" vitest "$TMP/vitest.json"
else
  record "Tests: engine (Vitest)" "NOT RUN" "test database unreachable (start it: docker compose up -d postgres)"
fi

# 5. The AI-assisted diff review is a separate, manual step.
record "AI diff review (/security-review)" "NOT RUN" "manual step — run /security-review on the pending change"

# ---- Summary ----------------------------------------------------------------
REPORT="security-reports/v$VERSION-$SHA$DIRTY-$TS.md"
write_report "$REPORT" "Security gate — Looksee v$VERSION"
echo
echo "Report: $REPORT"
if [ "$FAILED" = 0 ]; then
  echo "RESULT: PASS (nothing blocking; check any NOT RUN items above before approving)"
else
  echo "RESULT: FAIL (see the FAIL lines above and the report)"
fi
exit "$FAILED"
