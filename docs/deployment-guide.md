# Deployment Guide

A walkthrough for putting Looksee on a real server in your homelab — not just running it on
a dev machine. If you only need local development, see the [README](../README.md) instead;
this is for a first real deployment and for updating one you already have running. Moving
an existing deployment to a *different* server is a separate walkthrough — see
[migration-guide.md](migration-guide.md).

This is a **single-environment deployment** — no staging environment, by design (see
`CLAUDE.md`: solo personal tool, low blast-radius). Everything here assumes Ubuntu/Debian;
adjust package manager commands for another distro.

## Contents

1. [What you'll need](#1-what-youll-need)
2. [Install prerequisites](#2-install-prerequisites)
3. [Get the code and configure](#3-get-the-code-and-configure)
4. [Build and run under pm2](#4-build-and-run-under-pm2)
5. [Firewall](#5-firewall)
6. [Reverse proxy + HTTPS](#6-reverse-proxy--https)
7. [Backups](#7-backups)
8. [Updating](#8-updating) — including [Upgrading to 5.3](#upgrading-to-53), [Upgrading to 5.2](#upgrading-to-52), [Upgrading to 5.0](#upgrading-to-50), [Upgrading to 4.3](#upgrading-to-43), [Upgrading to 4.2](#upgrading-to-42), [Upgrading to 4.1](#upgrading-to-41), [Upgrading to 4.0](#upgrading-to-40), [Upgrading to 3.2](#upgrading-to-32) and [Upgrading to 3.0](#upgrading-to-30)
9. [Distributing and installing agent binaries](#9-distributing-and-installing-agent-binaries)
10. [Troubleshooting](#10-troubleshooting)
11. [Security notes](#11-security-notes)

Related: [user guide](user-guide.md) · [security guide](security-guide.md) · [Windows agent & security software](windows-agent-security.md) · [agent README](../agent/README.md) · [README](../README.md) · [CHANGELOG](../CHANGELOG.md)

## 1. What you'll need

- A Linux server on your homelab network (one of your pfSense-managed VLANs) that can
  reach both your monitored LAN targets and the public internet (for WAN checks and
  fetching updates). Root/sudo access.
- A domain or subdomain if you want HTTPS via Caddy (recommended) — e.g.
  `looksee.haymondtechnologies.com`. You can run on the bare LAN IP without one, but
  session cookies only get `secure: true` over HTTPS, and Web Push requires HTTPS in
  production (browsers refuse it over plain HTTP for any origin but localhost).
- About 20-30 minutes.

## 2. Install prerequisites

```bash
sudo apt update
# Node.js 24 LTS (supported until April 2028; Node 20 reached end of life in April 2026)
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs git

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

sudo npm install -g pm2

# Only needed if you plan to build agent binaries on this server rather than
# via the Docker-based build in agent/README.md
# (Go 1.26 or newer)
# curl -fsSL https://go.dev/dl/go1.27.0.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
# echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
```

**Optional tools** — each enables one engine-side check type and nothing else breaks
without them (the check just reports "X isn't installed on the engine host"):

```bash
# Traceroute / path-change checks
sudo apt install -y traceroute
# Real-browser checks (headless Chrome). The engine finds /usr/bin/chromium
# automatically; set CHROME_PATH in engine/.env for anything else.
sudo apt install -y chromium
# Server hardware checks over IPMI (Redfish needs nothing extra)
sudo apt install -y ipmitool
```

Check with `traceroute --version`, `chromium --version`, `ipmitool -V`.

## 3. Get the code and configure

```bash
git clone <your-repo-url> ~/Looksee
cd ~/Looksee

cp .env.example .env   # only if 5432 is already taken on this box — see .env.example
docker compose up -d

cd engine
cp .env.example .env
# Edit .env: DATABASE_URL (match the port above), a real SESSION_SECRET
# (node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"),
# CORS_ALLOWED_ORIGINS, PUBLIC_URL (same value as NEXT_PUBLIC_API_URL below —
# used to build the agent install command shown on the Endpoints page), SMTP_*
# if you want email alerts, VAPID_* for Web Push (see .env.example for the
# generate command — never regenerate once real subscriptions exist), and
# TRUST_PROXY = your reverse proxy's IP (127.0.0.1 if Caddy runs on this
# server; e.g. 10.1.30.10 if it's another machine) — see section 6.
npm ci
npm run db:migrate
npm run db:create-admin   # interactive — run in a real terminal, not piped
# Two-factor sign-in is required: the first sign-in in the browser shows a QR
# code to scan with an authenticator app and ten recovery codes to save.

cd ../dashboard
cp .env.example .env
# Edit .env: NEXT_PUBLIC_API_URL — see the reverse-proxy section below for
# why the recommended value is the same public URL as the dashboard itself.
npm ci
```

**Recommended `CORS_ALLOWED_ORIGINS` / `NEXT_PUBLIC_API_URL` setup:** if you put the engine
behind the same public domain as the dashboard using the path-based Caddy routing in
section 6 (`/api/*` → engine, everything else → dashboard), both requests are same-origin
from the browser's perspective. Set `NEXT_PUBLIC_API_URL` to that one public URL (e.g.
`https://looksee.haymondtechnologies.com`) and `CORS_ALLOWED_ORIGINS` to the same value —
simpler and avoids cross-origin cookie edge cases entirely. This is different from local
dev, where the engine (port 4100) and dashboard (port 3100) are genuinely different
origins and need real CORS.

## 4. Build and run under pm2

```bash
cd ~/Looksee/engine && npm run build
cd ~/Looksee/dashboard && npm run build
cd ~/Looksee
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup   # follow the one printed command (needs sudo)
```

Useful commands: `pm2 status`, `pm2 logs looksee-engine`, `pm2 logs looksee-dashboard`,
`pm2 restart looksee-engine looksee-dashboard`. `scripts/update.sh` uses `pm2
startOrReload ecosystem.config.cjs`, which also (re)registers the apps if pm2 has
forgotten them. Always run pm2 commands and `update.sh` **as the same user** — pm2 keeps
a separate process list per user, so `sudo pm2 …` or `sudo ./update.sh` won't see the
apps your normal user started.

**If you use systemd instead of pm2**, create `/etc/systemd/system/looksee-engine.service`
and `looksee-dashboard.service` with `WorkingDirectory`/`ExecStart` pointing at
`node dist/index.js` (engine) and `node_modules/.bin/next start -p 3100` (dashboard)
respectively, `Restart=on-failure`, then `sudo systemctl enable --now` both. Replace the
`pm2 startOrReload …` and `pm2 save` lines in `scripts/update.sh` with `sudo systemctl
restart looksee-engine looksee-dashboard` if you go this route.

## 5. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Don't open 5432 (Postgres, already bound to `127.0.0.1` by `docker-compose.yml`), 4100
(engine), or 3100 (dashboard) — only Caddy needs to be internet/LAN-reachable.

**Caddy on a different machine?** (e.g. a separate reverse-proxy host) Then allow 4100
and 3100 from *that machine only* — Looksee trusts `X-Forwarded-For` from its proxy
(`TRUST_PROXY`), so nothing else on the LAN should be able to reach those ports directly.
Replace `10.1.30.10` with the proxy's IP:

```bash
sudo ufw allow from 10.1.30.10 to any port 4100 proto tcp
sudo ufw allow from 10.1.30.10 to any port 3100 proto tcp
```

**Event and flow receivers (optional).** The engine also listens for SNMP traps, syslog
and NetFlow/IPFIX/sFlow on unprivileged ports (`SNMP_TRAP_PORT`, `SYSLOG_PORT`,
`FLOW_PORT`, `SFLOW_PORT` in `engine/.env`; set one to `off` to disable it). They accept
data without authentication, so the engine itself ignores anything not from a private
address (`RECEIVER_ALLOWED_SOURCES`). Open them to your LAN only — never to the
internet. Replace `10.0.0.0/8` with your LAN range:

```bash
sudo ufw allow from 10.0.0.0/8 to any port 1162 proto udp   # SNMP traps
sudo ufw allow from 10.0.0.0/8 to any port 1514             # syslog (UDP + TCP)
sudo ufw allow from 10.0.0.0/8 to any port 2055 proto udp   # NetFlow v5/v9, IPFIX
sudo ufw allow from 10.0.0.0/8 to any port 6343 proto udp   # sFlow
sudo ufw status numbered
```

**Direct push from remote sites (optional).** If a remote site's devices send straight
to this server instead of to a site collector (user guide → *Multiple sites*), forward
those ports from your router to this server and allow them **only from that site's
public IP** (also enter the IP on the endpoint, or the engine drops the traffic):

```bash
SITE_IP=203.0.113.10   # the remote site's public IP
sudo ufw allow from $SITE_IP to any port 1514               # syslog (UDP + TCP)
sudo ufw allow from $SITE_IP to any port 1162 proto udp     # SNMP traps
sudo ufw allow from $SITE_IP to any port 2055 proto udp     # NetFlow v5/v9, IPFIX
sudo ufw allow from $SITE_IP to any port 6343 proto udp     # sFlow
```

A site collector needs none of this — it only makes outbound HTTPS requests to the
dashboard's public URL.

Most devices let you choose the destination port. If one insists on the standard 162 or
514, redirect it on this server instead of running the engine as root — add to
`/etc/ufw/before.rules` above the `*filter` line, then `sudo ufw reload`:

```
*nat
:PREROUTING ACCEPT [0:0]
-A PREROUTING -p udp --dport 514 -j REDIRECT --to-ports 1514
-A PREROUTING -p udp --dport 162 -j REDIRECT --to-ports 1162
COMMIT
```

**DHCP server checks (optional).** Probing a DHCP server means listening on UDP port 68,
which needs a privilege the engine doesn't have as a normal user. If you want DHCP
checks, grant just that one capability to the Node binary:

```bash
sudo setcap 'cap_net_bind_service=+ep' "$(readlink -f "$(which node)")"
getcap "$(readlink -f "$(which node)")"   # should print cap_net_bind_service=ep
```

This lets *any* Node program on the server bind low ports — acceptable on a dedicated
monitoring box, worth knowing on a shared one. A Node upgrade replaces the binary, so
re-run it afterwards. Without it, DHCP checks report a clear "needs cap_net_bind_service"
error and everything else is unaffected.

## 6. Reverse proxy + HTTPS

**Single domain, path-routed** — this is the setup section 3 above assumes, and it's
simpler than running engine and dashboard on separate subdomains because it makes them
same-origin (no CORS, simpler cookies):

```caddy
looksee.haymondtechnologies.com {
  # Browsers only ever use HTTPS for this site from now on (1 year), and
  # responses don't advertise the server software.
  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    -Server
  }
  # Compress responses for browsers that accept it. The check list and other
  # JSON responses get large (hundreds of KB with thousands of checks);
  # compressed, they arrive several times faster on a slow link.
  encode zstd gzip
  @api path /api/* /install/*
  handle @api {
    reverse_proxy localhost:4100
  }
  handle {
    reverse_proxy localhost:3100
  }
}
```

**Check** after reloading Caddy:

```bash
curl -sI https://looksee.haymondtechnologies.com/api/health | grep -i -E "strict-transport|^server"
```

You should see `strict-transport-security: max-age=31536000; includeSubDomains` and no
`server:` line. Only add HSTS once HTTPS works — browsers remember it for a year.
To confirm compression, sign in in a browser, open DevTools → Network, reload, and click
the `checks` request: its response headers include `content-encoding: zstd` (or `gzip`),
and *transferred* is much smaller than *size*. An existing Caddyfile without the
`encode` line can add it at any time (validate and reload as below).

**`/install/*` must be routed to the engine too**, not just `/api/*` — it's where the
one-line agent install command (section 9) and the binaries it downloads are served from.
It's deliberately outside `/api` since it's plain curl-consumed scripts, not the JSON API,
but that means a Caddyfile matching only `/api/*` sends it to the dashboard instead, which
404s. If you're updating an existing single-API-path Caddyfile from before agent install
automation existed, add `/install/*` to the `@api` matcher and reload.

```bash
sudo caddy validate --config /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

If you'd rather keep the engine on its own subdomain instead (e.g. if you want to reach
the API directly for scripting), use two site blocks and set `CORS_ALLOWED_ORIGINS` to
the dashboard's origin explicitly — real cross-origin CORS, same as local dev.

## 7. Backups

**Recommended: the built-in Backups admin page** (`/backups` in the dashboard — every
signed-in user, since Looksee has no role system; see `CLAUDE.md`). Backs up the database
*and* both `.env` files together into an encrypted, deduplicated
[BorgBackup](https://borgbackup.readthedocs.io/) repository — local or over SSH to
another host — on whatever cron schedule you set, with a guarded (typed-confirmation)
restore flow right in the UI. Requires `borg` installed on this server (not automated by
setup — it's a system package):

```bash
sudo apt install -y borgbackup postgresql-client
```

Open `/backups`, set a repository (a local path, or `user@host:path` for an SSH repo —
click "Show SSH public key" to get the key to authorize on the remote host's
`~/.ssh/authorized_keys`) and a passphrase, optionally a cron schedule and a retention
count, then **Save settings** and **Back up now**.

**Store the passphrase somewhere safe outside this app** — it's write-only through the UI
(never shown again once saved, per the security baseline) and losing it means losing
access to every archive with no recovery.

**Verification status, honestly:** the `borg init`/`create`/`list --json`/`extract`/
`prune`/`info` command shapes this feature uses were verified against a real installed
`borg 1.2.4` binary in an isolated container during development (including the exact
`list --json` field names the code parses). The engine's own settings/status/archive-list/
error-handling routes were exercised live too. What hasn't been exercised end-to-end yet
is this feature's full pipeline (pg_dump → borg create → borg extract → pg_restore)
against this app's own real database on an actual Linux deployment, since the dev machine
this was built on has no `borg` binary. **Do one real backup and one real restore here
before trusting it with data you'd be upset to lose.**

**Manual fallback**, if you'd rather not use Borg, or want a second independent mechanism:

- `scripts/backup.sh` — plain `pg_dump --clean --if-exists` (self-contained, restorable
  onto a non-empty database) plus both `.env` files into one dated directory, pruned past
  `LOOKSEE_BACKUP_RETENTION_DAYS` (default 14). Cron: `0 3 * * *
  /home/you/Looksee/scripts/backup.sh`.
- `scripts/restore.sh /path/to/looksee.sql.gz` — restores a dump, typed confirmation
  required. **This one has actually been tested end-to-end**: a dump taken mid-session,
  more data added afterward, then restored — the post-dump data was gone and everything
  else intact. (This is also what caught the `--clean --if-exists` bug noted in
  CHANGELOG.md — a lesson applied to the Borg path's `pg_restore --clean --if-exists`
  call too.)

Either way, copy backups off this host regularly — a backup on the same disk doesn't
protect against this server failing.

## 8. Updating

```bash
~/Looksee/scripts/update.sh
```

This deploys the newest release (the highest `vX.Y.Z` tag on GitHub), but only if
that release's tag records the developer's security-review approval (see [What
`update.sh` does](#what-updatesh-does)). **What success looks like:** the last lines
read `Engine is healthy on vX.Y.Z.` and `Update complete — vX.Y.Z is live.`

**Post-deploy security checks (recommended).** Add the public address to the root
`.env` once, and every update finishes by checking the live site from the outside —
HTTPS and certificate, security headers, admin routes refusing anonymous requests, CORS,
and sign-in rate limiting:

```bash
echo 'LOOKSEE_PUBLIC_URL=https://looksee.haymondtechnologies.com' >> ~/Looksee/.env
```

You can run the same checks by hand at any time:

```bash
~/Looksee/scripts/security-check.sh --live https://looksee.haymondtechnologies.com
```

**Check:** every line reads `PASS` and the last line is `RESULT: PASS`; the full report
is saved under `~/Looksee/security-reports/`.

### Upgrading to 5.3

5.3 has no database migration and no agent changes (agents report 5.3.0 only so the
version stays in lockstep; updating them is optional).

1. **Run the update as usual:** `~/Looksee/scripts/update.sh`. **Check:** `Update
   complete — engine is healthy on v5.3.0.`, then `RESULT: PASS` from the post-deploy
   checks.
2. **Know the one behaviour change:** a check that times out now shows **WARN** and
   only goes **DOWN** at the 3rd timeout in a row. For a device where a single missed
   answer must alert as down, open the check and set **Advanced → Timeouts in a row
   before down** to `1`. **Check:** on the Checks page, a timing-out check's message
   starts with `Timeout 1 of 3 before down —`.

**Rolling back to 5.2.0** is code-only (`scripts/update.sh v5.2.0`); there is nothing to
restore in the database.

### Upgrading to 5.2

5.2 adds three check types and site address ranges. Its one database migration
(`0027`) is additive: three new check-type values and a `networks` column on `sites`
that defaults to an empty list. Nothing existing changes.

1. **Run the update as usual:** `~/Looksee/scripts/update.sh`. **Check:** `Update
   complete — engine is healthy on v5.2.0.`, then `RESULT: PASS` from the post-deploy
   checks. 5.2's check script no longer probes the `/api/hosts` route removed in 5.0,
   which made 5.1's post-deploy run report `not 401: /api/hosts→404`.
2. **Update agents** to 5.2.0 (**Endpoints → select → Actions → Update agents**) for the
   *Local user accounts* and *Largest folders and files* checks; older agents show
   "Needs agent 5.2.0+" on those checks and keep everything else.
3. **If one collector serves several sites,** give each site its address ranges
   (**Sites & locations → Edit → Address ranges**) so received syslog/traps/flows are
   filed under the right site — see the user guide's
   [One collector for several networks](user-guide.md#one-collector-for-several-networks).
   Without ranges, events still go to the collector's first site, as in 5.1.

**Rolling back to 5.1.0** is code-only safe: 5.1 ignores the new column, and checks of
the three new types simply don't run (delete them first if you won't upgrade again).

### Upgrading to 5.0

5.0 renames Looksee's building blocks to **Location → Site → Endpoint → Check**: what
4.x called an *endpoint* (a network) is now a **site**, and a *host* (a machine) is now an
**endpoint**. The rename goes all the way into the database (tables, columns, saved
dashboards, maintenance scopes, alert templates), so **this upgrade can't be undone by
deploying 4.x code alone** — read *Rolling back from 5.0* below before you start.

**Before you start:**

1. **Make sure a recent backup exists off the server.** `update.sh` takes its own
   snapshot first (step 2 below), but a copy somewhere else protects against losing the
   server itself. On **System → Backups**, click **Back up now**. **Check:** the newest
   entry in the list says *v4.3.x* and today's date.
2. **If the server's outbound internet is restricted,** allow HTTPS (443) to `api.osv.dev`
   and `endoflife.date`. Only the new *Vulnerable or unsupported software* check uses them,
   and only if you add it (both lookups can be turned off per check).

**Upgrade:**

1. Run the update as usual:

   ```bash
   ~/Looksee/scripts/update.sh
   ```

2. What happens: the script snapshots the database (as
   `~/looksee-backups/pre-update-v4.3.x-<timestamp>.sql.gz`), checks out v5.0.0, installs
   dependencies, applies migrations 0019–0025 (the rename, groups, exclusions, watchdog
   agents, installed software and SNMP templates), rebuilds the dashboard, the site
   collector bundle and the agent binaries, restarts, and waits for the health check. On
   a large database the rename takes seconds, not minutes — a test copy with 1,000
   endpoints, 10,000 checks and 3 million results migrated in about 6 seconds.

   **What success looks like:** `Update complete — v5.0.0 is live.`

3. **Check the data came across.** Sign in and compare with what you had:
   - The sidebar tree shows your locations, their **sites** (your old endpoints) and
     each site's **endpoints** (your old hosts).
   - **Monitoring → Checks** shows the same number of checks as before.
   - **Monitoring → Endpoints** shows your agent machines online.

   Or, on the server:

   ```bash
   psql "$(grep ^DATABASE_URL ~/Looksee/engine/.env | cut -d= -f2-)" -c "select (select count(*) from sites) sites, (select count(*) from endpoints) endpoints, (select count(*) from checks) checks; select version from app_meta;"
   ```

   **Check:** the counts match your old endpoint/host/check counts, and `version` is
   `5.0.0`.

**Agents.** 4.x agents keep working unchanged — the agent protocol didn't change. Update
them (Endpoints → tick them → **Actions → Update agents**) to get the 5.0 features:
installed-software reporting (for the new software and vulnerability checks), watchdog
agents, and the *Should be: Stopped* service check. Each agent updates itself on its next
check-in.

**Linux agents' default access.** New Linux installs now give the agent read access to
system logs, the journal, Docker (if installed) and SMART by default — see
[agent/README.md → Privileges](../agent/README.md#privileges). An agent that updates
itself keeps its old, narrower access. To give an existing agent the new defaults, run
on that machine:

```bash
sudo usermod -aG adm,systemd-journal looksee-agent
getent group docker >/dev/null && sudo usermod -aG docker looksee-agent   # skip on purpose if you don't want it — see the agent README
sudo mkdir -p /etc/systemd/system/looksee-agent.service.d
curl -fsSL https://<your-looksee>/install/looksee-agent-privileged.conf | sudo tee /etc/systemd/system/looksee-agent.service.d/privileged.conf >/dev/null
sudo systemctl daemon-reload && sudo systemctl restart looksee-agent
```

**Check:** `id looksee-agent` lists `adm` and `systemd-journal`, and the endpoint's
SMART and log checks stop saying "permission denied".

**Things that look different:**

- **Bookmarks.** `/hosts` now redirects to `/endpoints`. The old `/endpoints` page
  (networks) is now `/sites`, so a bookmark to the old `/endpoints` opens the new
  devices list instead.
- **Alert templates.** Your saved templates were updated: `{{endpoint}}` became
  `{{site}}` and `{{host}}` became `{{endpoint}}`, so messages say the same things as
  before. `{{host}}` keeps working as another name for `{{endpoint}}`.
- **Regular expressions** typed into checks (HTTP body match, banner, expected output,
  interface filters, Prometheus labels) now run on the RE2 engine, which can't freeze
  the server on a pathological pattern. RE2 has no look-ahead (`(?=…)`, `(?!…)`),
  look-behind or back-references (`\1`). A check whose pattern uses them reports the
  pattern as invalid — rewrite it (usually as two simpler checks, or with
  *does not contain*). To find them before upgrading:

  ```bash
  psql "$(grep ^DATABASE_URL ~/Looksee/engine/.env | cut -d= -f2-)" -c "select name from checks where config::text ~ '\(\?[=!<]|\\\\[1-9]';"
  ```

  **Check:** the query returns no rows, or you've noted which checks to fix.

**Rolling back from 5.0.** Deploying 4.x code onto the renamed database fails — the
tables it expects no longer exist. A rollback is therefore always **code + database**:

1. Find the snapshot the upgrade took: `ls -t ~/looksee-backups/pre-update-v4.3*` — the
   newest one is from just before 5.0 was deployed.
2. Restore it, then deploy the old version:

   ```bash
   ~/Looksee/scripts/restore.sh ~/looksee-backups/pre-update-v4.3.1-<timestamp>.sql.gz
   ~/Looksee/scripts/update.sh v4.3.1
   ```

**Restoring discards everything recorded since the upgrade** — results, incidents, and
any sites, endpoints, checks, groups or settings created in 5.0. `restore.sh` asks you to
type `RESTORE` first, then empties the database completely and loads the snapshot, so no
5.0 tables are left behind. **What success looks like:** `Restore complete — this data
was last used by Looksee v4.3.1.`, then the update's `Update complete — v4.3.1 is
live.` Agents updated to 5.0 keep working with 4.3 (they send extra data 4.3 ignores).

The in-app restore on **System → Backups** only restores a database backup made by the
same version (5.0.x into 5.0.x); for a backup from another version it explains that and
points here, because only `restore.sh` + `update.sh` change the code and the database
together.

### Upgrading to 4.3

4.3 changes only the release tooling, but that includes `update.sh` itself:

1. **Run the update as usual:** `~/Looksee/scripts/update.sh`. This first run still uses
   the 4.2 script already on the server, which pulls the latest code; every later run
   uses the new one, which deploys approved release tags only (see
   [What `update.sh` does](#what-updatesh-does)). **Check:** `Update complete — engine
   is healthy on v4.3.0.`
2. **Turn on the post-deploy checks (recommended):**

   ```bash
   echo 'LOOKSEE_PUBLIC_URL=https://looksee.haymondtechnologies.com' >> ~/Looksee/.env
   ~/Looksee/scripts/security-check.sh --live https://looksee.haymondtechnologies.com
   ```

   **Check:** the last line reads `RESULT: PASS`.
3. From the next update on, `git status` on the server shows `HEAD detached at vX.Y.Z`
   instead of `On branch master` — expected, since updates now check out release tags.

The agent version moves to 4.3.0 with no code changes (lockstep), so the update rebuilds
the agent binaries and hosts show an optional update. Rolling back to 4.2.0 is safe (no
database changes in 4.3).

### Upgrading to 4.2

4.2 shows every time in the dashboard in your local time zone, and adds the
[VPN-only access guide](vpn-access.md) (documentation only — nothing is locked down).
The upgrade is the normal `update.sh` run. Its one migration adds a nullable
`time_zone` column to `maintenance_windows`; nothing to configure.

- **Existing weekly maintenance windows** keep running on the server's clock and show
  *(server's time)* on the Maintenance page. To move one to your own time zone, delete
  it and schedule it again. **Check:** the new window's line shows no zone note (it's
  in your zone).
- The agent version moves to 4.2.0 with no code changes, so `update.sh` rebuilds the
  agent binaries and hosts show an update available; updating them is optional.

Rolling back to 4.1 is code-only safe (4.1 ignores the new column).

### Upgrading to 4.1

4.1 adds passkeys/security keys as a second factor, the outbound watchdog, and moves the
engine to Express 5. The upgrade is the normal `update.sh` run; its two migrations only
add a table, a column and a settings table. Nothing to configure, then optionally:

1. **Turn on the watchdog** — System → Watchdog, following the Healthchecks.io steps on
   that page ([user guide → Watchdog](user-guide.md#watchdog)). **Check:** *Send a ping
   now* turns the check green at the outside service.
2. **Add a passkey** — System → Security → *Passkeys & security keys* →
   **+ Add a passkey** (a YubiKey works). Sign out and back in with **Use a passkey or
   security key** to confirm it.

Rolling back to 4.0 is code-only safe (the new tables are simply unused).

### Upgrading to 4.0

4.0 adds a security layer, locations, Slack/Teams/Telegram channels and templates, host
inventory, IP-change tracking and more (see the CHANGELOG). The upgrade is the normal
`update.sh` run; its two migrations only add tables and columns. Then:

1. **Set `TRUST_PROXY`** in `engine/.env` to your reverse proxy's IP (`127.0.0.1` when
   Caddy runs on this server), and restart the engine:

   ```bash
   echo 'TRUST_PROXY=10.1.30.10' >> ~/Looksee/engine/.env   # your Caddy host's IP
   pm2 restart looksee-engine
   ```

   If Caddy is on another machine, apply the firewall rule in [section 5](#5-firewall).
2. **Move the server off Node.js 20** if it's still on it (`node -v`) — Node 20 stopped
   receiving security fixes on 2026-04-30. This needs root, so it's a manual step:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   node -v                       # v24.x
   cd ~/Looksee && scripts/update.sh   # reinstalls dependencies for the new Node and restarts
   ```

   **Check:** `curl -s localhost:4100/api/health` shows `"status":"ok"` and the new
   version. pm2 keeps using the Node it was started with until the processes are
   recreated; if `pm2 describe looksee-engine | grep "node.js version"` still says 20,
   run `pm2 delete looksee-engine looksee-dashboard && pm2 start ecosystem.config.cjs && pm2 save`.
3. **Sign in and set up two-factor.** It's now required: the first sign-in shows a QR
   code for an authenticator app, then ten recovery codes — save them in your password
   manager. **Check:** System → Security → *Your account & 2FA* shows "Two-factor: on".
   Then on the same page check that *Your current IP as Looksee sees it* is your real
   public IP when you're off your LAN (if it shows the proxy's address, `TRUST_PROXY`
   isn't right yet).
4. **Point security notifications somewhere.** Recommended: email plus push to your
   phone.
   1. Email needs SMTP: Alerting → Channels → SMTP server → **Send test email**.
   2. On your phone, open the dashboard, install it as an app (Share → *Add to Home
      Screen* on iOS, *Install app* on Android), and tap **Enable push** in the top bar.
   3. Alerting → Channels → **Add a channel**: type *Browser / phone push*, name it
      "Phone push".
   4. System → Security → *Attack detection*: leave *Send security emails to* blank (your
      sign-in email), tick **Phone push**, **Save**, then **Send a test**. **Check:** the
      test arrives both by email and as a phone notification.
5. **Update agents** to 4.0.0 (**Hosts → select → Actions → Update agents**) for
   process/service inventory, the script picker and script expected output.
6. **Add HSTS and drop the Server header in Caddy** — the `header` block in
   [section 6](#6-reverse-proxy--https), then `sudo caddy validate --config
   /etc/caddy/Caddyfile && sudo systemctl reload caddy` and the check shown there.
7. Optional: the other items in the
   [security guide's checklist](security-guide.md#hardening-checklist-for-an-internet-facing-looksee);
   agent signing — [windows-agent-security.md](windows-agent-security.md#signing-the-agent).

**If you get locked out** (lost authenticator, allowlist mistake): on the server,
`cd ~/Looksee/engine && npm run security:reset` (add `-- --2fa` to also clear two-factor).

**Rolling back to 3.2** is code-only safe: 4.0's migrations are additive, so 3.2 runs
against the 4.0 schema (it ignores the new tables/columns, and signs in with the
password alone again).

### Upgrading to 3.2

3.2 adds site collectors and direct push for monitoring other locations (user guide →
*Multiple sites*). The upgrade is the normal `update.sh` run; its migration only adds
columns and a table. What's new on the server side:

1. `update.sh` now also builds the site collector and downloads the official Node.js
   runtimes agents fetch when they become a collector, verified against nodejs.org's
   published SHA-256 sums. The first run downloads about 250 MB from nodejs.org and keeps
   about 200 MB in `agent/bin/collector/`; later runs only re-download when the pinned
   Node version (`engine/src/collector/NODE_VERSION`) changes. To keep fewer platforms,
   set `COLLECTOR_PLATFORMS` in the repo's root `.env` (see `.env.example`), e.g.:

   ```bash
   echo 'COLLECTOR_PLATFORMS="linux-amd64 windows-amd64"' >> ~/Looksee/.env
   ```

   **Check:** `curl -s localhost:4100/install/collector/manifest.json` lists `"version":
   "3.2.0"` and a runtime for each platform you kept.
2. Update agents to 3.2.0 (**Hosts → select → Update agents**) — at least on hosts you
   want as site collectors.
3. Optional collector settings live in `engine/.env` (`COLLECTOR_*_PORT`,
   `COLLECTOR_ALLOWED_SOURCES`; see `engine/.env.example`), then `pm2 restart
   looksee-engine`.

### Upgrading to 3.0

3.0 is a large release (many new check types, management pages, agent features). The
upgrade itself is the normal `update.sh` run above — its database migration only *adds*
tables, columns and check types, and back-fills each check's latest status, so existing
checks, history and dashboards carry over unchanged. Afterwards:

1. `update.sh` (3.1+) builds the agent binaries for you; `curl -s localhost:4100/api/health`
   shows the version they're built as in `"agentVersion"`.
2. On the Hosts page, select all hosts and use **Update agents**. Pre-3.0 agents keep
   reporting CPU/memory/disk and running service/process checks; checks that need 3.0
   say "Needs agent 3.0.0+" until the host updates.
3. Optional: install the tools in section 2 and open the receiver ports in section 5 for
   the features you want.
4. The agent's version number now moves in lockstep with the engine and dashboard (it
   jumps from 1.2.0 to 3.0.0) — one version for the whole app.

### What `update.sh` does

In order:

1. Refuses to run if there are uncommitted changes in the checkout.
2. Fetches release tags from GitHub and picks the newest (or the one you named).
3. **Checks the release's security approval** (`scripts/verify-release-tag.sh`): every
   release from 4.2.0 on is an annotated tag containing a line
   `Security review: approved <date>, report …, accepted risks: …`, written when the
   developer approved that release's security gate. A tag without it is refused before
   anything changes. Releases up to 4.1.0 predate the gate — see
   [Rolling back](#rolling-back).
4. Takes a pre-update database snapshot (to `~/looksee-backups/` by default, override
   with `LOOKSEE_BACKUP_DIR`, named after the version it was taken from — see below).
5. Checks out the release tag. The checkout is then on a tag rather than a branch
   ("detached HEAD") — that's expected; `git status` shows `HEAD detached at vX.Y.Z`.
6. Reinstalls dependencies exactly as locked (`npm ci`), runs database migrations,
   rebuilds engine and dashboard, rebuilds the agent binaries when `agent/VERSION`
   changed, and rebuilds the site collector (fetching Node.js runtimes only when their
   pinned version changed).
7. Restarts both pm2 processes and polls `/api/health` for up to 60s, until the engine
   answers healthy on the new version.
8. Runs the post-deploy security checks against `LOOKSEE_PUBLIC_URL`, if set. If they
   fail, the new version is already running; the script says so and exits with an
   error so you can fix the item or roll back.

### Rolling back

```bash
~/Looksee/scripts/update.sh v4.2.0
```

Same script, one optional argument: the release tag to deploy instead of the newest.
This is the same command whether you're deploying the newest version or rolling back to
an older one — it checks the approval and takes its own pre-update snapshot first
regardless of direction.

**Rolling back to 4.1.0 or earlier** (releases from before the security gate, which
carry no approval line) needs an explicit override and typing the tag name to confirm:

```bash
~/Looksee/scripts/update.sh v4.1.0 --allow-unreviewed
```

It only works from an interactive terminal (a script or cron job can't answer the
prompt). **What success looks like:** `WARNING: v4.1.0 has no recorded security-review
approval`, then the prompt; after you type `v4.1.0` the update proceeds as usual.

**This only rolls back code, and that part is always safe.** There are no down-migrations
in this project. If nothing schema-relevant changed between the two versions, the older
code just runs fine against the current database and there's nothing more to do.

**Rolling back the database is a separate, manual decision — never automatic.** If a
column or table was renamed, dropped, or had a constraint tightened (not just additively
added) between the version you're rolling back to and now, the old code will error
against the current schema. The fix is restoring the database snapshot taken around that
older version's original deploy, using `scripts/restore.sh` against the matching file in
`~/looksee-backups/` — every snapshot is named `pre-update-v<version>-<timestamp>.sql.gz`
(or `v<version>-<timestamp>` for `backup.sh`'s cron-driven snapshots, and the in-app Borg
backups on `/backups` follow the same `looksee-v<version>-<timestamp>` naming), so the
right one is a directory listing away, not a timestamp cross-reference against
CHANGELOG.md. **Restoring a snapshot discards any data created since it was taken** —
that's a real trade-off to weigh, not a formality, and `restore.sh` requires typed
confirmation before it touches anything.

## 9. Distributing and installing agent binaries

**The binaries are built for you.** `scripts/update.sh` builds the agent for every
supported platform whenever `agent/VERSION` changes (or the binaries are missing), into
`agent/bin/`, which the engine serves directly. It uses this server's Go toolchain if
there is one, otherwise the `golang` Docker image, run as your user with a build cache
in `~/.cache/looksee-agent-build` (first build a few minutes, later ones seconds). For a
brand-new server, build once by hand before installing any agents:

```sh
cd ~/Looksee && bash agent/build-all.sh
ls agent/bin/   # five looksee-agent-* binaries
```

**Then, on each host you want to monitor**, generate that host's agent key in the
dashboard (Hosts page) — it shows one command for Linux/macOS and one for Windows
(a toggle switches between them):

```sh
curl -fsSL https://looksee.yourdomain.com/install/agent.sh | sudo bash -s -- <key>
```
```powershell
$env:LOOKSEE_ENGINE_URL='https://looksee.yourdomain.com'; $env:LOOKSEE_AGENT_KEY='<key>'; iex (irm https://looksee.yourdomain.com/install/agent.ps1)
```

Either one detects the host's OS/arch, downloads the matching binary from this engine
(`/install/agent/:platform`, unauthenticated by design — the key is the only real
credential involved, and it's baked into the command itself), writes its config, and
installs and (re)starts it as a real service in one shot: systemd on Linux (dedicated
unprivileged user, binary in `/var/lib/looksee-agent/`, `Restart=always`), launchd on
macOS, a Scheduled Task on Windows
(no third-party service wrapper) — all using this server's own install scripts, not a
reimplementation.

Verified for real, not just written: a live agent key generated via the dashboard's own
API, the exact one-line command run verbatim in a fresh container, and the resulting
host's "last report" time confirmed updating on the engine afterward — for both the
Linux path (full end-to-end, including the systemd install) and the Windows path (the
download + config + admin-elevation check; the Scheduled Task registration itself needs
elevation this dev environment didn't have — see `agent/README.md` for exactly what was
and wasn't exercised). macOS is scripted the same way as Linux but hasn't been run on a
real Mac — flagged honestly in `agent/README.md` rather than claimed as tested.

**Updating an already-installed agent**: the Hosts page shows each host's running agent
version and an "Update agent" button (or select several hosts and use **Update agents**) —
the agent downloads the current build on its next check-in, swaps it in, and its service
manager restarts it. Re-running the install command on a host also works at any time and
restarts the agent with the new binary and key.

**Linux hosts installed before 3.1 need the install command run once more** (generate a
new key on the Hosts page and run the command it shows). Their agent binary sits in
`/usr/local/bin`, which the hardened systemd unit makes read-only to the agent, so
"Update agent" can't replace it — the agent logs "read-only file system" and keeps
running the old version. 3.1's installer moves it to `/var/lib/looksee-agent/` (leaving
a `/usr/local/bin/looksee-agent` symlink), after which "Update agent" works.

## 10. Troubleshooting

**Check the in-app Logs page (`/logs`) first** — the engine logs its own errors (failed
checks, failed notifications, failed backups, unhandled request errors) there with a
plain-language explanation alongside the technical detail, retained for
`LOOKSEE_LOG_RETENTION_DAYS` (default 30) and pruned automatically after that. `pm2 logs
looksee-engine`/`looksee-dashboard` remain the fallback for anything that happens before
the database is reachable, or for the dashboard process specifically (which doesn't write
to this table).

- **A site collector shows "not running" or "offline"** — the reason is on the
  Endpoints and Hosts pages (hover it for the full text). Common ones: *"hasn't been
  built on the Looksee server yet"* — run `scripts/update.sh` (or
  `bash scripts/build-collector.sh`) on the server; *"no Node runtime for linux-arm64"* —
  add that platform to `COLLECTOR_PLATFORMS` and re-run it; *"failed verification"* — a
  download was corrupted or altered, and the agent refused it (it retries every cycle);
  a receiver port error — something else on the collector host already uses that port.
  On the collector host, the agent's own log has every collector line prefixed
  `[collector]`: `journalctl -u looksee-agent -f` on Linux, the agent's log file on
  Windows/macOS. A line like "Cannot open directory /etc/ssl/certs" on a minimal Linux
  install is harmless (install `ca-certificates` to silence it).
- **Postgres port already in use** — something else already owns 5432 on this box. Set
  `POSTGRES_HOST_PORT` in a root `.env` (see `.env.example`) rather than hand-editing
  `docker-compose.yml`.
- **Dashboard loads but every request 401s** — check `NEXT_PUBLIC_API_URL` matches how
  you actually reached the engine (same-origin path routing vs. a separate subdomain) and
  that `CORS_ALLOWED_ORIGINS` on the engine includes the dashboard's real origin if
  they're on different domains.
- **Web Push subscribe fails silently** — it requires HTTPS (or `localhost` for dev) and
  `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY` set on the engine; check `pm2 logs
  looksee-engine` for "VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY are not configured".
- **`update.sh` stops with "[PM2][ERROR] Process or Namespace looksee-engine not
  found"** (scripts from before 3.0.1) — pm2 has no record of the apps for the user that
  ran the script: run as a different user (e.g. with `sudo`), or a reboot without
  `pm2 save`/`pm2 startup`. Everything before the restart (snapshot, migrate, build)
  already finished. As your normal user: `pm2 list` and `ss -ltnp | grep -E ':4100|:3100'`;
  if nothing holds the ports, `cd ~/Looksee && pm2 start ecosystem.config.cjs && pm2 save`.
  If an old process still holds them, stop it (`pm2 delete <name>` under its owner)
  first. 3.0.1's `update.sh` handles the unregistered case itself.
- **`git pull` or `update.sh` stops because `package-lock.json` is modified** — a
  leftover from updates before 3.0.3, which ran `npm install` and let the server's npm
  version rewrite the lockfiles. Current `update.sh` resets them itself; to clear it by
  hand: `git checkout -- engine/package-lock.json dashboard/package-lock.json`. Always
  install on the server with `npm ci`, never `npm install`.
- **`update.sh` stops at `npm ci` with "EUSAGE … package.json and package-lock.json …
  are in sync … Missing: …"** — the committed lockfile doesn't satisfy this server's npm
  version (3.0.3 shipped one generated by a newer npm). Don't run `npm install` on the
  server to "fix" it; that dirties the checkout. Update to a release with a corrected
  lockfile (`git pull && bash scripts/update.sh` — the script resets lockfile drift
  first). Nothing was changed before `npm ci` failed except the pre-update snapshot.
- **Hosts go offline right after re-running the install command with a new key** (agents
  installed before 3.1) — the old installer didn't restart an already-running agent, so
  it kept the old, now-revoked key (the agent logs `unexpected status 401`). Fix on each
  Linux host: `sudo systemctl restart looksee-agent`, or re-run the install command from
  3.1+. On Windows the old installer failed outright while the agent was running; re-run
  the 3.1+ command in an Administrator PowerShell.
- **`npm run db:migrate` fails** — confirm `docker compose ps` shows Postgres running and
  `DATABASE_URL` in `engine/.env` matches.
- **Agent reports "Invalid agent token"** — the host's agent key was reset (regenerating
  it invalidates the old one) or the wrong host's key is in `looksee-agent.yaml`.
- **An endpoint never shows as checked in** — open its **Agent** tab: *last config poll*
  says whether the agent reaches the engine at all, and a warning there gives the reason
  if its reports can't be stored. The agent's own log (on Windows
  `C:\ProgramData\LookseeAgent\looksee-agent.log`) says why from its side. The full
  walk-through, including proxy-only networks and Windows versions the agent can't run
  on, is in the agent guide:
  [Troubleshooting: an endpoint never checks in](../agent/README.md#troubleshooting-an-endpoint-never-checks-in).
- **Logs show `Database query failed: unsupported Unicode escape sequence`** (engines
  before 5.1 logged it as `Unhandled error on POST /api/agent/report: Error: Failed
  query: update "endpoints" …`) — a Windows program's name contains NUL characters (a
  SHARP printer-driver uninstaller is a known one). Update the engine to 5.1 or later;
  it cleans them out, and affected endpoints check in on their next cycle without an
  agent update.

## 11. Security notes

Looksee's own safeguards — required two-factor sign-in, lockouts, the optional IP
allowlist and new-IP email confirmation, attack detection with auto-blocking, the
security log, and recovery — are documented in the **[security guide](security-guide.md)**,
along with a hardening checklist for an internet-facing server. To reach the dashboard
(and optionally the agents) only through a VPN, see **[vpn-access.md](vpn-access.md)** —
written up, not applied to production yet. Also built in: bcrypt
password hashing, `httpOnly`/`secure`/`SameSite=Strict` session cookies, sign-in rate
limiting, security headers, notification-channel configs never returned once saved,
agent tokens scoped per host, and process command lines masked for credentials before
agents send them. Still on you as the operator:

- Keep the server's OS packages updated.
- Always deploy behind HTTPS (section 6) — Web Push and secure cookies both depend on it.
- Set `TRUST_PROXY` (section 3) and firewall ports 4100/3100 to the proxy only.
- Keep `engine/.env`/`dashboard/.env` and `agent/signing.env` out of version control
  (already gitignored) and out of chat/tickets/logs.
- Use a strong, unique admin password; keep the two-factor recovery codes in a password
  manager.
- **Public endpoints, by design**: `/api/health`, `/install/*`, published status pages
  (`/status/<slug>` — only the names, status and uptime of the checks you put on them),
  heartbeat/push URLs (`/api/hb/<token>` — the token is the credential; regenerate it on
  the check if it leaks), and the agent/collector APIs (agent key required). Everything
  else needs a signed-in session.
- **Check credentials** (database passwords, API tokens, SNMPv3 keys, backup
  passphrases) are write-only in the dashboard but are stored in the database and sent
  to the agent or collector that runs the check, so treat database backups as sensitive.
- **Agent script checks** only run files in the agent's own `script_dir` (disabled when
  unset) — the dashboard can't push new code to a host.
- **Receivers** (traps/syslog/flows) are unauthenticated; keep them LAN-only (section 5).
