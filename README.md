# Looksee

A self-hosted monitoring engine for LAN/WAN devices, services, and processes — simple to
configure day-to-day, unlike Zabbix. See [`spec.md`](spec.md) for the full project spec.

**Status**: built and verified end-to-end (auth, sites/hosts/checks CRUD, agentless
probing + scheduler incl. SNMP/OID, agent metrics/service ingest with OS threshold
alerting, email/webhook/Web Push alerting, a fully customizable widget dashboard), and
running in production on a real homelab server with an agent reporting in. Current
version: **v2.0.0** — see [`CHANGELOG.md`](CHANGELOG.md) for what changed recently, or
[Deploying](#deploying) below for a first deployment of your own. Day-to-day usage once
it's running is covered in [`docs/user-guide.md`](docs/user-guide.md).

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

Sign in with the admin account from step 2, add a Site, then add a check (ping/tcp/http/
dns/ssl_cert run agentless; agent_service needs the agent below).

**4. Agent** (optional — only needed for host metrics / service checks)

See [`agent/README.md`](agent/README.md). Short version: create a Host in the dashboard,
generate its agent key, copy `agent/looksee-agent.example.yaml` to
`looksee-agent.yaml` with that key, then `go build` and run it.

## Testing

```sh
cd engine && npm test        # vitest + supertest against a real local Postgres
cd dashboard && npm run build  # typecheck + production build
cd agent && go build ./...     # (needs Go, or build via the golang Docker image — see agent/README.md)
```

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
- [`docs/user-guide.md`](docs/user-guide.md) — day-to-day usage: sites/hosts/checks, dashboards/widgets, channels, backups, logs
- [`CHANGELOG.md`](CHANGELOG.md) — version history
- [`agent/README.md`](agent/README.md) — building and running the Go agent
