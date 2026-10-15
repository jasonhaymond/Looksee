# Looksee

A self-hosted monitoring engine for LAN/WAN devices, services, and processes — simple to
configure day-to-day, unlike Zabbix. See [`spec.md`](spec.md) for the full project spec.

**Status**: v4.3.0 — 57 check types across the engine and agent (reachability, web,
real-browser, DNS/DNSSEC, TLS, mail/SSH/LDAP/RDP, NTP/DHCP, databases, Prometheus,
app integrations, SNMP templates/walks/interface tables, printers, traps/syslog,
Redfish/IPMI, Proxmox, VMware, Hyper-V, Docker, 60+ host metrics, files and folder
watchdog, logs, event log/journal, scripts with expected output, backups,
heartbeats/pushed values, IP change by MAC, anomaly detection), locations and multi-site
monitoring (site collectors and direct push), email/Slack/Teams/Telegram/webhook/push
alerts with message templates and remediation hints, per-check history pages and alert
history, host process/service inventory, smart suggested checks, maintenance windows,
dependencies, escalation, SLA reports, public status pages, discovery, NetFlow/sFlow top
talkers, light/dark themes, in-app help, and a security layer (required two-factor
sign-in with passkey/security-key support, lockouts, IP allowlist, new-IP email
confirmation, attack detection with auto-blocking, and an outbound watchdog for
Looksee's own outages). Built and verified end to end locally (see [`CHANGELOG.md`](CHANGELOG.md)
for exactly what was tested how); the homelab server runs the 3.x line.

**Current version: v4.3.0** — what's new is in [`CHANGELOG.md`](CHANGELOG.md#430---2026-10-15)
(4.3 adds the release security gate and approval-checked deploys; 4.2 shows every time
in your local time zone and adds the VPN-only access guide; 4.1
added passkeys and the watchdog; upgrading from 3.x to 4.x requires setting up
two-factor at your first sign-in — see the 4.0.0 upgrade notes there). See [Deploying](#deploying) for a first deployment and
[`docs/user-guide.md`](docs/user-guide.md) for day-to-day usage (also built into the
app under **Help**).

## Tech stack

| Layer | Choice |
|---|---|
| Engine | Node/Express + Postgres (Drizzle ORM), pm2 in production |
| Agent | Go (single static cross-platform binary) |
| Dashboard | Next.js, installable as a PWA (Web Push support) |
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

**4. Agent** (optional — only needed for host metrics / service checks)

See [`agent/README.md`](agent/README.md). Short version: create a Host in the dashboard,
generate its agent key, copy `agent/looksee-agent.example.yaml` to
`looksee-agent.yaml` with that key, then `go build` and run it.

## Testing

```sh
cd engine && npm test        # vitest + supertest against a real local Postgres
cd dashboard && npm run build  # typecheck + production build
cd agent && go test ./... && go build ./...   # (needs Go, or use the golang Docker image — see agent/README.md)
cd engine && npm run lint    # ESLint (also dashboard: npm run lint)
```

ESLint is pinned to 9.x in the dashboard: the React, import and accessibility plugins
bundled by `eslint-config-next` only support up to ESLint 9. The engine uses ESLint 10.

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
   which checks the approval line and, with `LOOKSEE_PUBLIC_URL` set, runs the
   post-deploy checks (`scripts/security-check.sh --live <url>`).

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
- [`docs/deployment-guide.md`](docs/deployment-guide.md) — first deployment and updating
- [`docs/migration-guide.md`](docs/migration-guide.md) — moving an existing deployment to a new server
- [`docs/user-guide.md`](docs/user-guide.md) — day-to-day usage: checks (adding to many hosts, browsing what the agent found, duplicating, check pages), hosts and inventory, locations and endpoints, multiple sites, discovery, heartbeats, channels and templates, alerting and alert history, maintenance, reports, traps/syslog, top talkers, status pages, dashboards, security, themes
- [`docs/check-reference.md`](docs/check-reference.md) — every check type: what it watches, how it works, its value, and how to check the same thing by hand
- [`docs/security-guide.md`](docs/security-guide.md) — two-factor, lockouts, IP allowlist, new-IP confirmation, attack detection, hardening checklist, recovery
- [`docs/vpn-access.md`](docs/vpn-access.md) — reaching Looksee only through a VPN (admin only, or agents too), with split DNS, Caddy rules, verification and rollback — not applied to production yet
- [`docs/security-audit-2026-10.md`](docs/security-audit-2026-10.md) — the 4.0.0 security and dependency audit: findings, fixes, open items
- [`docs/windows-agent-security.md`](docs/windows-agent-security.md) — the agent with Smart App Control, SmartScreen, Defender, ASR, WDAC/AppLocker and EDRs; signing the agent
- [`CHANGELOG.md`](CHANGELOG.md) — version history
- [`agent/README.md`](agent/README.md) — building and running the Go agent
