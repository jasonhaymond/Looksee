# Looksee

A self-hosted monitoring engine for LAN/WAN devices, services, and processes — simple to
configure day-to-day, unlike Zabbix. See [`spec.md`](spec.md) for the full project spec.

**Status**: v5.10.0 — 65 check types across the engine and agent (reachability, web,
real-browser, DNS/DNSSEC, DNS zone history (by transfer or discovery, with a saved baseline), TLS, mail/SSH/LDAP/RDP, NTP/DHCP, databases, Prometheus,
app integrations, SNMP with an OID dictionary, calculations and reusable templates,
interface tables, printers, traps/syslog, Redfish/IPMI, Proxmox, VMware, Hyper-V,
Docker, 60+ endpoint metrics, installed software with upgradable/changed/vulnerable
checks, local user accounts, largest folders and files, files and folder watchdog,
logs, event log/journal, scripts with expected output or warn/down patterns (run on
their own endpoint or another's), backups, heartbeats/pushed values, calculated values, IP change by MAC, anomaly
detection), organized as **Location → Site → Endpoint → Check** with a sidebar tree and
groups, multi-site monitoring (site collectors — one can serve several networks — and
direct push), agents for Linux, Windows, macOS and Android, email/Slack/Teams/
Telegram/webhook/push alerts with message templates and remediation hints, editable
alert rules, manual and event-driven recovery, exclusions, per-check history pages and
alert history, endpoint process/service inventory, suggested checks plus role, security
and SNMP templates, maintenance windows, dependencies, escalation, SLA reports, public
status pages, discovery, NetFlow/sFlow top talkers, light/dark themes, in-app help, and
a security layer (required two-factor sign-in with passkey/security-key support,
lockouts, IP allowlist, new-IP email confirmation, attack detection with auto-blocking,
and both an outbound watchdog and watchdog agents for Looksee's own outages), plus an
**Android app** with full management and its own alert notifications over a direct
connection to the server (no Google or other third-party push service). Built and
verified end to end locally (see [`CHANGELOG.md`](CHANGELOG.md) for exactly what was
tested how).

**Current version: v5.10.0** — every past result opens to its full details, every alert
carries a timestamp with its time zone (`ALERT_TIME_ZONE`), alert lists show when each
alert ended, and `update.sh` builds the Android app; see
[`CHANGELOG.md`](CHANGELOG.md#5100---2026-11-25) (5.9.0: full check results, DNS zones read
without a transfer, duplicating endpoints, "how to fix" guidance; 5.8.0: the Android app).
5.0 renames what 4.x called endpoints to **sites** and hosts to **endpoints** (in the
database too), adds the sidebar tree, groups, exclusions, recovery options, watchdog
agents, software and vulnerability checks, SNMP templates and calculations, and role
templates. **Before upgrading from 4.x, read
[Upgrading to 5.0](docs/deployment-guide.md#upgrading-to-50)** — rolling back means
restoring the pre-update database snapshot. See [Deploying](#deploying) for a first
deployment and [`docs/user-guide.md`](docs/user-guide.md) for day-to-day usage (also
built into the app under **Help & user guide**).

## Tech stack

| Layer | Choice |
|---|---|
| Engine | Node/Express + Postgres (Drizzle ORM), pm2 in production |
| Agent | Go (single static cross-platform binary) |
| Dashboard | Next.js, installable as a PWA (Web Push support) |
| Android app | Expo / React Native ([`mobile/`](mobile/README.md)); a Kotlin foreground service for notifications; built on the self-hosted build server |
| Reverse proxy | Caddy (production) |

## Local development

**1. Postgres**

```sh
cp .env.example .env   # adjust POSTGRES_HOST_PORT if 5432 is already taken on this box
docker compose up -d
```

**2. Engine**

```sh
cd engine
cp .env.example .env   # set DATABASE_URL to match the port above; generate SESSION_SECRET
npm install
npm run db:generate    # only needed after changing src/db/schema.ts
npm run db:migrate
npm run db:create-admin   # interactive — creates the one admin account
                          # (two-factor is set up at the first sign-in)
npm run dev             # http://localhost:4100
```

Web Push alerting needs a VAPID keypair (one-time, see `.env.example` for the generate
command and the "never regenerate" warning). Email alerting needs `SMTP_*` set.

**3. Dashboard**

```sh
cd dashboard
cp .env.example .env
npm install
npm run dev              # http://localhost:3100
```

Sign in with the admin account from step 2, add an Endpoint, then add a check (ping/tcp/http/
dns/ssl_cert run agentless; agent_service needs the agent below).

**4. Agent** (optional — only needed for endpoint metrics / service checks)

See [`agent/README.md`](agent/README.md). Short version: create an Endpoint in the dashboard,
generate its agent key, copy `agent/looksee-agent.example.yaml` to
`looksee-agent.yaml` with that key, then `go build` and run it.

**5. Android app** (optional)

See [`mobile/README.md`](mobile/README.md). Short version: `cd mobile && npm install`,
then `npx expo start --web` to preview the screens in a browser against the local engine
(add `http://localhost:8081` to the engine's `CORS_ALLOWED_ORIGINS`). Notifications
only work in a real Android build ([deployment guide §12](docs/deployment-guide.md#12-the-android-app)).

## Testing

```sh
cd engine && npm test        # vitest + supertest against a real local Postgres
cd dashboard && npm run build  # typecheck + production build
cd agent && go test ./... && go build ./...   # (needs Go, or use the golang Docker image — see agent/README.md)
cd engine && npm run lint    # ESLint (also dashboard and mobile: npm run lint)
cd mobile && npm run typecheck && node scripts/check-native-versions.mjs   # the Android app
```

ESLint is pinned to 9.x in the dashboard: the React, import and accessibility plugins
bundled by `eslint-config-next` only support up to ESLint 9. The engine uses ESLint 10.

`engine/package.json` has `overrides["@esbuild-kit/core-utils"].esbuild: ^0.25.12`.
drizzle-kit (development only, for writing migrations) loads its config through the
deprecated `@esbuild-kit` loader, which asks for esbuild 0.18. That version has a
dev-server advisory (GHSA-67mh-4wv8-2f99). The override gives it the esbuild drizzle-kit
already uses itself. Remove the override once drizzle-kit drops `@esbuild-kit`. If
`npm run db:generate` ever fails to load `drizzle.config.ts`, this override is the first
thing to check.

Not yet on their latest major version (deferred from 5.6.0 to a dedicated upgrade release,
tracked in [`spec.md`](spec.md)): TypeScript 7, Vitest 5, bcryptjs 3, dotenv 18,
web-push 4, marked 18 and @types/node 26. Each needs its breaking changes read and
migrated rather than a blind bump.

## Security gate and releasing

AI-written code isn't trusted by default: every change goes through the security gate,
and its results are shown to and approved by the developer, before anything is
committed, tagged, pushed or deployed.

```sh
scripts/security-check.sh        # or, from engine/: npm run security
```

It needs Docker (the scanners run in pinned images), Node with `npm ci` done in
`engine/` and `dashboard/`, and the local test database (`docker compose up -d
postgres`). PowerShell 7 with PSScriptAnalyzer (`Install-Module PSScriptAnalyzer -Scope
CurrentUser`) adds the PowerShell check. It runs:

| Layer | Tools |
|---|---|
| Static analysis | Semgrep (OWASP Top 10, TypeScript, Node, Go, secrets), ESLint + eslint-plugin-security, ShellCheck, PSScriptAnalyzer, go vet |
| Dependencies | npm audit (engine, dashboard), govulncheck (agent), npm outdated (information) |
| Secrets | gitleaks — working tree, staged diff, commits since the last release |
| Tests | engine Vitest suite incl. security tests (real Postgres), agent Go tests, TypeScript typechecks |
| Manual | AI diff review: `/security-review` in Claude Code |

**What success looks like:** a summary table of `PASS` / `FAIL` / `NOT RUN` lines ending
in `RESULT: PASS`, and a full report under `security-reports/` (gitignored — reports
describe unpatched weaknesses and this repository is public). New findings in files
changed since the last release block; findings in unchanged files are listed as the
existing baseline. A reviewed false positive is silenced in the code with a comment that
says why; accepted dependency risks live in `security-accepted-risks.json` with a review
date; the two reviewed test fixtures are allowlisted in `.gitleaks.toml`. Changing any of
these is a security decision the developer approves.

**Releasing a version:**

1. Finish the batch of changes; bump the version (engine, dashboard and agent together)
   and add the `CHANGELOG.md` entry.
2. Run the gate, review the report with the developer, fix what they choose, re-run until
   it passes, and get their explicit approval.
3. Commit, re-run the gate on the commit (`scripts/security-check.sh` on a clean tree),
   then tag with the approval recorded — the deploy script refuses tags without it:

   ```sh
   git tag -a vX.Y.Z -m "Looksee X.Y.Z — <summary>

   Security review: approved YYYY-MM-DD, report security-reports/<file>.md, accepted risks: <n or none>"
   git push origin master vX.Y.Z
   ```

4. Deploy with `scripts/update.sh` on the server ([deployment guide §8](docs/deployment-guide.md#8-updating)),
   which checks the approval line, with `LOOKSEE_PUBLIC_URL` set runs the
   post-deploy checks (`scripts/security-check.sh --live <url>`), and, when the server
   has the build server settings in `mobile/.env`, builds the Android app's release APK
   of the same tag ([deployment guide §12](docs/deployment-guide.md#12-the-android-app)).
   Without that setup, build it by hand: `cd mobile && npm run build:android -- --ref vX.Y.Z`.

## Deploying

See [`docs/deployment-guide.md`](docs/deployment-guide.md) — covers Caddy (single-domain,
path-routed so engine and dashboard are same-origin), pm2 process definitions, and
backups. `/backups` in the dashboard is a Borg-backed encrypted/deduplicated backup and
guarded-restore admin page (matching Haydrop's `/admin/backups`); `scripts/backup.sh`/
`restore.sh` are a plain-`pg_dump` manual fallback alongside it. The manual path's
restore has been exercised end-to-end against a real database; the Borg path's CLI
commands were verified against a real `borg` binary, but not yet the full pipeline
against this app's own database on a real deployment — see the deployment guide's
Backups section for exactly what's been proven vs. still needs a first real run.

## Docs

- [`spec.md`](spec.md) — full project spec: architecture, data model, v1 scope, decisions
- [`CLAUDE.md`](CLAUDE.md) — locked project-specific decisions
- [`mobile/README.md`](mobile/README.md) — the Android app: how it's built, how notifications reach the phone, local development
- [`docs/plans/v5.8-android-app.md`](docs/plans/v5.8-android-app.md) — the Android app's design decisions
- [`docs/deployment-guide.md`](docs/deployment-guide.md) — first deployment, updating (with upgrade notes per version) and rolling back, building and installing the Android app
- [`docs/migration-guide.md`](docs/migration-guide.md) — moving an existing deployment to a new server
- [`docs/user-guide.md`](docs/user-guide.md) — day-to-day usage: the Location → Site → Endpoint layout and sidebar, checks (adding to many endpoints, browsing what the agent found, duplicating, editing settings and exclusions on many at once, check pages, resolving and recovery, statistics exclusions, SNMP calculations, software and security checks), endpoints and inventory, suggestions and templates, sites and locations, groups, exclusions, SNMP templates, multiple sites, discovery, heartbeats, channels and templates, alerting and alert history, maintenance, reports, traps/syslog, top talkers, status pages, dashboards, security, watchdog and watchdog agents, themes, the Android app
- [`docs/check-reference.md`](docs/check-reference.md) — every check type: what it watches, how it works, its value, and how to check the same thing by hand
- [`docs/check-settings.md`](docs/check-settings.md) — every setting of every check type, with defaults (generated from the check form)
- [`docs/patching.md`](docs/patching.md) — fixing updates and vulnerabilities that Windows Update, macOS updates or `apt upgrade` leave behind, per OS (also in the app's Help)
- [`docs/plans/check-expansion.md`](docs/plans/check-expansion.md) — recommendations for further checks and templates (not built)
- [`docs/security-guide.md`](docs/security-guide.md) — two-factor, lockouts, IP allowlist, new-IP confirmation, attack detection, hardening checklist, recovery
- [`docs/vpn-access.md`](docs/vpn-access.md) — reaching Looksee only through a VPN (admin only, or agents too), with split DNS, Caddy rules, verification and rollback — not applied to production yet
- [`docs/security-audit-2026-10.md`](docs/security-audit-2026-10.md) — the 4.0.0 security and dependency audit: findings, fixes, open items
- [`docs/windows-agent-security.md`](docs/windows-agent-security.md) — the agent with Smart App Control, SmartScreen, Defender, ASR, WDAC/AppLocker and EDRs; signing the agent
- [`CHANGELOG.md`](CHANGELOG.md) — version history
- [`agent/README.md`](agent/README.md) — building and running the Go agent
