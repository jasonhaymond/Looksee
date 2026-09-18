# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

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
