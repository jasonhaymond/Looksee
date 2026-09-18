# Deployment Guide

A walkthrough for putting Looksee on a real server in your homelab — not just running it on
a dev machine. If you only need local development, see the [README](../README.md) instead;
this is for a first real deployment and for updating one you already have running.

This is a **single-environment deployment** — no staging environment, by design (see
`CLAUDE.md`: solo personal tool, low blast-radius). Everything here assumes Ubuntu/Debian;
adjust package manager commands for another distro.

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
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs git

if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

sudo npm install -g pm2

# Only needed if you plan to build agent binaries on this server rather than
# via the Docker-based build in agent/README.md
# curl -fsSL https://go.dev/dl/go1.22.linux-amd64.tar.gz | sudo tar -C /usr/local -xz
# echo 'export PATH=$PATH:/usr/local/go/bin' >> ~/.bashrc
```

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
# used to build the agent install command shown on the Hosts page), SMTP_*
# if you want email alerts, and VAPID_* for Web Push (see .env.example for
# the generate command — never regenerate once real subscriptions exist).
npm install
npm run db:migrate
npm run db:create-admin   # interactive — run in a real terminal, not piped

cd ../dashboard
cp .env.example .env
# Edit .env: NEXT_PUBLIC_API_URL — see the reverse-proxy section below for
# why the recommended value is the same public URL as the dashboard itself.
npm install
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
`pm2 restart looksee-engine looksee-dashboard` (used by `scripts/update.sh`).

**If you use systemd instead of pm2**, create `/etc/systemd/system/looksee-engine.service`
and `looksee-dashboard.service` with `WorkingDirectory`/`ExecStart` pointing at
`node dist/index.js` (engine) and `node_modules/.bin/next start -p 3100` (dashboard)
respectively, `Restart=on-failure`, then `sudo systemctl enable --now` both. Replace the
`pm2 restart` line in `scripts/update.sh` with `sudo systemctl restart looksee-engine
looksee-dashboard` if you go this route.

## 5. Firewall

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
```

Don't open 5432 (Postgres, already bound to `127.0.0.1` by `docker-compose.yml`), 4100
(engine), or 3100 (dashboard) — only Caddy needs to be internet/LAN-reachable.

## 6. Reverse proxy + HTTPS

**Single domain, path-routed** — this is the setup section 3 above assumes, and it's
simpler than running engine and dashboard on separate subdomains because it makes them
same-origin (no CORS, simpler cookies):

```caddy
looksee.haymondtechnologies.com {
  @api path /api/*
  handle @api {
    reverse_proxy localhost:4100
  }
  handle {
    reverse_proxy localhost:3100
  }
}
```

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

Takes a pre-update snapshot (to `~/looksee-backups/` by default, override with
`LOOKSEE_BACKUP_DIR`), pulls, reinstalls dependencies, migrates, rebuilds both engine and
dashboard, restarts both pm2 processes, and polls `/api/health` for up to 60s before
declaring success. Refuses to run if there are uncommitted changes in the checkout.

## 9. Distributing and installing agent binaries

**Build once, on this server**, for every supported platform:

```sh
cd ~/Looksee/agent
./build-all.sh
```

Falls back to a Docker-based build automatically if this server has no Go toolchain.
Outputs to `agent/bin/` — the engine serves these directly from there, so this only needs
re-running after pulling agent code changes, not on every host you add.

**Then, on each host you want to monitor**, generate that host's agent key in the
dashboard (Hosts page) and run the one-line command it shows:

```sh
curl -fsSL https://looksee.yourdomain.com/install/agent.sh | sudo bash -s -- <key>
```

This detects the host's OS/arch, downloads the matching binary from this engine
(`/install/agent/:platform`, unauthenticated by design — the key is the only real
credential involved, and it's baked into the command itself), writes its config, and — on
Linux — installs and starts it as a systemd service (dedicated unprivileged user,
`Restart=on-failure`, config locked to mode 600) in one shot, using the exact same
`agent/install.sh` this server already has. Windows and macOS download the binary +
config but don't auto-install as a service yet — see `agent/README.md` for the manual
NSSM/Task Scheduler/launchd steps.

Verified for real, not just written: a live agent key generated via the dashboard's own
API, the exact one-line command run verbatim in a fresh container, and the resulting
host's "last report" time confirmed updating on the engine afterward.

## 10. Troubleshooting

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
- **`npm run db:migrate` fails** — confirm `docker compose ps` shows Postgres running and
  `DATABASE_URL` in `engine/.env` matches.
- **Agent reports "Invalid agent token"** — the host's agent key was reset (regenerating
  it invalidates the old one) or the wrong host's key is in `looksee-agent.yaml`.

## 11. Security notes

Already built in: rate limiting on login, httpOnly+secure session cookies, bcrypt
password hashing, notification-channel configs never returned once saved, agent tokens
scoped per-host. Still on you as the operator:

- Keep the server's OS packages updated.
- Always deploy behind HTTPS (section 6) — Web Push and secure cookies both depend on it.
- Keep `engine/.env`/`dashboard/.env` out of version control (already gitignored) and out
  of chat/tickets/logs.
- Use a strong, unique admin password (`npm run db:create-admin`).
