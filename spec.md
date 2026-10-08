# Looksee — Project Spec

A self-hosted monitoring engine for LAN/WAN devices, services, and processes — built to be
genuinely simple to configure day-to-day, unlike Zabbix (powerful but requires near
full-time sysadmin knowledge just to add a basic check). Closer in spirit to Uptime Kuma /
Beszel: an opinionated, fixed set of check and widget types instead of a generic templating
engine.

Status: **v3.0.0 built.** This doc started as the v1 scoping spec; the sections below
marked "v1" describe that original scope. 3.0 (see "v3.0 scope" at the end and
`CHANGELOG.md`) greatly widened the check catalog and management features. Update this
doc as decisions change rather than letting it drift from reality.

## Goals

- Monitor reachability, host metrics, service/process status, and website/API uptime
  across both LAN (homelab, pfSense-managed VLANs) and WAN targets.
- A cross-platform agent for host-level metrics that's a single binary, no runtime
  dependency to install.
- A web dashboard with drag-arrangeable widgets — no query builder, no templating
  language, no discovery-rule DSL.
- Configuring a new check should be a short form, not a multi-step wizard through
  templates/items/triggers/macros.

## Non-goals (for v1)

- Multi-tenant / role-based access — single admin user only.
- A generic metric query language or custom dashboard-per-widget scripting.
- Network auto-discovery/scanning — checks are added explicitly. (Added as an on-demand Discovery page in 3.0.)
- A native mobile app — the web dashboard is installable as a PWA instead.

## Architecture

```
┌─────────────┐        push (metrics/status)        ┌────────────────┐
│   Agent      │ ───────────────────────────────────▶│                │
│ (Go binary,  │                                      │                │
│  per host)   │                                      │                │
└─────────────┘                                       │     Engine      │
                                                        │ (Node/Express  │
┌─────────────┐        pull (probe on interval)       │  + Postgres)   │
│ Agentless    │◀───────────────────────────────────── │                │
│ targets      │                                       │                │
│ (ping/TCP/   │                                       └───────┬────────┘
│  HTTP/DNS)   │                                                │
└─────────────┘                                                 │ serves
                                                                  ▼
                                                        ┌────────────────┐
                                                        │  Web Dashboard  │
                                                        │  (PWA, Web Push)│
                                                        └────────────────┘
```

- **Engine** — Node/Express + Postgres, pm2-managed, behind Caddy. Matches the deployment
  pattern already used for Haydrop/Clocker so there's one operational pattern across
  self-hosted apps, not a new one to learn per project.
- **Agent** — Go, single static cross-platform binary (Windows/Linux/macOS). Reports host
  metrics (CPU/RAM/disk/net I/O) and process/service up-down status to the engine on an
  interval. No install-time runtime dependency.
- **Agentless prober** — the engine itself performs reachability-style checks directly
  against targets: ICMP ping, TCP port, HTTP(S) status/latency, DNS resolution, SSL cert
  expiry. No agent needed for "is this up."
- **Dashboard** — web app, installable as a PWA specifically so Web Push works without a
  native app or third-party notification account.

## Data model (conceptual)

```
Site
 └─ Host / Target
     └─ Check (type + config + interval)
         └─ Result (agentless) / Metric (agent-reported)

Alert Rule (attached to a Check or a group of Checks)
 └─ Notification Channel (email / webhook / Web Push / SMS)
```

`Site` exists from v1 even though only one site (the personal homelab) is configured
initially — this is so adding a second network (e.g. the separate church/AV network) later
is a config entry, not a schema migration.

## v1 check types

| Type | Mechanism | Example |
|---|---|---|
| Ping / ICMP reachability | Agentless | Is 10.1.30.5 responding? |
| TCP port check | Agentless | Is 10.1.30.10:5432 open? |
| HTTP(S) status + latency | Agentless | Does `https://app.example.com` return 200 in <500ms? |
| DNS resolution | Agentless | Does `pi.hole` resolve on the LAN resolver? |
| SSL cert expiry | Agentless | Days remaining on `haymondtechnologies.com` cert |
| Host metrics | Agent | CPU / RAM / disk usage, network I/O |
| Process / service status | Agent | Is `postgres`/`nginx`/a named Windows service running? |
| Website/API uptime history | Agentless | Uptime % and latency graph over time for a URL |

## Alerting

- Rule engine evaluates on each check result — supports a "down for N consecutive checks"
  threshold to avoid alert flapping on a single blip.
- Channels are pluggable per rule/group:
  - **Email** — always-on default, no extra config required to get basic alerting working.
  - **Web Push** — via the installable PWA, no third-party account needed.
  - **Webhook** — generic POST, covers Discord/Slack/ntfy/Telegram (Telegram via its bot
    API, effectively a webhook-shaped integration).
  - **SMS** — via a provider (Twilio or similar) once configured; not required for v1
    to be usable.
- A check/rule with no channel configured just shows on the dashboard silently — alerting
  is opt-in per rule, not global.

## Dashboards & widgets

**Built** (v1): a drag-arrangeable canvas at `/`, multiple named dashboards, two widget
types:
- **Status tile** — one check: status dot + text label (never color alone — see
  CLAUDE.md/CHANGELOG on the colorblind-accessibility finding), last-checked time,
  uptime % and a latency sparkline over its recent history, and an inline alert-rule
  manager. Uptime%/sparkline ended up folded into this one widget rather than shipping
  as separate widget types — splitting them added a config surface (which check does
  this sparkline widget point at, distinct from its status tile?) without adding
  anything a reader couldn't already see at a glance in one card.
- **Group summary** — one site: "N/M up" badge plus a compact per-check status list.

**Not built as separate widget types**: a standalone "uptime %" widget, a standalone
"latency sparkline" widget, and a "service/process list grouped by host" widget — the
first two are covered by the status tile above; the host-grouped service list never
had a concrete enough shape to justify building ahead of a real need. All three remain
straightforward additions to the same `widget_type` enum (`engine/src/db/schema.ts`)
if a real use case shows up.

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Engine | Node/Express, Postgres via Drizzle ORM | Matches Haydrop's actual stack (corrected from an earlier "no ORM" note that mixed it up with Homebase's sync server) |
| Agent | Go | Single static cross-platform binary, no runtime dependency |
| Dashboard | Web app (PWA) | Enables Web Push without a native app; one codebase |
| Process manager | pm2 | Per standing dev standards |
| Reverse proxy | Caddy | Per standing dev standards |
| Backups | Postgres dump + existing Borg/HavenBackup pattern | Per standing dev standards |

## Deployment scope

- Runs in the personal homelab (pfSense-managed VLANs), likely the Servers VLAN.
- WAN reachability checks (external site uptime, checks run from outside the LAN) are
  in scope for v1 since the engine itself can reach the public internet.
- Single admin user (Jason) for v1 — no role system. Health endpoint, log viewer, and an
  update-visibility panel are still included per standing dev standards even for a
  single-user tool.
- Staging environment: skipped for v1 (solo tool, low blast-radius) — revisit if this
  ever grows beyond personal use.

## Deferred / future ideas

- Native mobile app (if PWA + Web Push proves insufficient).
- SMS alert channel (needs a provider choice).
- SNMPv3 traps (v1/v2c traps are received today).
- Kubernetes monitoring (explicitly out of scope for 3.0).
- Multi-step HTTP transactions / login flows (explicitly out of scope for 3.0).

## v3.0 scope (built)

Chosen from a survey of Zabbix, Nagios/Icinga, PRTG, Checkmk, LibreNMS, Netdata,
Prometheus exporters, Datadog and Uptime Kuma. Every check type is listed in
`docs/user-guide.md` → Check type reference.

- **Engine probes**: ping with loss/jitter, TCP, UDP, HTTP(S) with body/regex/JSON/
  redirect/latency checks, headless-browser, DNS (any record, chosen resolver, DNSSEC),
  TLS (chain, hostname, weak protocols), domain expiry (RDAP), WebSocket, SMTP/IMAP/POP3/
  FTP/SSH/LDAP/RDP, email round-trip, NTP, DHCP (rogue detection), gRPC, MQTT, container
  registry, traceroute path change, public IP change, ARP presence, databases (Postgres,
  MySQL, SQL Server, Redis, MongoDB — connect plus internals), Prometheus scrape, web
  server status pages, app integrations (Nextcloud, Home Assistant, Plex, Jellyfin,
  Pi-hole, JSON), SNMP templates/walks/rates, SNMP interface tables, trap/syslog
  matching, Redfish/IPMI hardware, Proxmox, VMware.
- **Agent**: extended host snapshot (62 metrics incl. per-core CPU, all mounts, inodes,
  disk I/O, interfaces, TCP, temps, battery, SMART, RAID/ZFS, updates, Defender,
  firewall, encryption, clock, failed logins), and checks for services (restarts),
  processes (resources), failed/stopped services, scheduled tasks, scripts, files and a
  folder watchdog, logs, journal, Windows Event Log, perf counters, Docker, Hyper-V, VPN,
  UPS, backups; plus ping/TCP/HTTP/DNS/TLS as a remote probe.
- **Engine features**: warn/critical thresholds everywhere, retry intervals,
  dependencies, flap detection, re-notify and escalation, maintenance windows, SLA
  reports, public status pages, heartbeats/pushed values, anomaly baselines, disk-full
  forecasts, reboot and change detection, suggested checks per host, on-demand network
  discovery, SNMP trap/syslog/NetFlow/IPFIX/sFlow receivers, data retention.
- **Management UI**: filterable/groupable check table, a searchable type picker with one
  schema-driven form for every type, and multi-select bulk actions on checks, hosts and
  endpoints.
