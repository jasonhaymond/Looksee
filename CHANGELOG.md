# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [5.1.0] - 2026-10-23

Fixes Windows agents that install and run but never show as checked in, and makes every
way an agent can fail to check in visible.

### Fixed

- **Endpoints whose installed software has NUL characters in a name never checked in.**
  Some Windows installers (a SHARP printer-driver uninstaller is a known one) pad their
  *Apps & features* name with invisible NUL characters. PostgreSQL can't store those, so
  the agent report's single database update failed as a whole — including the "last
  seen" time — and the agent resent the same data every cycle, failing forever. The
  engine now removes NUL characters (and half-characters left by cutting a string in the
  wrong place) from every request body and from heartbeat/collector query strings, so
  **agents already in the field check in again on their next cycle after the engine
  update, with no agent update**. The agent also cleans them at the source: from command
  output, from the Windows installed-programs list, and from the outgoing report.
- **A report that can't be fully stored no longer makes a running agent look offline.**
  The check-in (last seen time and agent version) is stored first, on its own; if the
  rest of the report (inventory, snapshot, software, results) fails, the reason is logged
  with the endpoint's name and shown on its page, and cleared by the next good report.
- **The first report could stall before it was ever sent.** Service-name lookups had no
  timeout, listing filesystems and the legacy disk-usage figure weren't time-limited,
  and process-owner lookups could take seconds each on a domain-joined machine that
  can't reach a domain controller. All are now time-limited, and process/service
  discovery runs in the background so it can never delay a report.
- **One agent with an old key could take a whole site offline.** Its refused polls
  tripped *Agent key guessing* and blocked the site's shared (NAT) address for every
  agent there, including the installer. A rule no longer blocks an address working
  agents have reported from in the last 24 hours (the event and notification still
  happen), and agents poll less often after three 401/403 refusals in a row (doubling up
  to every 10 minutes), saying in their log what the refusal means.
- An agent report over the 4 MB limit (or with malformed JSON) got a generic 500; it now
  gets 413 (or 400), logged with the endpoint that sent it, and the agent resends
  without its process/service/software lists so it still checks in.

### Added

- **Agent log file on Windows**: `C:\ProgramData\LookseeAgent\looksee-agent.log`,
  rotated at 5 MB with one older copy. Task Scheduler discards console output, so
  Windows agent errors were invisible before. New `-log-file` flag (`auto` by default:
  next to the config on Windows, none elsewhere; `none` to turn off).
- **`proxy_url` agent setting** for networks where web traffic must go through a proxy
  (the agent runs as a system account, which doesn't use the signed-in user's proxy).
  The installers take `LOOKSEE_PROXY`; the Windows installer warns when your own account
  uses a proxy the agent won't. The site collector's own engine connection doesn't use
  it yet (documented).
- **Agent diagnostics on the endpoint's Agent tab**: last config poll, last report
  stored, the address the agent connects from, and why its last report couldn't be fully
  stored. "Connects but its reports are rejected" is now distinguishable from "never
  connects" without SQL. Database: migration `0026` adds four nullable columns to
  `endpoints` (additive).
- **Logs page**: entries about an endpoint link to it, and *only this endpoint* narrows
  the log to it (`GET /api/logs?endpointId=`). Agent log lines name the endpoint and
  hostname, not just its ID.
- **Security log**: requests refused because the address is blocked are recorded
  (*Request refused because its IP is blocked*, at most once a minute per address)
  instead of leaving no trace.
- **Windows installer checks**: stops with a clear message on Windows older than 10 /
  Server 2016 (build 14393) or 32-bit Windows, where the agent can't run; after starting
  the task it waits up to a minute for the first check-in and reports whether it
  happened, with the last errors from the log if not.
- Agent guide: *Troubleshooting: an endpoint never checks in* (what each log line means,
  running one cycle by hand, the manual registry clean-up for engines before this
  release).

### Security

- Database errors are no longer logged with Drizzle's full parameter dump: for an agent
  report that was the machine's whole inventory (serial numbers, IP/MAC addresses,
  signed-in users, installed software). Logs now carry PostgreSQL's actual reason and
  the SQL text (placeholders only).
- The Windows installer restricts `C:\ProgramData\LookseeAgent` to SYSTEM and
  Administrators. The config there holds the agent key, and folders under ProgramData
  are otherwise readable by every local user.
- Agent and collector requests are now authenticated before their body is read, so a
  request without a valid key can't make the engine parse a 4 MB body.
- **Next.js 16.4.0 → 16.4.3** (dashboard): fixes two critical unauthenticated
  remote-code-execution advisories (GHSA-2464-fhr4-w9xw in image optimization with SVG
  files, GHSA-673q-mjm6-r5xr in `use cache` functions) and a denial of service
  (GHSA-p3m5-59mp-jv5r). These also affect 5.0.0 — update.
- Agents are built with Go 1.27.3, which distrusts compromised intermediate certificates
  (GO-2026-6809, used by SSL certificate checks).
- vitest 4.1.11 → 4.1.12 (pulls vite 8.3.5; development only — the test runner's
  `launch-editor` advisory GHSA-587h-7wmj-h5pm).
- body-parser 2.3.0 → 2.4.0 (engine; denial of service via trailing bytes after a
  compressed request body, GHSA-27r3-jxmh-p828), nodemailer 10.1.0 → 10.2.1, qs 6.16.0 →
  6.16.1, and zod 4.6.4 → 4.6.7 (dashboard tooling; GHSA-mrhx-c7xc-m3w5).
- Security gate: govulncheck findings were reported as "couldn't run" (`go run` hid its
  exit code); they're now reported as failures.
- Windows installer: PSScriptAnalyzer-clean (`Write-Output` instead of `Write-Host`,
  plain ASCII).

### Changed

- Migration guide: more from the real migration — row-count check now covers flow
  records and logs, the expected health response is shown, cutover reads the engine log
  for database errors, decommissioning also checks the reverse proxy, DNS and listening
  ports, and new troubleshooting entries cover Postgres settings not taking effect,
  `uv_cwd` errors during cleanup, and memory pressure after tuning.

## [5.0.0] - 2026-10-20

A major release: Looksee's building blocks are renamed and reorganized, and alerting,
checks, SNMP and the agent gain a large set of features. Engine, dashboard and agent
move to 5.0.0 together (lockstep). **Read the upgrade notes in the deployment guide
(§8 → Upgrading to 5.0) before updating — rolling back to 4.x means restoring the
pre-update database snapshot.**

### Changed
- **Location → Site → Endpoint → Check.** What was called an "endpoint" (a network) is
  now a **site**, and what was a "host" (a machine) is now an **endpoint** —
  everywhere: dashboard, API routes (`/api/sites`, `/api/endpoints`), and the database
  (migration 0019 renames tables, columns, constraints, indexes and enum values, and
  rewrites maintenance scopes, widget settings, discovery records and notification
  templates — `{{endpoint}}` becomes `{{site}}`, `{{host}}` becomes `{{endpoint}}`;
  `{{host}}` keeps working as an alias). An endpoint doesn't need the agent. What
  agents and site collectors send and receive is unchanged, so 4.x agents keep working
  (proved by a new test). The rename was tested on a production-sized copy (50 sites,
  1,000 endpoints, 10,000 checks, 3 million results): about 6 seconds, identical row
  counts before and after.
- **Navigation is a left sidebar** (a drawer on phones) with a live tree of locations,
  sites, endpoints, checks and groups — status markers, problem counts and a filter box.
  The top navigation bar is gone. `/hosts` redirects to `/endpoints`.
- **Linux agent installs grant the read access checks need by default** — the journal
  and `/var/log` (groups `systemd-journal`, `adm`), SMART and read-only `/home` (the
  privileged systemd drop-in), and the Docker socket when Docker is installed — while
  the agent still runs as its own unprivileged user. `--minimal` grants none of it;
  `--no-docker` leaves out Docker access, which is effectively root on that machine.
  Existing agents keep their access when they update (see agent README → Privileges).
- **Regular expressions typed into checks run on RE2** (the `re2js` package, new
  dependency) instead of JavaScript's engine, so a pathological pattern can't freeze
  the engine. RE2 has no look-ahead, look-behind or back-references; checks using them
  now report the pattern as invalid (the deployment guide has a query to find them).
- `scripts/restore.sh` empties the database completely before loading a snapshot, and
  stops at the first error. Previously, loading an older snapshot over a newer schema
  (such as a 4.3 snapshot over 5.0) left a broken mix of both — found by testing the
  5.0 rollback for real. It also checks the file is readable before deleting anything,
  and says which app version the restored data came from.
- The in-app restore (System → Backups) refuses a database backup from a different
  MAJOR.MINOR version and points to the scripted rollback; same-version and
  config-only restores work as before.
- Wording throughout follows the new terms; the check form's network target field is
  labelled **Address**.

### Added
- **Pages for every location, site, endpoint and group**, each listing everything under
  it with its status.
- **Groups** (migration 0020): any mix of locations, sites, endpoints and checks picked
  by hand, or **filter groups** whose members match rules (name, tag, type, OS, status,
  site, location…) with a live preview. Groups can be maintenance targets (following
  membership while the window runs), receive alert rules, be run/enabled/disabled in
  bulk, and scope exclusion lists. "Add to group" on every node page and on the Checks
  and Endpoints lists.
- **Alert rules can be edited** after they're created (all fields).
- **Resolve** a failing check by hand — one at a time or in bulk, also from Alert
  history — with an optional note; trap/syslog checks then ignore events from before
  that moment.
- **Recovery by event:** a *clears when text matches* pattern on trap/syslog checks,
  *recovers together with* another check (chains), *recover on its own after N
  minutes* (trap, syslog and pushed-value checks), and a per-check **recovery URL** that
  only accepts "up".
- **Exclusions:** per-check item exclusions (mounts, interfaces, disk devices, sensors,
  services, containers, Hyper-V VMs, event IDs, message texts, packages — `*`/`?`
  wildcards) and reusable **exclusion lists** (Alerting → Exclusions, migration 0022)
  applied to all checks of a kind or to chosen groups; applied on the engine, the site
  collector and the agent. Each check's page shows the exclusions it uses.
- **Exclude results from statistics** — single results or a time range, with a reason —
  so they don't count against uptime, SLA reports or status pages; they can be counted
  again (migration 0021).
- **Watchdog agents** (migration 0023): an endpoint's agent can alert by email and/or a
  Telegram/Slack/Teams/webhook channel on its own when it can't reach Looksee, and when
  it's back. Set up on the endpoint's Watchdog tab, with a test button; System →
  Watchdog lists them. The agent keeps the settings it needs in a file only its own
  account can read, and deletes it when the watchdog is turned off.
- **Installed software** (agent 5.0, migration 0024): dpkg, rpm, apk, pacman, Windows
  programs, macOS apps, global npm/pip packages, Node/Python/PHP runtimes and listed
  lock files — sent when it changes and at least daily. Three new check types:
  - **Upgradable packages** — the list of waiting packages; Ubuntu **phased updates**
    left out by default (option to include; metric `updates.phased` counts them).
  - **Installed software changed** — installed, removed, or changed version.
  - **Vulnerable or unsupported software** — OSV.dev advisories and endoflife.date
    support dates (cached 7 days / 1 day; package names and versions only, never
    hostnames), with severities for warn/down and **accepted risks** that carry a reason.
- **SNMP OID dictionary** (about 170 entries — standard MIBs, Printer-MIB, UPS-MIB and
  printer vendor counters for HP, Brother, Canon, Ricoh, Xerox, Kyocera, Lexmark and
  Konica Minolta, plus enterprise numbers for printer and network vendors): the walk
  browser shows names, readable values and whose vendor OID it is, and can look an OID
  up by name.
- **SNMP calculations:** *Calculate* (a safe calculator — no code) on a check's value,
  **Extra OIDs** read in the same poll and combined by name (`used / size * 100`,
  `rate(…)` for counters), and `ref` for another check's latest value. New **Calculated
  value** check type combines up to four other checks.
- **SNMP templates** (Monitoring → SNMP templates, migration 0025): built-in sets for
  printers (generic and 13 brands), UPS (standard and APC), Synology, Net-SNMP, Cisco,
  Dell iDRAC and switches; your own templates (copy a built-in one or start fresh);
  apply to a device in one step. Discovery suggests the template matching a device's
  SNMP sysObjectID and opens it with the address filled in.
- **Role and security templates** on an endpoint's Suggested checks tab: web, database,
  DNS, mail, file, domain controller, hypervisor, Docker host, backup and print server
  roles, and Windows/Linux/macOS security baselines; "looks like this" marks roles the
  agent detected from running, enabled services.
- **Smarter suggestions:** software checks, certificate checks for existing HTTPS checks,
  detected-role checks, suggestions that tell endpoints apart correctly, and
  **site suggestions** from a site's name, description, endpoints and existing checks.
- **More check settings** with working defaults and an Advanced section: TCP send/expect
  text and timeout, DNS timeout and tries, TLS server name and timeout, agent-online
  severity, OS service *Should be: Stopped*, push-value auto-recovery, and advanced
  options on traceroute, disk forecast, performance counters and the services overview.
- `docs/check-settings.md` (also in-app under Help): every setting of every check type,
  generated from the form's own definitions by `dashboard/scripts/check-settings-doc.ts`.
- `docs/plans/check-expansion.md`: recommendations for further checks and templates.
- Tests for every new feature (groups, recovery, exclusions, watchdog agents, software,
  SNMP templates, role templates, calculations, 4.x agent compatibility, the restore
  version guard, hardening).

### Security
- Hardening from the gate's static analysis: object keys taken from requests or stored
  data are read and written through guards that refuse `__proto__`, `prototype` and
  `constructor` (`lib/own.ts`); file paths built from input are confined to their
  folder (`lib/safeFs.ts`); admin-typed patterns run on RE2. Remaining scanner
  suppressions are listed, with reasons, in the 5.0.0 security report.
- Watchdog SMTP mail rejects header injection and requires TLS 1.2+.
- Known open item: SNMP v1/v2c community strings are still returned to the dashboard
  like other settings (v3 keys are write-only) — see `docs/plans/check-expansion.md`.

### Fixed
- Live refreshes pause while a field or dropdown is in use (also shipped in 4.3.1).
- Role templates suggested checks for services that were installed but stopped; they
  now consider only running, enabled services.
- Suggested checks for different endpoints with the same check type could hide each
  other; the suggestion key now includes the target.

## [4.3.1] - 2026-10-19

Dashboard only. Engine, dashboard and agent move to 4.3.1 together (lockstep).

### Fixed
- Live data refreshes no longer disturb what you're doing on the page. A refresh is
  skipped while a text field or dropdown has focus, or text is highlighted, and you've
  tapped, clicked or typed in the last minute; the data catches up on the next tick
  afterwards. Previously, on mobile browsers an open dropdown picker closed every time
  the page refreshed, and highlighted text could lose its highlight
  (`dashboard/app/lib/poll.ts`, used by every page and widget that refreshes on a timer).
- Backups: the settings form (repository, schedule, retention) was refilled from the
  saved values on every 5-second status refresh, wiping whatever was being typed. It's
  now filled only when the page opens and after a save.

## [4.3.0] - 2026-10-15

Release tooling only — no change to the engine, dashboard or agent at runtime. Engine,
dashboard and agent move to 4.3.0 together (lockstep).

### Added
- Security gate: `scripts/security-check.sh` (also `npm run security` in engine/) runs
  every security check in one command — Semgrep, ESLint + eslint-plugin-security,
  ShellCheck, PSScriptAnalyzer, go vet, npm audit, govulncheck, gitleaks (working tree,
  staged diff, commits since the last release), typechecks, the engine test suite and
  the agent's Go tests — prints PASS / FAIL / NOT RUN per check and saves a full report
  to `security-reports/` (gitignored). Scanners run in pinned Docker images; a full run
  takes about 8–9 minutes.
- `scripts/security-check.sh --live <url>`: post-deploy checks of a running instance —
  HTTPS and certificate, security headers, admin routes answer 401 without a session,
  CORS refuses foreign origins, sign-in rate limiting.
- ESLint configs for engine (ESLint 10) and dashboard (ESLint 9 — pinned, see README),
  both with eslint-plugin-security; `npm run lint` in each.
- `security-accepted-risks.json` (accepted dev-only dependency advisories, each with a
  review date) and `.gitleaks.toml` (two reviewed test fixtures).

### Changed
- `scripts/update.sh` only deploys release tags — the newest by default — and refuses a
  tag without a `Security review: approved <date>` line (`scripts/verify-release-tag.sh`).
  Releases up to 4.1.0 predate the gate and need `--allow-unreviewed` plus typing the tag
  name, interactively only. With `LOOKSEE_PUBLIC_URL` in the root `.env`, every update
  ends with the post-deploy security checks. The server checkout is now on a tag
  ("detached HEAD") after an update rather than on master.

### Fixed
- The DHCP probe test failed about one run in twenty on Windows: it guessed a random
  high UDP port, and Windows reserves blocks of those for Hyper-V/WSL/Docker. It now asks
  the operating system for free ports. (No change to the probe itself.)
- The security tests could fail intermittently: their random test addresses sometimes
  repeated one that an earlier test had deliberately gotten blocked. Each address is
  now used only once per run. (No change to what the tests check.)

## [4.2.0] - 2026-10-13

Engine, dashboard and agent move to 4.2.0 together; the agent itself has no changes in
this release (its version follows the lockstep rule).

### Added
- `docs/vpn-access.md` (also in-app at Help → VPN-only access): step-by-step guide to
  reaching Looksee only through an OpenVPN/WireGuard VPN (pfSense menus, example
  addresses) — admin only, agents
  too, or nothing public — with split DNS, Caddy rules, verification and rollback. A
  plan only; production stays public with required two-factor.
- Weekly maintenance windows remember the time zone of the browser that scheduled them
  (new nullable `maintenance_windows.time_zone` column, migration 0018), so "Sunday
  02:00" means 02:00 where you are regardless of the server's clock. Older windows keep
  using the server's zone and are labelled *(server's time)*.
- User guide: *Times and time zones* section.

### Changed
- All times in the dashboard are shown in your local time zone, including times
  embedded in check messages ("Host rebooted at …", "last report …", Proxmox backup
  times) and in result details, which were shown in UTC. Converted in the browser, so
  messages already stored are fixed too.
- Public status pages cut each daily uptime bar at the visitor's midnight instead of
  UTC midnight (`?tz=` on `/api/public/status/<slug>`, validated; unknown zones fall
  back to UTC). Day boundaries are computed in the engine, so legacy zone names browsers
  still report (`Asia/Calcutta`, `Europe/Kiev`, …) work even where Postgres doesn't know
  them.
- Proxmox backup check messages mark their time as UTC (`… 14:05 UTC`).

### Fixed
- The security guide's Caddy example for restricting the dashboard to known IPs never
  blocked anything: Caddy runs `handle` before `respond`, so the rule needs a
  `route { }` wrapper. Verified against Caddy 2.

## [4.1.0] - 2026-10-13

### Added

- **Passkeys and security keys** (WebAuthn) as the second sign-in step, instead of
  typing the authenticator code — a YubiKey, a phone or password-manager passkey, or
  Windows Hello. Add them under System → Security → *Passkeys & security keys*; adding
  one needs a current authenticator code and sends a security notification. The
  authenticator app stays enrolled as the fallback, so two-factor stays mandatory.
  `WEBAUTHN_RP_ID`/`WEBAUTHN_ORIGINS` override the defaults worked out from
  `DASHBOARD_URL` for unusual proxy setups.
- **Watchdog** (System → Watchdog): an outbound "dead man's switch" that pings an outside
  service (Healthchecks.io, Uptime Kuma push, any URL) every minute while Looksee's
  self-check passes (database reachable, scheduler running), and calls an optional
  failure URL when it doesn't — so you hear about Looksee's own outages. URLs are
  write-only.

### Changed

- The engine runs on **Express 5** (was 4). `express-async-errors` is gone — Express 5
  forwards errors from async routes itself (tested).

### Verified

- Engine suite 184 tests (new: passkey options need a code, forged registration and
  assertion rejected, passkey offered once registered; watchdog write-only URLs,
  validation and a real ping; Express 5 async-error handling).
- Passkeys end to end in Chrome with a virtual FIDO2 security key: registered on the
  Security page, signed in with it instead of a code, and an unregistered key was refused.
- Watchdog page at desktop and mobile widths, dark and light.

## [4.0.0] - 2026-10-13

### Upgrade notes

A major version because signing in works differently: two-factor is mandatory and the
sign-in API (`POST /api/auth/login`) now returns a second step instead of a session.

- **Two-factor sign-in is now required.** The first sign-in after upgrading asks you to
  scan a QR code with an authenticator app and save ten recovery codes. Have your phone
  ready. Locked out? `npm run security:reset -- --2fa` in `engine/` on the server.
- Set **`TRUST_PROXY`** in `engine/.env` to your reverse proxy's IP so blocks, the
  allowlist and the security log see real client addresses (see the security guide).
- Update agents to 4.0.0 for process/service inventory, script expected output, and the
  script picker (**Hosts → select → Actions → Update agents**).
- Two additive migrations (`0014`, `0015`); `update.sh` applies them.

### Added

- **Security** (System → Security, and the new [security guide](docs/security-guide.md)):
  - Mandatory TOTP two-factor sign-in with QR enrollment, ten one-time recovery codes,
    moving to a new authenticator, and password change (needs a current code; signs out
    other sessions).
  - Lockout after N failed passwords/codes per IP and per account; session lifetime and
    idle timeout; minimum password length; a list of signed-in sessions with remote
    sign-out.
  - Optional **new-IP email confirmation** (a code emailed for sign-ins from an IP not
    used before) and an optional **IP allowlist** (IPs/CIDRs, v4 and v6) for the sign-in
    page and admin API, with agents/heartbeats/status pages exempt unless chosen. The
    allowlist refuses to save without your current IP.
  - **Attack detection**: a security event log (sign-ins, failures, lockouts, scanner
    probes such as `/.env` and `/wp-login.php`, invalid agent keys, unknown heartbeat
    tokens, rate-limit hits, settings changes) and editable **rules** — N events in M
    minutes, per IP or overall → email/channel notification and/or an automatic IP block.
    Six built-in rules (password guessing, scanners, agent-key guessing, heartbeat-token
    guessing, new-IP sign-in, lockout/password change). Manual IP blocks.
  - `npm run security:reset` (shell-only break-glass recovery), security headers on the
    API and dashboard, `SameSite=Strict` session cookies, `TRUST_PROXY` setting.
- **Locations**: group endpoints (networks) by physical place; location filters and
  grouping on Checks, Hosts and Alert history; per-location status summary and one-click
  maintenance; `{{location}}` in alert messages.
- **Channels**: native **Slack**, **Microsoft Teams** (Workflows / Adaptive Card with an
  "Open in Looksee" button) and **Telegram** channels; **message templates** for every
  channel (triggered/resolved/reminder/escalated title and body, 12 variables, live
  preview); **Send a test alert** for every channel type; Web Push notifications open the
  check.
- **Remediation hints**: failing checks show "Things to check" worked out from the failure
  message and check type, also in alerts via `{{remediation}}`.
- **Check page** (`/checks/<id>`): range picker, uptime/state changes/incidents/latency
  (avg, p95, max)/value stats, status strip, response-time and value charts with hover
  readouts, incidents, latest details and every result.
- **Alert history page** with range, open/resolved, location/endpoint/host filters and
  search.
- **Add checks to many targets at once** (multi-select hosts or endpoints, with
  `{{host}}`/`{{address}}`/`{{endpoint}}` placeholders), full alert-rule options when
  creating checks, suggested checks and discovered devices, and **Browse** pickers fed by
  the host's inventory (pick several services/processes/containers/scripts → one check
  each).
- **Duplicate** copies now keep the original's enabled state, alert rules and
  dependencies, and can go to other endpoints or hosts.
- **Host inventory** (agent 4.0): every process (PID, user, CPU, memory, command line with
  credentials masked) and every service (state, start type), refreshed about every 5
  minutes; new Processes and Services tabs.
- **MAC addresses and IP change detection**: MAC column on host interfaces, MAC filled in
  from the agent, MAC→IP history from agents, discovery and ARP checks (Hosts → IP
  history), discovery recognizes known MACs, and a new **IP address change (by MAC)**
  check type.
- **Smarter suggested checks**: built from the host's services (running + automatic),
  processes, containers (each by name), listening ports (network checks from Looksee for
  HTTP/HTTPS + certificate, SSH, databases, RDP, SMB, MQTT, Proxmox, …), OS logs, and
  database memory — grouped, with alert options.
- **SNMP**: per-row rates on walk modes, a **full walk** mode that keeps every value, an
  index filter, and a **Walk this device…** browser in the check form (runs on the site
  collector for remote endpoints).
- **Printer** SNMP templates: printer errors (jam, no paper, door open, offline, …, plus
  the printer's own alert text) and failed/aborted print jobs (Job Monitoring MIB).
- **Custom script expected output**: contains / doesn't contain / equals / regex and an
  expected exit code, judged by the engine; the script field lists the scripts in the
  agent's `script_dir`. Scripts still only run from `script_dir`.
- **Light and dark themes** (System / Light / Dark toggle) with higher-contrast surfaces
  and borders; every color is a theme token, checked against WCAG AA.
- **Bulk actions in one grouped menu** on Checks, Hosts and Endpoints.
- **In-app help** (Help in the top bar): the user guide, a new **check reference** (what
  every check type does, how, its value, and the commands to check it by hand on
  Linux/macOS/Windows), the security guide and the Windows agent guide, with search;
  every page's "Learn more" and every check form link into it.
- **Windows agent code signing** pipeline (`agent/sign-windows.sh`, run by
  `build-all.sh`): Azure Artifact Signing, any HSM/cloud key via jsign, or a `.pfx`;
  off until `agent/signing.env` is configured. New
  [windows-agent-security.md](docs/windows-agent-security.md) covers Smart App Control,
  SmartScreen, Defender, ASR, WDAC/AppLocker, EDRs and the firewall.

### Changed

- Add-widget form: widget cards and a searchable, filterable picker (several tiles at
  once); the list no longer refreshes or jumps to the top while open.
- Alert messages use the channel's templates; the default text names where the check is
  and what to check, and links to the check page.

### Fixed

- **SNMP interface traffic was always blank** (and custom Counter64 OIDs failed):
  net-snmp returns Counter64 values as raw bytes, which were read as NaN. They're now
  decoded, so `ifHCInOctets`/`ifHCOutOctets` rates appear from the second run.
- Pages no longer scroll sideways on phones because of hidden tooltips; the status
  strip fits narrow screens; missing favicon request.

### Security

- Full security and dependency audit — [docs/security-audit-2026-10.md](docs/security-audit-2026-10.md).
  Fixed: critical `proxy-addr` IP spoofing (Express 4.22.3) and Next.js cache-poisoning/SSRF
  advisories (16.4.0), high `nodemailer` (10.1.0) and `sharp` advisories; production
  dependencies now report 0 known vulnerabilities. Agent moved off EOL Go 1.22 to 1.26+
  with gopsutil v4; govulncheck clean.
- Review fixes in the new security features: each authenticator code works once; account
  lockout doesn't apply from known sign-in IPs (no lock-out-the-admin denial of service);
  rules never auto-block allowlisted or known sign-in IPs; heartbeat tokens are masked in
  the security log; credentials in process command lines are masked by the agent.
- The production server's Node.js 20 is end-of-life: the 4.0 upgrade guide now moves it to
  Node 24 LTS.

### Verified

- Engine suite: 179 tests (29 new: TOTP replay, lockout from a known IP, no self-block, token masking, two-factor enrollment/recovery codes/IP-bound
  challenges, lockout and rule-driven blocking, scanner and bad-key detection, allowlist
  self-lockout refusal, Counter64 decoding, script expected output, remediation,
  templates, Slack/Teams payloads through a real HTTP receiver, locations, batch create
  with placeholders, duplicate with rules, check stats, IP-change detection, smart
  suggestions). Go: vet + tests, including command-line redaction.
- A real 4.0.0 Windows agent reported 321 processes and 320 services, its scripts and
  MACs, and the engine recorded its IP sightings. The Windows binary was signed and
  timestamped with a throwaway certificate through `sign-windows.sh` and read back by
  `Get-AuthenticodeSignature`.
- Every changed page checked in a real browser at desktop and mobile widths in dark and
  light themes (screenshots), with no console errors and no horizontal scrolling at
  390 px.
- Not yet run against real accounts: Azure Artifact Signing and jsign keystores, Slack,
  Teams and Telegram (payload shapes verified against a local receiver), and SNMP
  against a real pfSense/Aruba (Counter64 decoding verified with unit tests).

## [3.2.0] - 2026-10-08

### Added

- **Site collectors: monitor other locations with no port forwarding.** On the Endpoints
  page, pick an agent host at a remote site as that endpoint's *site collector*. Its
  agent (3.2.0+) downloads and runs a collector that does, from inside the site, what
  the engine does on its own network — runs the endpoint's network checks (every
  engine-run type except the ones that read the engine's database), receives the site's
  syslog/SNMP traps/NetFlow/IPFIX/sFlow, and runs its discovery scans and Wake-on-LAN —
  and posts everything back over outbound HTTPS with the host's agent key
  (`/api/collector/*`). The collector is the engine's own probe, receiver and discovery
  code, bundled into one file and run on an official Node.js 24 LTS runtime that the
  Looksee server downloads from nodejs.org (SHA-256-verified) and serves to agents (the
  agent verifies each file again against the server's manifest). It keeps working from
  its last configuration and buffers results while the server is unreachable; if the
  server hears nothing for 3 minutes, that endpoint's checks turn Unknown ("Site
  collector on … is offline") instead of looking healthy. **Run now** queues the run on
  the collector.
- **Direct push by public IP.** An endpoint's *Public IPs* field lets devices at a site
  without a collector send syslog/traps/flows straight to the server (with those ports
  forwarded at the server's location); events from those IPs are accepted and filed
  under that endpoint.
- Received events and flows are tagged with their site: a site filter on **Traps &
  syslog** and **Top talkers**, the site's name under each event's sender, and
  Trap/Syslog-received checks in a remote endpoint match only that site's events.
- Discovery **Scan from** picker; hosts and endpoints show each collector's state
  (online / offline / waiting / error); checks show "via site collector".
- `scripts/build-collector.sh` (run by `update.sh` on every update) bundles the
  collector and fetches the Node runtimes; `COLLECTOR_PLATFORMS` in the root `.env`
  limits which platforms are kept. New `engine/.env` settings `COLLECTOR_*_PORT` and
  `COLLECTOR_ALLOWED_SOURCES`.
- User guide *Multiple sites*, deployment guide *Upgrading to 3.2*, direct-push firewall
  rules and collector troubleshooting, agent README *Site collector*.

### Changed

- The syslog/trap/flow receivers and discovery scan are split into database-free cores
  (shared with the collector) and the engine's storage layer; behavior on the engine's
  own network is unchanged.

### Verified

- Engine suite 150 tests (12 new for the collector API, scheduler hand-off and offline
  marking, site-scoped event matching, direct-push attribution, collector discovery and
  Wake-on-LAN); new Go tests for the collector supervisor (install, hash rejection,
  bundle replacement, graceful stop) under the race detector.
- End to end with a real Windows agent: downloaded and verified Node v24.21.0 plus the
  bundle, ran ping/TCP checks and a discovery scan from the collector, received a UDP
  syslog message and matched it with a site-scoped check, sent a Wake-on-LAN job, picked
  up a rebuilt bundle live, exited when the agent was killed, stopped when unassigned.
- Linux agent under the real hardened systemd unit (unprivileged user,
  `ProtectSystem=strict`): collector installed to `/var/lib/looksee-agent/collector`,
  ran checks, stopped cleanly with the service; the documented low-port drop-in gives
  the collector `CAP_NET_BIND_SERVICE`/`CAP_NET_RAW`.
- Dashboard pages (Endpoints and its dialog, Hosts, Checks, Discovery, Traps & syslog)
  screenshotted at desktop and mobile widths.

## [3.1.0] - 2026-10-08

### Added

- **`scripts/update.sh` builds the agent binaries itself** whenever `agent/VERSION`
  changes (or the binaries are missing) — no separate build step. It uses the server's
  Go toolchain or the `golang` Docker image, run as the invoking user (so `agent/bin/`
  isn't root-owned) with a persistent build cache (first build a few minutes, later
  ones ~10 s).

### Fixed

- **Re-running the agent install command didn't restart a running agent (Linux)** — it
  used `systemctl enable --now`, which leaves a running service alone, so after
  regenerating a host's key the old process kept the revoked key and every report was
  rejected (401): the host showed offline. The installer now always restarts the agent.
- **Windows re-install failed while the agent was running** (the running exe is locked)
  and left the old agent on its old key. The installer now stops the task and process
  first and downloads to a temp file.
- **Windows agents stopped after 3 days** — the scheduled task used Task Scheduler's
  default 72-hour run limit. It now has no limit.
- **"Update agent" never worked on Linux** — the hardened systemd unit makes
  `/usr/local/bin` read-only to the agent, so the update failed ("read-only file system")
  and the agent silently kept its old version. The binary now lives in
  `/var/lib/looksee-agent/` (the unit's `StateDirectory`, writable by the agent's user),
  with a `/usr/local/bin` symlink. Hosts installed earlier need the install command run
  once to move it.
- **Self-update could leave the agent stopped under systemd or launchd** — it relaunched
  a copy of itself and exited cleanly, which systemd treats as a stop (killing the copy).
  Under a service manager the agent now exits with code 75 and is restarted on the new
  binary (`Restart=always` in the unit).
- **Linux amd64 agent wasn't actually static** — it linked glibc dynamically, so it
  wouldn't run on Alpine/musl or old-glibc hosts. All agents are now built with
  `CGO_ENABLED=0`.

### Verification

- In a real systemd container with the real install scripts and unit: reproduced the
  offline bug (same PID after re-install, 401s), then with the fix — old layout migrated
  to `/var/lib/looksee-agent/`, agent restarted on the new key, and "Update agent" took it
  from 3.1.0 to a newer build (exit 75 → systemd restart → new version reporting).
- `build-all.sh`'s Docker path and the `update.sh` version gate on a real Linux Docker
  host as a non-root `docker`-group user (no record → build; same version → skip;
  bumped → build), binaries owned by that user and statically linked.
- The Windows installer changes and the macOS path were not run on a real host.

## [3.0.5] - 2026-10-08

### Fixed

- **The add/edit check form said "This host hasn't sent a 3.x agent report yet" for
  every host, even with an up-to-date agent**, and offered no mount/interface/device
  suggestions for host-metric checks. The form read a `hasSnapshot` flag that only the
  host-list API returned, not the single-host API it actually calls. The single-host
  API now returns it, the form checks the snapshot directly, and the message names the
  agent version the host reports. Host details in the form are now cached for 30
  seconds instead of the whole page session, so a just-updated agent shows up without
  a reload. Verified in the real UI with an updated and a pre-3.0 host.

## [3.0.4] - 2026-10-08

### Fixed

- **`update.sh` failed at `npm ci` with "Missing: esbuild@0.28.2 from lock file"** on
  servers running npm 10 (Node 20). The engine lockfile was generated by npm 11, which
  omits the nested `esbuild` that vitest's bundled vite needs as a peer; npm 10 refuses
  that lockfile. Regenerated it with npm 10 — verified with `npm ci` under both npm 10
  and npm 11, then a clean npm 10 install, build, and the full test suite. Project rule
  added (CLAUDE.md) to regenerate and check lockfiles with npm 10 before committing.

## [3.0.3] - 2026-10-08

### Fixed

- **`git pull` and `scripts/update.sh` kept stopping on a modified
  `package-lock.json`.** The update script ran `npm install`, which rewrites the lockfiles
  whenever the server's npm version formats them differently from the one that
  generated them, leaving the checkout dirty after every update. It now uses `npm ci`
  (installs exactly what the lockfile pins, never modifies it), and resets any lockfile
  drift left by earlier updates before its uncommitted-changes check. The deployment and
  migration guides now use `npm ci` on servers too.

## [3.0.2] - 2026-10-08

### Fixed

- **`./scripts/update.sh` failed with "Permission denied"** — the shell scripts
  (`scripts/update.sh`, `backup.sh`, `restore.sh`, and the agent's `install*.sh`,
  `uninstall*.sh`, `build-all.sh`) were committed from Windows without the executable
  bit, so running them directly as the docs show never worked; only `bash <script>` did.
  They're now executable in the repo. If you hit this, run `bash scripts/update.sh`
  once (don't `chmod` the file on the server — git would see that as a local change and
  `update.sh` refuses to run over local changes); the update pulls the fixed modes.

## [3.0.1] - 2026-10-08

### Fixed

- **`scripts/update.sh` failed at the restart step with "[PM2][ERROR] Process or
  Namespace looksee-engine not found"** whenever pm2 had no record of the apps for the
  user running it (run as another user, or after a reboot without `pm2 save`/`pm2
  startup`) — everything before it had already succeeded, but nothing was restarted. It
  now uses `pm2 startOrReload ecosystem.config.cjs` (starts or reloads as needed) and
  `pm2 save`.
- The post-update health check only looked for `"status":"ok"`, so an old process still
  holding port 4100 could make an update look successful. It now also requires the
  engine to report the version that was just deployed, and prints the last health
  response and next steps when it doesn't.

## [3.0.0] - 2026-10-08

A major expansion of what Looksee can monitor, plus a rebuilt management interface.
The scope came from a survey of Zabbix, Nagios/Icinga, PRTG, Checkmk, LibreNMS,
Netdata, Prometheus exporters, Datadog and Uptime Kuma. Upgrading is the normal
`scripts/update.sh` run; see the deployment guide's "Upgrading to 3.0".

### Added — engine probes (no agent needed)

- **Ping** now reports packet loss %, jitter and min/avg/max round-trip time, with loss
  and jitter thresholds (3 pings per check by default).
- **HTTP(S)**: body must *not* contain, regex match, JSON-path checks (equals, contains,
  greater/less than, exists — numeric values feed thresholds), status lists and ranges
  (`200-299,301`, `2xx`), redirect-chain tracking with "must end at URL" and "warn above
  N redirects", request bodies, and a configurable timeout.
- **Response-time thresholds** (warn/critical ms) on every check that measures latency,
  and **warn/critical above/below value thresholds** on every check that produces a value.
- **DNS**: any record type, a chosen DNS server, expected-answer matching, and DNSSEC
  validation (via the resolver's AD flag; SERVFAIL is reported as a validation failure).
- **TLS certificate**: chain trust, hostname match, critical-days threshold, and a warning
  when the server still accepts TLS 1.0/1.1. Existing checks keep their old behaviour —
  the new checks are off unless set; new checks default them on.
- New engine check types: **UDP port**, **mail/SSH/FTP/LDAP/RDP protocol checks**
  (SMTP with STARTTLS requirement, IMAP, POP3, FTP, SSH banner, LDAP bind, RDP connection
  confirm), **email round-trip** (SMTP send → IMAP receive), **real browser** (headless
  Chrome via puppeteer-core and a system Chrome/Chromium), **domain registration expiry**
  (RDAP), **WebSocket**, **NTP server**, **DHCP server** (with rogue-server detection),
  **gRPC health**, **MQTT broker**, **container registry** (incl. image tag via the
  bearer-token flow), **traceroute / path change**, **public IP change**, **device present
  (ARP)**, **database** (PostgreSQL, MySQL/MariaDB, SQL Server, Redis, MongoDB: connect +
  query, connections %, replication lag, size, long-running queries, memory),
  **Prometheus metric** (any exporter, label filters, aggregation, counter rates), **web
  server status** (nginx, Apache, Caddy), **app integrations** (Nextcloud, Home Assistant,
  Plex, Jellyfin, Pi-hole, any JSON API), **SNMP templates** (printer toner, UPS battery/
  runtime/on-battery, CPU, memory, fullest disk, hottest sensor, reboot detection) plus
  walk aggregation and counter rates, **SNMP interface tables** (down ports, utilization,
  errors), **SNMP trap** and **syslog** matching, **server hardware** (Redfish, or IPMI via
  ipmitool), **Proxmox VE** (node, cluster quorum, guest, storage, last vzdump backup),
  **VMware ESXi/vCenter** (VM power, datastores, host health over the vSphere SOAP API),
  **anomaly** (a check's value vs its own same-hour baseline), **disk-full forecast**,
  **agent online**, **heartbeat** and **push a value** (unique URLs for cron jobs and
  scripts — `/api/hb/<token>`).
- **Receivers**: SNMP traps (UDP 1162), syslog (UDP/TCP 1514, RFC 3164 and 5424),
  NetFlow v5/v9 and IPFIX (UDP 2055) and sFlow v5 (UDP 6343). Unprivileged ports,
  private-network senders only by default, rate-limited per source.

### Added — agent (3.0.0)

- **Extended snapshot** every report: CPU user/system/iowait/steal and per-core, load
  average, memory/swap/major page faults, uptime and boot time, process/thread/zombie
  counts, open file handles, context switches and interrupts, every filesystem (incl.
  network mounts, with hung `statfs` reported as *stale* instead of blocking), inodes,
  read-only state, per-disk I/O (throughput, IOPS, latency, busy %), per-interface
  throughput/errors/drops/link state/speed, TCP states, listening ports.
- **Background collectors**: sessions, temperatures, fans, battery, failed logins, pending
  reboot, firewall, disk encryption, Defender, clock sync and offset, RAID/ZFS/Storage
  Spaces/storcli, SMART (smartctl, or Windows reliability counters), pending OS updates
  (apt, dnf/yum, pacman, Windows Update, softwareupdate), and hardware/OS inventory.
- **New agent check types**: files and folders (exists, age of newest file, size, count,
  folder size, checksum drift, **folder watchdog** for created/modified/deleted files),
  log file patterns (rotation- and glob-aware), systemd journal, Windows Event Log,
  custom scripts (Nagios exit codes and perfdata; only from the agent's own `script_dir`),
  scheduled tasks / systemd timers, failed systemd units / stopped automatic Windows
  services, Docker containers (state, health, restarts, CPU/memory — over the Docker
  socket or Windows named pipe), Hyper-V VMs, Windows performance counters, VPN tunnels
  (WireGuard handshake age, any tunnel interface), UPS (NUT, apcupsd), and backup jobs
  (Borg, restic, Veeam).
- **OS service** checks report systemd restart counts (alert on restarts per hour);
  **process** checks report instance count, CPU % and memory, with min/max counts.
- **Remote probes**: ping/TCP/HTTP/DNS/TLS checks can run *from* a host's agent ("Run
  from"), for targets only reachable inside that host's network.
- Checks run in the background and honour their own interval; slow ones never delay a
  report, and results are kept for the next report if one fails to send.
- New optional config keys `script_dir`, `ntp_server`, `docker_socket`; an optional
  systemd drop-in (`agent/looksee-agent-privileged.conf`, served at
  `/install/looksee-agent-privileged.conf`) for SMART and `/home` access.

### Added — host-level checks from agent reports

- **Host metric**: one check type over a catalog of 62 metrics (any of the above), with
  per-mount/interface/device/sensor/port instance selection and boolean "healthy when"
  metrics (firewall on, SMART passed, interface up, port listening, …).
- **Reboot detection** and **change detection** (new login sessions, listening ports,
  inventory, interfaces, mounts), held as a warning for a configurable time.

### Added — alerting and operations

- **Maintenance windows** (one-time or weekly; everything, endpoints, hosts, or checks):
  results still recorded but flagged, no alerts, excluded from SLA reports.
- **Dependencies**: a check's alerts are held while a parent it depends on is down.
- **Flap detection** with hysteresis holds alerts for checks changing state rapidly.
- Alert rules can **trigger on warn**, **re-notify** every N minutes, and **escalate** to
  extra channels after N minutes still failing.
- **Retry interval** per check: re-check sooner while failing.
- **SLA reports** (time-weighted uptime, downtime, degraded and maintenance time,
  incidents, average response; CSV export).
- **Public status pages** at `/status/<slug>` with 90-day daily uptime bars.
- **Network discovery**: scan a subnet (ping + common ports, reverse DNS, ARP MAC, SNMP
  sysName/sysDescr) and add hosts and suggested checks in one step.
- **Suggested checks** per host, built from what its agent found.
- **Wake-on-LAN** for hosts with a MAC address.
- **Top talkers** from flow data, as a page and a dashboard widget; a **status summary**
  widget.
- Daily **data retention** for check results (400 days), host metrics (30), events (30)
  and flows (7), all configurable.

### Added — documentation

- **Migration guide** (`docs/migration-guide.md`): moving an existing deployment, data
  and secrets included, to a different server — backup, restore, cut-over, re-pointing
  agents, the Borg repository, and rollback. Linked from the README and deployment guide.

### Changed

- **Management UI rebuilt.** The Checks page is a filterable, groupable table (status
  chips with counts, search across names/types/hosts/messages/tags/config, endpoint/host/
  kind/tag filters, group by endpoint/host/kind/status) with **multi-select and a bulk
  action bar**: enable, disable, run now, maintenance, add/remove tags, move, set host,
  run from, interval, retry interval, add/remove alert rules, dependencies, duplicate,
  delete (typed confirmation). New **Hosts** (live overview, suggested checks, agent,
  edit, WoL, bulk actions) and **Endpoints** (merge, maintenance, bulk enable/disable,
  delete) pages. Navigation is grouped into Monitoring / Alerting / Insights / System with
  a phone menu.
- **One add/edit form for every check type**, driven by a type registry, with a
  searchable type picker, agent-discovered name suggestions, a thresholds section, and an
  optional alert rule at creation.
- Checks now carry their latest result, so the dashboard and lists load in a few requests
  instead of one per check; indexes added on result and metric history.
- **Check credentials are write-only**: passwords, tokens, SNMPv3 keys and passphrases
  are masked in every API response and kept when an edit sends the mask back.
- Alerts name the check and the reason (e.g. "[Looksee] NAS disk is WARN: 92% is above
  warn threshold 90"), and email subjects say what happened.
- **Versioning**: the agent now shares the app's version number (1.2.0 → 3.0.0), per the
  lockstep standard. Agents older than 3.0 keep working for existing check types; newer
  types report "Needs agent 3.0.0+" until the host is updated.

### Fixed

- **SNMPv3 SHA-224/256/384/512 and AES-256 were silently ignored**: the form offered them
  but the engine only knew MD5/SHA-1/DES/AES, falling back to SHA-1/AES without a word
  (so authentication just failed). All are now supported, and an unknown protocol is a
  clear error.
- Webhook alerts with a newline or backslash in the message produced invalid JSON (only
  quotes were escaped).
- Alert notifications didn't say which check they were about.

### Verification

- **Engine**: 137 automated tests (vitest + supertest against the real local Postgres).
  Every network probe is tested against a real in-process server speaking that protocol
  (SMTP, IMAP, POP3, FTP, SSH, LDAP, RDP, UDP, NTP, DHCP, MQTT, WebSocket, gRPC, container
  registry with bearer tokens, a DNS resolver with/without the AD flag, Prometheus, nginx/
  Apache status, Nextcloud, Home Assistant, Pi-hole, Redfish, Proxmox, RDAP), SNMP against
  net-snmp's own in-process agent (presets, walks, interface table, reboot detection),
  NetFlow v5/v9/IPFIX/sFlow from crafted packets, and the alerting pipeline end-to-end
  through real webhook deliveries (warn triggers, recovery, escalation, re-notify,
  dependencies, flapping, maintenance). A test also keeps the dashboard and engine type
  registries in sync.
- **Live services**: MySQL 8, Redis 7, MongoDB 7, SQL Server 2022, a GreenMail SMTP/IMAP
  server (full round-trip delivered) and VMware's vcsim simulator, all in Docker; real
  internet targets for ping, HTTP, DNSSEC, TLS, RDAP, NTP, traceroute, public IP and the
  headless browser.
- **Agent**: Go unit tests on Linux and natively on Windows; the real Windows build ran
  against a local engine (CPU, disks, interfaces, firewall, Defender, Windows Update,
  pending reboot, sessions, battery, event log, perf counters, stopped services, folder
  watchdog, remote HTTP probe), and the real Linux build ran in a Debian container
  (kernel counters, inodes, scripts, log tailing, Docker via the socket, path-traversal
  refusal). This found and fixed three bugs before release: single-item PowerShell
  results not parsing as lists, stopped-cleanly Windows services being reported as
  failures, and mount `/` matching every mount.
- **UI**: production build, then desktop (1400 px) and mobile (390 px) screenshots of
  every new page and of selection, bulk actions, the type picker, and the form.
- **Not exercised for real** (code paths tested against fakes only): BitLocker and the
  Windows SMART fallback as SYSTEM (the local run was as a normal user), the Linux
  privileged drop-in on a real systemd host, `smartctl`/mdadm/ZFS/storcli on real
  hardware, Hyper-V, NUT/apcupsd, Borg/restic/Veeam, IPMI, real Proxmox and Redfish
  hardware, macOS, and a NetFlow/sFlow exporter on a real network.

## [2.1.0] - 2026-09-23

### Changed

- **Renamed "sites" to "endpoints" throughout the app** — the database table and its
  `site_id` foreign key columns on `hosts`/`checks`, every engine route (`/api/sites` →
  `/api/endpoints`, every `?siteId=` query param and request body field), and all
  dashboard UI labels/copy. A real `ALTER TABLE ... RENAME` migration (hand-written
  rather than `drizzle-kit generate`, whose rename-detection prompt has no
  non-interactive answer in this environment — answering it wrong would have emitted a
  destructive `DROP TABLE` + `CREATE TABLE` instead of a real rename), verified against
  the local dev database to preserve every existing row and relationship with zero data
  loss before being trusted. A second, follow-up migration fixes a gap the first one
  couldn't cover: `dashboard_widgets.config` is an app-managed jsonb blob, not a typed
  schema column, so the table/column rename never touched an existing group-summary or
  alert-history widget's stored `{siteId: ...}` config — caught during real verification
  (an existing widget showed "Endpoint not found" after the rename despite its target
  endpoint still existing) and fixed with a second migration that rewrites the jsonb key
  in place.
- The `group_summary` widget type's internal (wire/database) name is unchanged — only
  its display label and the endpoint it points at were renamed. Renaming the stored
  enum value itself would be a separate, higher-blast-radius change with no material
  benefit, since every existing dashboard's widget rows already reference it by that
  name.

### Added

- **Section header widget**: a full-width labeled divider for grouping other widgets
  visually within one dashboard (e.g. "Network", "Backups"), instead of only being able
  to separate concerns via entirely separate dashboards. Not a data tile and not
  collapsible — click to name it, the same edit-in-place interaction the note widget
  already uses.

### Notes

- Verified for real: the rename migration's data integrity was checked directly against
  the database (identical ids/names/relationships, both foreign key constraints
  correctly renamed) before any code changed to depend on it; the real pre-existing
  "Homelab" endpoint and its hosts/checks/dashboard widgets were confirmed to render
  correctly after both migrations, in a real browser, before and after a page reload;
  adding a new endpoint and a section-header widget were both exercised end-to-end
  through the real UI, including the section header's text surviving a reload; desktop
  and mobile screenshots taken of the renamed Manage/Hosts pages and the new widget.

## [2.0.0] - 2026-09-22

Versioned as a major bump per explicit direction — this round adds real new check
categories (OS thresholds, SNMP/OID) and a real shift in how history is queried
(time-windowed rather than a fixed last-N), even though every API addition is itself
backward-compatible. The agent binary didn't change this round (still v1.2.0) — only
the engine and dashboard move to 2.0.0.

### Added

- **OS threshold checks** (`host_cpu`/`host_memory`/`host_disk`): alert on CPU/memory/
  disk usage the agent has reported every cycle since v1.0.0 but nothing ever alerted
  on. Evaluated on report arrival (`POST /api/agent/report`), no new agent code or poll
  cycle — same "evaluate on report" shape already used for service/process checks.
  Both warn/critical thresholds are optional; a check with neither just tracks history.
- **SNMP/OID checks**, for UPS's, switches, and other SNMP-speaking network gear.
  Supports v1, v2c, and v3 (auth/priv) via `net-snmp`. Four independent optional
  thresholds (warn/critical, above/below) rather than a single operator, since some
  OIDs warn low (battery %) and others warn high (temperature, load). The check form
  includes a preset dropdown for common UPS-MIB OIDs (battery charge/status, load,
  minutes remaining, input voltage) so getting started doesn't require knowing raw
  OIDs — free text still works for anything else.
- **Time-based, filterable history** on every history-backed widget: `GET /api/checks/
  :id/results` and `GET /api/hosts/:id/metrics` both gained an optional `since` (ISO
  timestamp) query param. The host-metrics and uptime-history widgets each gained their
  own range control (1 hour–30 days), persisted per-widget (`config.rangeHours`) rather
  than as a global setting, so two widgets on the same dashboard can show different
  windows independently.
- **Five new dashboard widgets**: alert history (recent alert events, filterable to one
  site or all, with its own range control — backed by a new `GET /api/alert-rules/
  events` route), network bandwidth (RX/TX sparklines from `hostMetrics`, collected
  since v1.0.0 but never visualized), an all-hosts grid (every host's online/offline
  status at a glance, based on last-seen recency), backup status (the most recent
  backup run), and a clock/date tile.
- **In-app help**: a short intro line at the top of Manage, Hosts, Channels, Backups,
  and Logs, linking into a new `docs/user-guide.md` — day-to-day usage covering sites/
  hosts/checks (including the new check types), dashboards/widgets, channels, backups,
  and logs. Distinct from the existing ops-focused `docs/deployment-guide.md`.
- Lightened the dashboard's near-black theme (`--bg`/`--panel`/`--border`) so panels/
  cards read as distinct surfaces instead of blending into the page background — still
  a dark theme, just with real separation. Contrast re-checked against WCAG AA (4.5:1)
  before finalizing: text stays ~13-15:1 and muted text ~5.9-6.8:1 against both the new
  background and panel colors.

### Fixed

- Two real bugs caught during this round's own verification, both the same shape —
  a hand-maintained "list of valid types" that a new check/widget type needs adding to
  separately from the schema, silently going stale: `services/scheduler.ts` kept its
  own copy of "which check types are agentless" that never got the new `snmp` type
  added, so SNMP checks were created successfully but silently never actually probed;
  `routes/dashboards.ts` kept its own copy of "valid widget types" that never got the
  5 new widget types added, so every new widget type was rejected with a 400 on
  creation. Both are now derived directly from the schema's own enum value lists
  (`AGENTLESS_CHECK_TYPES`, and `dashboards.ts` reading `widgetType.enumValues`
  directly) instead of hand-duplicated, so this class of bug can't recur for a future
  new type. Regression tests added for both.

### Notes

- Verified for real: SNMP v1/v2c and v3 (auth/priv) against real `snmpd` daemons in
  Docker (community/creds correct and wrong, unreachable host, real values returned);
  OS threshold evaluation exercised through the real API end-to-end (not just the
  isolated prober test) with real warn/critical results recorded; the scheduler bug
  above was caught specifically because an SNMP check created through the real API
  never produced a result under real observation, not assumed from a passing test; all
  five new widgets added through the real dashboard UI with real data (host metrics,
  alert history including a real triggered alert, all-hosts online/offline, a real
  "ERROR — spawn borg ENOENT" backup status, a live clock); a widget's chosen time
  range confirmed to persist across a page reload; desktop and mobile screenshots taken
  of the new theme and every new widget/check-type form.

## [1.4.0] - 2026-09-22

### Added

- **Three new dashboard widget types**: a host metrics widget (CPU/RAM/disk sparklines
  for one host, reusing the same hand-rolled `Sparkline` component every other trend
  line in the app already uses — no new charting dependency), a standalone uptime/
  history widget (the uptime %/sparkline that's always lived embedded inside a status
  tile, now available as its own tile), and a note widget (free text, edited in place
  in the dashboard's existing edit mode — the one widget type whose content doesn't
  point at an existing check/site/host, since there's nothing to pick at add-time).
- **Duplicate a dashboard**: copies every widget (type, config, and exact position)
  to a new dashboard in one click, instead of rebuilding a similar layout by hand.
- **Per-dashboard refresh interval**: was a single hardcoded 15-second constant for
  every dashboard; now editable per dashboard (5s–5m).
- New `GET /api/hosts/:id/metrics` route — the host metrics table has been written to
  by the agent's report endpoint since v1.0.0, but nothing ever read it back until now.

### Notes

- The uptime-history data-fetching logic (`api.checkResults` + the uptime-%/sparkline-
  point math) was extracted from `StatusTile`'s embedded `CheckHistory` into a shared
  `useCheckHistory` hook, used by both the embedded version and the new standalone
  widget — one implementation, not two copies to keep in sync.
- Verified for real: host metrics and uptime-history widgets rendering real numbers
  from real API data (a live agent report and real check results, not mocked), a note
  edited in place and confirmed to survive a reload, and a duplicated dashboard
  confirmed via the database to have copied every widget's type/config/position
  exactly. One rabbit hole during verification turned out to be a false alarm: widgets
  briefly showed "no data yet" under this session's unusually heavy concurrent load
  (many stacked browser/dev-server processes from back-to-back verification runs) —
  traced with actual render/fetch logging before concluding the code was correct and
  just slow under that load, not assumed.

## [1.3.0] - 2026-09-22

### Fixed

- **Email alerts had no way to actually be configured**: SMTP settings were
  env-var-only (`engine/.env`'s `SMTP_HOST`/`PORT`/`USER`/`PASSWORD`/`FROM`), with
  nothing in the dashboard to set them — the reported symptom was "email
  notifications aren't working." Added an SMTP settings section to the Channels page
  (host/port/user/write-only password/from, same pattern as the Backups page's
  repository settings) plus a "Send test email" button to confirm it actually works
  without waiting for a real alert. The env vars still work as a fallback per-field, so
  an existing `.env`-based setup doesn't silently break. Verified for real, not just
  written: settings saved through the actual dashboard form, a test email sent by
  clicking the real button, and its arrival confirmed in a real SMTP test server's
  inbox (correct from/to/subject/body).

## [1.2.0] - 2026-09-22

### Added

- **Windows and macOS agent install, scripted** — previously only Linux had a one-command
  install; Windows and macOS were manual (NSSM/Task Scheduler, launchd) and explicitly
  untested. The Hosts page now shows two install commands (a toggle switches between
  them): the existing Linux/macOS one-liner (the bash bootstrap already detected both via
  `uname`; it just never finished the macOS install before now) and a new PowerShell
  one-liner for Windows, which registers a Scheduled Task (startup trigger, runs as
  `SYSTEM`, restart-on-failure) using only built-in cmdlets — no third-party service
  wrapper. The Windows path's argument-passing needed a real fix during development: a
  first attempt bound the agent key via PowerShell's `$args[0]`, which turned out not to
  work at all through `-Command`/`iex` (that binding is `-File`-only) — caught by
  actually running it, not assumed, and fixed with an environment-variable handoff
  instead. Verified for real on a real Windows host up to the point this sandbox's lack
  of admin rights allowed (download + config + the elevation check); macOS is scripted
  identically to Linux but honestly flagged as unrun on a real Mac (none available).
- **Push-to-update**: the Hosts page shows each host's running agent version next to the
  engine's current buildable version, with an "Update agent" button. Clicking it flags
  that host (a one-shot server-side flag, not a persistent "desired state"); the agent
  notices on its next poll, downloads the current build for its own platform, swaps
  itself in, and relaunches — no re-running the install script by hand. Verified for
  real, not simulated: an old build running in a real container was flagged via the
  real API and autonomously updated itself, with the engine confirming the new version
  on its next report. The Windows binary-swap-while-running sequence (rename the
  running exe aside, move the new one into place) was verified against a real running
  executable on a real Windows host before being relied on — Windows generally blocks
  overwriting a running executable outright, but renaming one aside turned out to work
  cleanly.
- **HTTP checks can require specific response text**: a new optional field checks that
  the response body contains a given string, in addition to (not instead of) the status
  code check — catches endpoints that return 200 even when something's actually wrong.

## [1.1.0] - 2026-09-22

### Added

- **Real OS-service checks, split from process checks.** `agent_service` used to just
  substring-match a name against the running process list — that's genuinely useful, but
  it isn't the same thing as "is this service actually registered and active." It's now
  a real query against the OS service manager (`systemctl` on Linux, the Windows service
  manager via PowerShell), and the old behavior lives on as a new `agent_process` type.
  Existing checks migrated automatically (a `RENAME VALUE` on the Postgres enum moves
  every existing row in one atomic step — no data loss, no manual fixup) onto
  `agent_process`, the name that actually describes what they've always done.
  Both platforms verified for real: Linux against a real systemd container (a known-
  active unit, a nonexistent one, and a live service list), Windows natively against a
  real Windows service on this dev machine — the first attempt at the Windows path used
  a `$args[0]`-binding pattern that turned out not to work at all through PowerShell's
  `-Command` (only `-File` binds trailing args that way); caught by actually running it,
  not by assuming, and fixed with an environment-variable handoff instead.
- **Service/process name suggestions.** The agent now reports every process name and
  every registered service name it finds on each report cycle; the check form offers
  them as a native suggestion list once a host is selected, instead of requiring an
  exact name typed blind. Verified end-to-end with a real agent running in a real
  container reporting real discovered names into a real check form.
- **HTTP check extras**: custom headers, an HTTP method override, and a "skip TLS
  verification" option for self-signed/internal HTTPS endpoints (the fetch-based
  prober has no per-request way to do that, so this one case switches to Node's
  `https` module directly). Verified against real local HTTP/HTTPS test servers — a
  custom header actually arriving, the method actually changing, and the self-signed
  endpoint failing by default but succeeding once skip-verification is on.
- Disabled checks are now hidden everywhere except `/manage` (where you'd go to
  re-enable one) — dashboard widgets show a small "disabled" note instead of a dead,
  unchanging tile, and drop out of group-summary counts.
- The dashboard's "add widget" check picker now shows each check's site (and host, for
  agent-driven checks) alongside its name, so picking the right one doesn't require
  guessing once there's more than a couple.

## [1.0.1] - 2026-09-22

### Fixed

- **The new check-form host selector showed no hosts even when several were
  configured**, found immediately after 1.0.0 went to production. It was scoping the
  selector to hosts registered under the check's own site — but a check's `hostId` has
  no actual constraint tying it to the check's own site (`engine/src/routes/checks.ts`
  never enforced one), and in practice hosts commonly live under a different site than
  the checks that reference them (e.g. all hosts registered under one central site,
  with checks organized under separate per-service sites). The selector now lists every
  host regardless of site, labeling any host from a different site than the current one
  (e.g. `WebProxy Server (NextCloud Server)`) so it's clear which site actually owns it.

## [1.0.0] - 2026-09-22

Now running in production on a real homelab server with an agent reporting in — the
first release versioned as a stable milestone rather than a v1-in-progress skeleton.

### Fixed

- **Agent-service checks never received results**: the "add check" form never had a way
  to associate any check with a host at all, so every check was created with
  `hostId = null`. The engine's `/api/agent/config` endpoint filters strictly on
  `hostId`, so a null-hostId check could never match a real host and was silently
  excluded from every config response the agent polls — no error anywhere, just an
  empty check list forever. Added a host selector to both the add and edit check forms
  (required for `agent_service` checks, optional otherwise), added `hostId` support to
  the checks `PATCH` route so an already-broken check can be fixed via the UI instead of
  delete/recreate, and added a defensive `400` on `POST /api/checks` for an
  `agent_service` check with no host — this class of bug is now a visible API error
  instead of a silent no-op.
- **Dashboard widgets didn't stay where they were arranged**: react-grid-layout's default
  vertical compaction/collision avoidance means moving or resizing one widget often
  shifts others too, and only the directly-touched widget's new position was being
  persisted — every widget displaced as a side effect kept its stale DB position and
  snapped back on the next reload (and could visibly overlap in the meantime). Now
  persists every widget whose position actually changed in the settled layout, not just
  the one dragged.

### Added

- **Leveled server logging + an in-app Logs page** (`/logs`). Four levels
  (`debug < info < warn < error`); every level except `debug` carries a human-readable
  translation alongside the technical detail, enforced at the type level. Persisted to a
  new `logs` table (pruned daily past `LOOKSEE_LOG_RETENTION_DAYS`, default 30) in
  addition to the existing stdout/pm2 output, so restarts don't lose history. Every
  existing `console.error` in server-runtime code (scheduler, alerting, webpush, backups,
  the global error handler) now goes through this instead, each with a plain-language
  explanation added. New debug-level instrumentation on the agent's `/config` and
  `/report` endpoints and the scheduler's tick — the exact visibility that would have
  made the agent-service bug above obvious immediately instead of requiring a full
  investigation.
- **App version stamped into the database** (`app_meta`, upserted on every successful
  boot, not just deploys) — reflects what's actually running rather than what a deploy
  script assumed. Backup filenames (both the in-app Borg backups and the manual
  `scripts/backup.sh`/`update.sh` snapshots) now read this and stamp themselves
  `<name>-v<version>-<timestamp>`, so the right snapshot for a rollback is a directory
  listing away, not a timestamp cross-reference against this file.
- **Version-pinned deploy/rollback**: `scripts/update.sh` now accepts an optional git
  tag argument (`./update.sh v0.3.1`) to check out instead of pulling latest — the same
  command deploys the newest version or rolls back to an older one. Rollback is
  code-only and always safe; a non-additive schema change since the target version needs
  a database snapshot restore instead, documented plainly (never automatic) in
  `docs/deployment-guide.md`'s new "Rolling back" section.

### Changed

- README's status line updated — this project is now actually deployed on a real
  homelab server, not just locally verified; the stale "not yet deployed anywhere real"
  line was wrong as of this release.

### Notes

- This release also closes out a standards audit against the project's global
  development standards, queued earlier by peer sessions and requested directly by the
  user this round: staging environments remain explicitly out of scope (this project's
  own `CLAUDE.md` already opts out as a solo tool), a metrics/observability panel beyond
  `/api/health` remains an optional future hook rather than a requirement, and the
  security baseline (rate limiting, cookie flags, bcrypt, CORS) was re-checked with no
  gaps found.

## [0.3.1] - 2026-09-22

### Fixed

- **Deployment guide's Caddy example never routed `/install/*` to the engine** — only
  `/api/*` was matched, so on a single-domain path-routed deployment the one-line agent
  install command (added in 0.3.0) 404'd against the dashboard instead of reaching the
  engine. Found on the first real deployment of that feature, not caught during
  development since the local dev setup talks to the engine and dashboard on separate
  ports directly, with no reverse proxy in between to have this gap. Fixed the example
  Caddyfile in `docs/deployment-guide.md`, with a callout for anyone updating an
  existing Caddyfile from before agent install automation existed.
- Also found and fixed on the same real deployment, unrelated to the routing gap: the
  engine process had been restarted after every previous update *except* this one — a
  reminder that `scripts/update.sh` handles this correctly (it restarts both processes
  together) but a manual `pm2 restart looksee-dashboard` alone does not. No code change
  for this one; noted here since it's what made the missing `installCommand` field hard
  to diagnose at first (looked like a rendering bug, was actually a stale process).

## [0.3.0] - 2026-09-18

### Added

- **`agent/build-all.sh`**: cross-compiles the agent for every supported platform
  (linux/amd64, linux/arm64, windows/amd64, darwin/amd64, darwin/arm64) in one command,
  falling back to the `golang` Docker image automatically when there's no local Go
  toolchain — no flag needed, same detection this project has used manually all along.
- **One-command agent install**: generating a host's agent key now also returns a
  ready-to-run command (`curl -fsSL <engine>/install/agent.sh | sudo bash -s -- <key>`),
  shown prominently in the Hosts page with a copy button. It detects the target host's
  OS/arch, downloads the matching binary the engine serves from `agent/bin/`, writes the
  config with the key already filled in, and — on Linux — installs and starts it as a
  systemd service using the engine's own `agent/install.sh` (fetched and run, not
  reimplemented, so there's one authored copy of the install logic). Windows/macOS
  download the binary + config but don't auto-install as a service yet.
- New unauthenticated `/install/*` route group on the engine (`agent.sh`, `install.sh`,
  `looksee-agent.service`, `agent/:platform`) — deliberately outside `/api` and outside
  auth, since a host bootstrapping the agent for the first time has no session yet and
  none of this is sensitive on its own (the real credential is the per-host key, baked
  into the command by routes/hosts.ts, which stays behind the existing session auth).
- New `PUBLIC_URL` engine env var — this engine's own reachable URL, used to build the
  install command and bake into the bootstrap script it serves.

### Verification

- Ran the actual generated one-liner, verbatim, in a fresh systemd container: a real
  agent key from the dashboard's own API, `curl | sudo bash -s -- <key>` exactly as
  shown in the UI, confirmed the systemd service came up `active`+`enabled`, and
  confirmed the resulting host's `lastSeenAt` updated on the engine afterward — proving
  the whole chain (build → serve → download → configure → install → report) works
  together, not just each piece in isolation.
- `agent/build-all.sh` actually run end-to-end (via the Docker fallback, since this dev
  machine has no Go), producing all 5 real binaries.
- New `engine/test/install.test.ts` covers the route group; full suite (13 tests) passes.

## [0.2.1] - 2026-09-18

### Fixed

- **Illegible `<select>` dropdown text**: the closed box inherited the dark theme fine,
  but browsers render the *expanded* options list with their own default colors
  (usually black-on-white) unless the element has an explicit, non-transparent
  background — `bg-transparent` alone doesn't reach the native popup. Fixed with one
  global rule (`select, select option` in `globals.css`) rather than patching each of
  the five forms individually. Verified by actually opening a dropdown in a real
  browser and screenshotting it, not just reasoning about CSS cascade layers.

## [0.2.0] - 2026-09-18

### Added

- **Edit and delete everywhere**: sites (rename/delete), checks (edit/delete, previously
  only creatable), hosts (edit name/hostname/OS, delete already existed), and channels
  (rename, and a separate "update config" flow for the write-only parts) — all backed by
  engine PATCH/DELETE routes that already existed but had no dashboard UI. Checks
  previously had no delete at all.
- **Structured check config fields**, replacing the raw-JSON textarea: a real form per
  check type (URL + expected status for HTTP(S), host + port for TCP, etc.) shared
  between the add and edit forms (`CheckConfigFields`), with client-side validation
  before submit. Directly serves the "HTTP(S) check" ask — it was already a supported
  check type, but adding one meant hand-writing a JSON blob; now it's just two fields.
  The same treatment was applied to notification channels (`ChannelConfigFields`).
- **Tooltips** throughout — a small reusable `Tooltip` component (CSS-only hover/focus
  reveal, no library) explaining what each check type does, what config fields mean,
  and how backup settings (repository, passphrase, cron schedule, retention, SSH key)
  and alert thresholds work, right where you'd need to know it instead of only in
  docs.

### Verification

- Full live click-through in a real browser, not just typechecked: added an HTTP(S)
  check via the new structured fields, hovered a tooltip and confirmed it renders,
  edited and deleted a check, renamed a site, edited a host's hostname/OS, and
  updated a channel's config — zero console errors across all of it. Engine test
  suite (10 tests) still passes; no backend changes were needed since every
  PATCH/DELETE route this relies on already existed.

## [0.1.2] - 2026-09-18

### Fixed

- **`npm run db:create-admin` echoed the password in plaintext** as you typed it — Node's
  `readline` has no built-in masking. Found by the user during the actual first-deployment
  admin bootstrap on `nextcloud`. Fixed using Node's own documented pattern for masked
  terminal input (a muted custom output stream toggled around just the password prompt) —
  no new dependency. A first attempt used the third-party `read` package instead; dropped
  after it hung on the second sequential prompt (reproducible even over piped input, before
  any real terminal was involved) — the Node-native approach doesn't have that failure mode
  and keeps the script's original single-readline-interface structure intact.

### Notes

- Verification gap, stated plainly: this sandboxed dev environment has no way to allocate
  a real PTY, so the actual on-screen masking couldn't be visually confirmed here — only
  that the script still reaches the same execution points as before (typecheck clean,
  same pre-existing piped-input behavior at the multi-question boundary, unchanged from
  before this fix). Worth an actual look the next time this runs in a real terminal.

## [0.1.1] - 2026-09-14

### Fixed

- **Fresh deploys couldn't run migrations**: `.gitignore` excluded
  `engine/drizzle/*.sql` (treated like generated build output) while keeping the
  `meta/` snapshots, so the actual migration files were never pushed to the repo —
  `npm run db:migrate` failed on any clone but this dev machine's own with "No file
  ./drizzle/0000_eminent_mathemanic.sql found." Found via a real first deployment
  attempt, not caught locally, since this machine's `drizzle/` directory still had the
  files on disk regardless of what git tracked. Fixed by un-ignoring them and
  committing all three existing migration files.

### Notes

- This is exactly the kind of gap `npm test`/`npm run build` on the dev machine can't
  catch — both only ever ran against a working tree that already had the files
  on disk. A true "fresh clone + fresh install" smoke test would have caught it
  sooner; worth doing before the next deploy-affecting change to this repo's tracked
  files.

## [0.1.0] - 2026-09-13

Initial build: a working v1 skeleton (engine + Go agent + dashboard), verified
end-to-end rather than just written, with real bugs found and fixed along the way.

### Added

**Engine** (Node/Express, Postgres via Drizzle ORM)
- Session-cookie auth for the single admin user; CRUD for sites/hosts/checks/channels/
  alert-rules/dashboards.
- An agentless prober (ping, TCP, HTTP, DNS, SSL cert expiry) driven by a polling
  scheduler, and an agent-ingest endpoint for host metrics + service status.
- An alert-rule engine dispatching to email, generic webhook (Discord/Slack/ntfy/
  Telegram-shaped), and Web Push channels.
- A Borg-backed encrypted/deduplicated backup system: guarded typed-confirmation
  restore, dedicated auto-generated SSH keypair for remote repositories, cron
  scheduling, retention pruning, run history.
- `engine/test/`: vitest + supertest against a real local Postgres (health, auth,
  backups, dashboards/widgets incl. cascade-delete).

**Agent** (Go)
- Single static cross-platform binary reporting host metrics (CPU/RAM/disk/net) and
  named-service status to the engine on an interval; cross-compiles for Linux, Windows,
  and macOS with no separate toolchain per target.
- Linux systemd install (`install.sh`/`uninstall.sh`): dedicated unprivileged system
  user, mode-600 config, `Restart=on-failure`. Windows (NSSM/Task Scheduler) and macOS
  (launchd) documented but not scripted.

**Dashboard** (Next.js, installable PWA)
- Login; a multi-dashboard, drag-arrangeable widget canvas (`react-grid-layout`) with
  status-tile and group-summary widgets, each status tile showing uptime % and a
  latency sparkline plus an inline alert-rule manager.
- `/manage` (sites/checks), `/hosts` (agent key issuance), `/channels`, `/backups` —
  every engine feature reachable through the UI, not just the API.
- Web Push opt-in (service worker + VAPID subscription).

**Deployment**
- `docs/deployment-guide.md`: Caddy (single-domain, path-routed so engine and
  dashboard are same-origin), pm2, firewall, backups, troubleshooting.
- `scripts/update.sh`/`backup.sh`/`restore.sh` (manual pg_dump-based fallback
  alongside the in-app Borg backup) + `ecosystem.config.cjs`.

### Fixed during development (verification caught these before they shipped)

- **Backup restore silently did nothing**: a plain `pg_dump` (no `--clean --if-exists`)
  can't restore onto a non-empty database — every statement errors "already exists"
  and the restore reports success while changing zero rows. Fixed by adding
  `--clean`/`--if-exists` to both the manual scripts and the Borg pipeline's
  `pg_restore` call; re-verified with a real backup → modify → restore cycle.
- **Status conveyed by color alone**: the palette validator failed Looksee's up/down
  dot colors for colorblind-safe separation (ΔE 2.2, deuteranopia). Fixed by adding an
  explicit text label next to every status dot, dashboard-wide.
- **Mobile nav overflow**: the header nav grew from 2 to 5 links and started clipping
  content off-screen at 390px width — caught by re-screenshotting mobile after the
  change. Fixed with `flex-wrap`.
- **"Add widget" inconsistently gated**: available with zero widgets, but hidden behind
  edit mode once a dashboard had any — caught while writing the click-through test for
  the feature itself, before it shipped.

### Verification notes (what's proven vs. what still needs a first real run)

- Real end-to-end runs on a local dev machine: a live Postgres, a real compiled agent
  binary reporting host metrics to the engine, the dashboard rendering live check
  results and a widget drag surviving a page reload (proving it round-tripped through
  the API to Postgres, not just local state).
- The Borg CLI command shapes (`init`/`create`/`list --json`/`extract`/`prune`/`info`)
  were verified against a real installed `borg 1.2.4` binary in an isolated container;
  the Linux systemd agent install was verified in a real systemd container (active +
  enabled, running as the unprivileged user, auto-restart on `SIGKILL` confirmed,
  both uninstall modes). Every shell script passes `shellcheck` clean.
- **Not yet exercised**: the full Borg backup pipeline integrated against this app's
  own database on a real Linux deployment (only the manual pg_dump path has been run
  end-to-end); the Windows/macOS agent install paths on an actual host of either OS.

### Notes

- Project scoped 2026-09-13: architecture, data model, v1 check types, alerting, and
  dashboard approach decided — see `spec.md`.
