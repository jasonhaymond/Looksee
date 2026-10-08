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
8. [Agent binaries](#8-agent-binaries)
9. [Cut over](#9-cut-over)
10. [Re-point already-installed agents](#10-re-point-already-installed-agents)
11. [Borg backup repository](#11-borg-backup-repository)
12. [Decommission the old server](#12-decommission-the-old-server)
13. [If something goes wrong](#13-if-something-goes-wrong)

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
| Database (endpoints, hosts, checks, history, users, channels, settings, alert rules, dashboards) | `pg_dump` / `pg_restore` — scripted, see §2 and §5 |
| `engine/.env` and `dashboard/.env` (secrets — `SESSION_SECRET`, VAPID keypair, SMTP fallback, `.env`-based settings) | Copied directly, see §4 |
| Borg backup repository (if local to the old server) | Copied or re-pointed, see §11 |
| Agent binaries (`agent/bin/`) | **Not migrated** — gitignored build output, just rebuilt fresh on the new server (§8) |
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
npm install
# don't run db:migrate or db:create-admin yet — db:migrate needs a real DATABASE_URL
# in engine/.env first (§4), and the database isn't there to migrate until it's
# restored (§5); db:create-admin is skipped entirely, since the restored database
# already has your real admin account

cd ../dashboard
npm install
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
endpoint, host, check, check-result history, user account, channel, alert rule, and
dashboard — into the new server's fresh Postgres container.

```bash
cd engine
npm run db:migrate
```

Run this even if the dump is current — it's a no-op if every migration in the dump was
already applied, and exactly what you want if the old server's backup predates a
migration that's landed since (the restore note printed by `restore.sh` says the same
thing).

**What success looks like**: no errors from either command, and

```bash
docker compose exec -T postgres psql -U looksee -d looksee -tAc "SELECT count(*) FROM endpoints; SELECT count(*) FROM hosts; SELECT count(*) FROM checks; SELECT count(*) FROM users;"
```

returns the same row counts you'd expect from the old server, not zeros.

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
endpoints/hosts/checks/dashboards are all there — then remove the `/etc/hosts` entry
before moving on to §7, so you're not left testing against a stale override.

## 7. Reverse proxy, HTTPS, and firewall

Same as a first deployment — see deployment-guide.md
[§5 (firewall)](deployment-guide.md#5-firewall) and
[§6 (reverse proxy + HTTPS)](deployment-guide.md#6-reverse-proxy--https). Caddy
provisions a fresh certificate for the domain automatically once DNS actually points
here (§9) — nothing to migrate on the TLS side.

## 8. Agent binaries

```sh
cd ~/Looksee/agent
./build-all.sh
```

Build these fresh on the new server rather than copying `agent/bin/` over — it's
gitignored build output, and building fresh guarantees the binaries match whatever
agent code is actually in this checkout.

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
   confirm an agent report comes in from a host you still control, confirm a check
   still runs.

Keep the old server running and reachable for at least a day or two after cutover —
see [§12](#12-decommission-the-old-server).

## 10. Re-point already-installed agents

**If you kept the same hostname, skip this entirely** — every existing agent keeps
reporting to the same URL, which now resolves to the new server. Nothing to do.

**If the hostname changed**, each already-installed agent's config has the old URL
baked in and needs updating. On each monitored host, edit the `engine_url` line in the
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
