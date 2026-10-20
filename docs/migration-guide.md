# Migration Guide

Moving an existing Looksee deployment from one server to another — a hardware
replacement, a move off a temporary box, a re-platform to a different VM. This assumes
you already have a working deployment somewhere (see
[deployment-guide.md](deployment-guide.md) if not) and are moving it, data and all, to a
second machine. For day-to-day usage once it's running, see
[user-guide.md](user-guide.md); for local development, see the [README](../README.md).

## Contents

1. [Before you start](#1-before-you-start)
2. [On the old server: take a fresh backup](#2-on-the-old-server-take-a-fresh-backup)
3. [On the new server: install and configure](#3-on-the-new-server-install-and-configure)
4. [Bring over the secrets](#4-bring-over-the-secrets)
5. [Restore the database](#5-restore-the-database)
6. [Build, run, and verify — before cutting over](#6-build-run-and-verify--before-cutting-over)
7. [Reverse proxy, HTTPS, and firewall](#7-reverse-proxy-https-and-firewall)
8. [Agent binaries and the site collector](#8-agent-binaries-and-the-site-collector)
9. [Cut over](#9-cut-over)
10. [Re-point already-installed agents](#10-re-point-already-installed-agents)
11. [Borg backup repository](#11-borg-backup-repository)
12. [Decommission the old server](#12-decommission-the-old-server)
13. [If something goes wrong](#13-if-something-goes-wrong)
14. [Lessons from a real migration](#14-lessons-from-a-real-migration)

## 1. Before you start

**Decide: same hostname, or a new one?** This is the single biggest thing that
determines how much post-migration cleanup you'll do.

- **Same hostname (recommended)** — e.g. `looksee.haymondtechnologies.com` keeps
  pointing at Looksee, just at a new IP once you flip DNS. Every already-installed
  agent, every browser's saved login, every Web Push subscription keeps working with
  zero reconfiguration, because none of them know or care that the IP changed. This is
  the path this guide is written around.
- **New hostname** — every agent's config (`looksee-agent.yaml`) has the old URL baked
  in and needs updating (see [§10](#10-re-point-already-installed-agents)), and every
  browser's existing Web Push subscription breaks (users need to re-enable
  notifications from the new URL — Web Push subscriptions are tied to both the origin
  and the VAPID keypair). Only do this if you actually intend to change the domain.

**What actually needs to move:**

| What | How |
|---|---|
| Database (locations, sites, endpoints, checks, history, users, channels, settings, alert rules, dashboards) | `pg_dump` / `pg_restore` — scripted, see §2 and §5 |
| `engine/.env` and `dashboard/.env` (secrets — `SESSION_SECRET`, VAPID keypair, SMTP fallback, `.env`-based settings) | Copied directly, see §4 |
| Borg backup repository (if local to the old server) | Copied or re-pointed, see §11 |
| Agent binaries and site collector (`agent/bin/`) | **Not migrated** — gitignored build output, just rebuilt fresh on the new server (§8) |
| `node_modules`, `.next`, `dist` build output | **Not migrated** — reinstalled/rebuilt fresh from source, same as any deploy |

**About downtime**: this guide runs the new server fully, verified working, *before*
touching DNS — so the only actual outage is however long DNS takes to propagate after
you flip it (usually seconds to a few minutes with a low TTL, up to the old record's
full TTL otherwise), not the time spent setting the new server up.

**You'll need**: SSH access to both servers, about 45–60 minutes, and the same
prerequisites as a first deployment (see deployment-guide.md
[§1](deployment-guide.md#1-what-youll-need)) on the new server.

## 2. On the old server: take a fresh backup

Take this right before you start the migration, not from an older scheduled backup —
you want the database in its current state, not last night's.

```bash
cd ~/Looksee
./scripts/backup.sh
```

This writes `~/looksee-backups/v<version>-<timestamp>/` containing `looksee.sql.gz`,
`engine.env`, and `dashboard.env`. Confirm it actually wrote something before
continuing:

```bash
ls -la ~/looksee-backups/v*/ | tail -5
```

Copy that whole directory to your local machine (or directly to the new server) —
whichever's easier for you to `scp` from in the next step:

```bash
scp -r you@old-server:~/looksee-backups/v<version>-<timestamp> ./looksee-migration
```

**If you use the in-app Borg backups instead of (or alongside) `backup.sh`**, also note
your repository location and passphrase now — the passphrase is write-only in the UI
and unrecoverable from the app itself if you don't already have it saved somewhere. See
[§11](#11-borg-backup-repository) for what to do with the repo itself.

## 3. On the new server: install and configure

Follow deployment-guide.md's [§2 (prerequisites)](deployment-guide.md#2-install-prerequisites)
and the first half of [§3](deployment-guide.md#3-get-the-code-and-configure) — clone
the repo, start Postgres, install dependencies — but **stop before `npm run
db:create-admin`**. You're about to restore a real database with a real admin account
already in it; running that command now would create a second, unwanted account (or
just be a wasted step — either way, skip it here).

```bash
git clone <your-repo-url> ~/Looksee
cd ~/Looksee

cp .env.example .env   # only if 5432 is already taken on this box
docker compose up -d

cd engine
npm ci
# don't run db:migrate or db:create-admin yet — db:migrate needs a real DATABASE_URL
# in engine/.env first (§4), and the database isn't there to migrate until it's
# restored (§5); db:create-admin is skipped entirely, since the restored database
# already has your real admin account

cd ../dashboard
npm ci
```

Leave `engine/.env` and `dashboard/.env` unwritten for now — you're bringing over the
real ones from the old server in §4, not filling in fresh values.

## 4. Bring over the secrets

Copy the old server's env files over — these hold real secrets that aren't in the
database dump and can't be regenerated, and `engine/.env` specifically has the
`DATABASE_URL` the next section's `db:migrate` needs to connect at all:

```bash
scp you@old-server:~/Looksee/engine/.env ~/Looksee/engine/.env
scp you@old-server:~/Looksee/dashboard/.env ~/Looksee/dashboard/.env
```

**If you're keeping the same hostname**, that's it — every value (`PUBLIC_URL`,
`CORS_ALLOWED_ORIGINS`, `NEXT_PUBLIC_API_URL`, `DATABASE_URL`) is already correct as-is,
since none of them reference the server's IP, only the public domain and the
Docker-internal Postgres port.

**If you changed the hostname**, edit both files now: `PUBLIC_URL` and
`CORS_ALLOWED_ORIGINS` in `engine/.env`, `NEXT_PUBLIC_API_URL` in `dashboard/.env` — all
to the new public URL.

**Never regenerate `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`** — copying them verbatim (via
the `.env` copy above) is what keeps every browser's existing Web Push subscription
working after the move. Regenerating them breaks every subscription silently; users
would need to notice and manually re-enable notifications.

Existing browser sessions stay valid on their own, independent of `SESSION_SECRET` —
sessions are opaque tokens stored in the `sessions` table, restored along with the rest
of the database in §5, not something `SESSION_SECRET` verifies. Copy it over anyway for
consistency; there's no reason to regenerate it as part of a migration.

## 5. Restore the database

With Postgres running (from `docker compose up -d` in §3) and `DATABASE_URL` now set
correctly (from §4):

```bash
cd ~/Looksee
./scripts/restore.sh ~/looksee-migration/looksee.sql.gz
```

Type `RESTORE` to confirm. This loads the old server's complete database — every
location, site, endpoint, check, check-result history, user account, channel, alert
rule, and dashboard — into the new server's fresh Postgres container. A large database
takes a while: a 4 GB one with several million events, flow records and results takes
minutes, not seconds.

```bash
cd engine
npm run db:migrate
```

Run this even if the dump is current — it's a no-op if every migration in the dump was
already applied, and exactly what you want if the old server's backup predates a
migration that's landed since (for example a 4.x old server moving to a 5.x checkout:
the migration renames its tables as part of this step).

**What success looks like**: no errors from either command, and the row counts match
the old server. Before taking the backup in §2, note the same counts on the old server
(on a 4.x server the tables are called `endpoints` for sites and `hosts` for
endpoints):

```bash
docker compose exec -T postgres psql -U looksee -d looksee -c "SELECT (SELECT count(*) FROM sites) sites, (SELECT count(*) FROM endpoints) endpoints, (SELECT count(*) FROM checks) checks, (SELECT count(*) FROM users) users, (SELECT count(*) FROM check_results) results, (SELECT count(*) FROM events) events; SELECT pg_size_pretty(pg_database_size('looksee'));"
```

The small tables (sites, endpoints, checks, users) must match exactly; the big ones
(results, events) match the old server's counts at the moment of its backup. A database
that restored without errors but has far fewer rows than expected points to the wrong
dump file.

## 6. Build, run, and verify — before cutting over

```bash
cd ~/Looksee/engine && npm run build
cd ~/Looksee/dashboard && npm run build
cd ~/Looksee
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the one printed command
```

Verify against the new server directly, **before touching DNS or the reverse proxy** —
either from the new server itself, or from your machine with a `curl --resolve` /
`/etc/hosts` override so you're hitting the new server's IP while still using the real
hostname (needed for cookies/CORS to line up correctly in a real browser check):

```bash
curl -s http://localhost:4100/api/health
```

Expect `{"status":"ok","db":"connected",...}` with the version you expect. If you want
a real browser check of the dashboard itself before DNS is pointed here, add a
temporary `/etc/hosts` entry on your own machine mapping the domain to the new server's
IP, browse to it, sign in with your real (restored) account, and confirm your real
sites/endpoints/checks/dashboards are all there — and open the heaviest pages too (the
Checks list, a busy check's page with 30 days of history, Traps & syslog), not just the
home page: a migration can be "up" and still slow — then remove the `/etc/hosts` entry
before moving on to §7, so you're not left testing against a stale override.

## 7. Reverse proxy, HTTPS, and firewall

Same as a first deployment — see deployment-guide.md
[§5 (firewall)](deployment-guide.md#5-firewall) and
[§6 (reverse proxy + HTTPS)](deployment-guide.md#6-reverse-proxy--https). If you're
copying the old server's Caddy site block, check it has the `encode zstd gzip` line from
§6 — without it, large dashboard responses travel uncompressed (see
[§14](#14-lessons-from-a-real-migration)). Caddy
provisions a fresh certificate for the domain automatically once DNS actually points
here (§9) — nothing to migrate on the TLS side.

## 8. Agent binaries and the site collector

```sh
cd ~/Looksee/agent
./build-all.sh
cd ~/Looksee
bash scripts/build-collector.sh
```

Build these fresh on the new server rather than copying `agent/bin/` over — it's
gitignored build output, and building fresh guarantees the binaries match whatever
agent code is actually in this checkout.

**Don't skip the site collector** (`build-collector.sh`), even if this is the only step
of `update.sh` you're doing by hand. It bundles the collector and downloads the Node.js
runtimes agents fetch when their endpoint is a remote site's collector (about 250 MB the
first time, from nodejs.org). Without it, the new server tells every collector endpoint to
stop its collector, and those endpoints show *Site collector … — offline* while their agents
look perfectly healthy. If the old server's root `.env` set `COLLECTOR_PLATFORMS`, copy
that line over first (§4), or all five runtimes are fetched.

**Check:**

```sh
curl -s https://looksee.example.com/install/collector/manifest.json | grep -E '"(version|node)"|-amd64|-arm64'
```

You should see the `"version"` and `"node"` lines and one line per runtime your collector
machines need (e.g. `"windows-amd64": {`). The text `The site
collector hasn't been built on this engine yet` means the build didn't run or failed —
check its output. Once it's served, collector endpoints pick it up on their next agent cycle
(within about a minute) and show *online* on the Hosts page.

## 9. Cut over

With the new server fully verified (§6) and the reverse proxy live (§7):

1. **Lower your DNS record's TTL** a day or so ahead of time if you can plan the
   migration in advance — this bounds how long stragglers keep hitting the old server
   after you flip it.
2. **Update the DNS record** to point at the new server's IP.
3. **Watch it propagate**: `dig looksee.yourdomain.com` (or your local resolver's
   equivalent) from a few different networks/devices until it consistently resolves to
   the new IP.
4. **Do a final real check** against the now-live domain: load the dashboard, sign in,
   confirm an agent report comes in from an endpoint you still control, confirm a check
   still runs.

Keep the old server running and reachable for at least a day or two after cutover —
see [§12](#12-decommission-the-old-server).

## 10. Re-point already-installed agents

**If you kept the same hostname, skip this entirely** — every existing agent keeps
reporting to the same URL, which now resolves to the new server. Nothing to do.

**If the hostname changed**, each already-installed agent's config has the old URL
baked in and needs updating. On each monitored machine, edit the `engine_url` line in the
config file, then restart the service:

```bash
# Linux
sudo nano /etc/looksee-agent/looksee-agent.yaml
sudo systemctl restart looksee-agent
```

```bash
# macOS
sudo nano /usr/local/etc/looksee-agent/looksee-agent.yaml
sudo launchctl unload /Library/LaunchDaemons/com.looksee.agent.plist
sudo launchctl load -w /Library/LaunchDaemons/com.looksee.agent.plist
```

```powershell
# Windows — edit the config file the Scheduled Task references, then restart it
notepad "C:\ProgramData\LookseeAgent\looksee-agent.yaml"
Restart-ScheduledTask -TaskName "LookseeAgent"
```

Confirm each host's "last report" time updates on the Hosts page afterward. For a large
number of hosts, re-running that host's install command (Hosts page → the host → copy
command) is equivalent and simpler than hand-editing the YAML — it overwrites the
config and restarts the service in one step.

## 11. Borg backup repository

**If your repository is remote** (SSH to a third host, not the Looksee server itself),
nothing about the repository itself needs to move — but the new server has a new SSH
identity, so authorize its key on the remote host:

1. Open `/backups` on the new server (once it's live) and click "Show SSH public key."
2. Add that key to the remote host's `~/.ssh/authorized_keys` (replacing or alongside
   the old server's key, depending on whether you're decommissioning it immediately).
3. Click "Back up now" to confirm the new server can actually reach the repository.

**If your repository is local to the old server**, copy the whole repository directory
over to the new server (`rsync -a` preserves everything Borg needs) and point the new
server's backup settings at that local path. The repository's own encryption means the
copy is safe to do over an untrusted network if needed, but `rsync`-over-SSH is simplest
either way:

```bash
rsync -avz you@old-server:/path/to/borg-repo/ /path/to/borg-repo/
```

Either way, the passphrase is the same one you saved outside the app in §2 — the
database restore already brought back the repository *reference* (path/settings), but
the passphrase itself has to be re-entered once on `/backups` since it's write-only and
wasn't stored in a form the restore could recover.

## 12. Decommission the old server

Don't rush this — keep the old server running, reachable, and untouched (don't `pm2
delete` anything on it) for at least a day or two after cutover, in case DNS
propagation stragglers or an overlooked agent are still hitting it, and so you have a
live fallback if something on the new server surfaces a problem you didn't catch in
verification.

Once you're confident:

- Take one final backup from the old server anyway (`./scripts/backup.sh`) and keep it
  somewhere safe, even though the new server now has its own backup story — it costs
  nothing and is your last real safety net from this specific box.
- Stop the old server's processes: `pm2 delete looksee-engine looksee-dashboard`.
- Decommission/repurpose/shut down the old machine on your own timeline.

**If the old machine also runs other things,** remove only Looksee's pieces, one at a
time, and look before each step. First write down exactly what is Looksee's:

```bash
pm2 list                                   # looksee-engine, looksee-dashboard
cd ~/Looksee && docker compose ps          # the Looksee Postgres container
docker volume ls | grep -i looksee         # its data volume
systemctl list-unit-files | grep -i looksee   # a looksee-agent unit, if an agent ran here
```

Then, in this order:

1. `pm2 delete looksee-engine looksee-dashboard && pm2 save`.
2. `cd ~/Looksee && docker compose down` — stops and removes the containers **but keeps
   the data volume**.
3. Only once the final backup above is safely somewhere else:
   `docker volume rm <the looksee volume from the list above>`. **This permanently
   deletes that copy of the database.** Never use `docker compose down -v`,
   `docker volume prune` or `docker system prune --volumes` on a shared machine — they
   remove other projects' data too.
4. If an agent ran on the old machine and it's not being monitored any more:
   `sudo systemctl disable --now looksee-agent` and remove its unit file and
   `/etc/looksee-agent`.
5. `cd ~` **before** deleting the folder — deleting the directory your shell is in
   makes later commands fail with confusing errors (Node reports `uv_cwd`, and an SSH
   session can drop) that look like a broken server but aren't. Then
   `rm -rf ~/Looksee ~/looksee-migration`.

**Check:** the four inventory commands above show nothing of Looksee's, and the other
services on that machine are still running (`pm2 list`, `docker ps`).

## 13. If something goes wrong

**Nothing here has touched the old server's data or DNS until §9.** If verification in
§6 turns up a problem, you can debug the new server indefinitely with zero user impact
and zero time pressure — the old server is still live and serving real traffic the
whole time. This is the actual point of not cutting over until it's verified.

**If a problem surfaces after cutover**, DNS is the fastest rollback: point the record
back at the old server's IP. It's still running, untouched, with all the data it had
before the migration (nothing in this guide modifies the old server). Anything written
to the new server's database between cutover and rollback is lost when you roll back —
same trade-off as any other rollback in this project (see deployment-guide.md's
"Rolling back" section for the general principle).

**Health check and log locations** on the new server are the same as any deployment —
see deployment-guide.md [§10 (troubleshooting)](deployment-guide.md#10-troubleshooting).

**The dashboard is slow but `/api/health` is fine.** In the browser, open DevTools →
Network, reload, and click the slowest request (usually `checks`):

- Long *Content Download* and no `content-encoding` response header → responses aren't
  compressed; add `encode zstd gzip` to the Caddy site block (§7).
- Long *Waiting for server response* → the engine or database is slow; check
  `pm2 logs looksee-engine` for errors and see *Postgres memory* in §14.

## 14. Lessons from a real migration

From moving a production deployment with a 4 GB database (about 5.5 million events,
4.8 million flow records, 4.5 million check results and 800,000 log lines) to a new
virtual machine with about 8 GB of RAM. Your numbers will differ; the lessons don't.

1. **A healthy API isn't a finished migration.** Compare database size and row counts
   (§5), then use the real dashboard through the real reverse proxy (§6, §9).
2. **Measure before tuning.** DevTools showed the `checks` response was about 340 KB and
   took almost three seconds to *download* — the server had answered in under one. The
   fix was compression at the proxy, not a faster database.
3. **Enable compression** (`encode zstd gzip` in Caddy) — large JSON responses shrink to
   a fraction of their size.
4. **Postgres memory.** The Postgres container starts with conservative defaults
   (`shared_buffers = 128MB`). On that 8 GB machine, two settings were raised and
   nothing else: `shared_buffers = 1GB` (memory Postgres reserves for its own cache) and
   `effective_cache_size = 5GB` (only a planner estimate of the cache available — it
   reserves nothing). `work_mem` stayed at 4 MB: it applies per sort or hash *in every
   query*, so raising it multiplies memory use under load. To change them in the
   Compose setup, add a `command:` to the `postgres` service in a
   `docker-compose.override.yml` (not tracked by git, so updates don't conflict):

   ```yaml
   # docker-compose.override.yml — this server only
   services:
     postgres:
       command: ["postgres", "-c", "shared_buffers=1GB", "-c", "effective_cache_size=5GB"]
   ```

   then `docker compose up -d postgres`. **Check** what Postgres actually loaded — an
   edited file proves nothing:

   ```bash
   docker compose exec -T postgres psql -U looksee -d looksee -c "SELECT name, setting, unit, pending_restart FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','maintenance_work_mem');"
   ```

   `shared_buffers` reads `131072` with unit `8kB` (= 1 GB), `effective_cache_size`
   `655360` (= 5 GB), and `pending_restart` is `f`. Leave room for the engine, the
   dashboard, the operating system's own file cache and anything else on the machine;
   scale the values to its RAM rather than copying these.
5. **Keep the old server untouched until the new one is proven,** and clean it up
   narrowly afterwards (§12).
6. **Leave a directory before deleting it** (§12, step 5).
