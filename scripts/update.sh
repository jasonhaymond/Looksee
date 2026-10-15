#!/usr/bin/env bash
# One-command production update: verify the release's security approval,
# snapshot the database, check out the release, install, migrate, build,
# restart, verify health, then run the post-deploy security checks. Refuses to
# run over uncommitted local changes so it can never silently overwrite
# server-side state. Run from anywhere; always operates on the repo this
# script lives in.
#
# Usage:
#   ./update.sh                 # deploy the newest release tag (vX.Y.Z)
#   ./update.sh v4.2.0          # deploy (or roll back to) a specific release
#   ./update.sh v4.1.0 --allow-unreviewed
#                               # a release from before the security gate
#                               # existed (typed confirmation required)
#
# Only tagged releases are deployed, and only ones whose annotated tag records
# the developer's security-review approval (scripts/verify-release-tag.sh).
# Releases up to v4.1.0 predate that gate; deploying one (normally a rollback)
# needs --allow-unreviewed and typing the tag name, from an interactive
# terminal only, so no automation can skip the check.
#
# Rolling back with a tag here only rolls back code — it's always safe and
# reproducible. It does NOT touch the database. If the schema changed
# non-additively since that version, old code will error against the current
# schema; the fix is restoring the matching pre-update snapshot this script
# takes below (see docs/deployment-guide.md's "Rolling back" section), which
# discards data created since. That's never done automatically.
#
# After a tag is checked out the repository is in "detached HEAD" state (on a
# tag, not a branch). That's expected: every update fetches and checks out a
# tag, so no branch is ever pulled on the server.

# -e: stop at the first failing command; -u: unset variables are errors;
# -o pipefail: a pipeline fails if any command in it fails.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${LOOKSEE_BACKUP_DIR:-$HOME/looksee-backups}"
ENGINE_URL="${LOOKSEE_ENGINE_URL:-http://localhost:4100}"

# ---- Arguments ----------------------------------------------------------------
TARGET_REF=""
ALLOW_UNREVIEWED=0
for arg in "$@"; do
  case "$arg" in
    --allow-unreviewed) ALLOW_UNREVIEWED=1 ;;
    -*) echo "Unknown option: $arg" >&2; exit 2 ;;
    *) TARGET_REF="$arg" ;;
  esac
done

# Server-specific settings from the root .env (gitignored), if present: the
# public URL for the post-deploy checks and which collector runtimes to keep.
# Read line by line rather than `source`d, so the file can't run commands.
read_root_env() {
  [ -f .env ] || return 0
  grep -E "^$1=" .env | tail -1 | cut -d= -f2- | tr -d '"' || true
}

# package-lock.json drift isn't a real local change: before 3.0.3 this script
# ran `npm install`, which rewrites the lockfiles whenever the server's npm
# version serializes them differently from the one that generated them. Put
# them back so that leftover drift can't block the update. Only these two
# files — any other local change still stops the update below.
for lockfile in engine/package-lock.json dashboard/package-lock.json; do
  if [ -n "$(git status --porcelain -- "$lockfile")" ]; then
    echo "==> Resetting $lockfile (npm-version formatting drift, not a real change)"
    git checkout -- "$lockfile"
  fi
done

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to update: uncommitted local changes in $REPO_ROOT." >&2
  echo "Commit, stash, or discard them first." >&2
  exit 1
fi

# ---- Which release, and is it approved? ------------------------------------------
echo "==> Fetching releases"
# --force: if a tag was ever moved upstream, take GitHub's version of it.
git fetch --tags --force origin
if [ -z "$TARGET_REF" ]; then
  # Newest release by version number (v4.10.0 sorts after v4.9.0).
  TARGET_REF="$(git tag --list 'v*' --sort=-v:refname | head -1)"
  [ -n "$TARGET_REF" ] || { echo "No release tags (v*) found on origin." >&2; exit 1; }
  echo "    Newest release: $TARGET_REF"
fi

echo "==> Checking the security-review approval for $TARGET_REF"
if ! bash scripts/verify-release-tag.sh "$TARGET_REF"; then
  if [ "$ALLOW_UNREVIEWED" = 1 ]; then
    # Interactive only: [ -t 0 ] is true when input comes from a terminal, so
    # a script or cron job can't pass this check by piping in the answer.
    if [ ! -t 0 ]; then
      echo "--allow-unreviewed needs an interactive terminal (type the tag name to confirm)." >&2
      exit 1
    fi
    echo "WARNING: $TARGET_REF has no recorded security-review approval." >&2
    echo "Deploy it anyway only to roll back to a release from before the gate existed." >&2
    read -r -p "Type the tag name ($TARGET_REF) to deploy it anyway: " CONFIRM
    [ "$CONFIRM" = "$TARGET_REF" ] || { echo "Not confirmed — nothing changed." >&2; exit 1; }
  else
    echo "Refusing to deploy $TARGET_REF. Deploy an approved release, or, to roll back to" >&2
    echo "a release from before the security gate existed: ./update.sh $TARGET_REF --allow-unreviewed" >&2
    exit 1
  fi
fi

echo "==> Taking a pre-update database snapshot"
mkdir -p "$BACKUP_DIR"
# Named after the version actually running before this update (read from
# app_meta, upserted on every boot) so a rollback later can pick the right
# snapshot off a directory listing instead of cross-referencing timestamps.
CURRENT_VERSION="$(docker compose exec -T postgres psql -U looksee -d looksee -tAc "SELECT version FROM app_meta WHERE id = 1" 2>/dev/null || true)"
CURRENT_VERSION="${CURRENT_VERSION:-unknown}"
SNAPSHOT_FILE="$BACKUP_DIR/pre-update-v${CURRENT_VERSION}-$(date +%Y%m%d-%H%M%S).sql.gz"
# --clean --if-exists makes the dump restorable onto a non-empty database
# (without it, a restore silently keeps the newer rows).
docker compose exec -T postgres pg_dump -U looksee --clean --if-exists looksee | gzip > "$SNAPSHOT_FILE"
echo "    Saved to $SNAPSHOT_FILE"

echo "==> Checking out $TARGET_REF"
git checkout --quiet "$TARGET_REF"

echo "==> Installing dependencies"
# npm ci installs exactly what the committed lockfile pins and never
# rewrites it, so the checkout stays clean for the next update (npm install
# re-serializes the lockfile with the server's npm version).
(cd engine && npm ci)
(cd dashboard && npm ci)

echo "==> Running database migrations"
# Applies only migrations committed in engine/drizzle/, forward-only.
(cd engine && npm run db:migrate)

echo "==> Building for production"
(cd engine && npm run build)
(cd dashboard && npm run build)

# Agent binaries are what the engine serves to "Update agent" and the install
# command, so they're built here rather than as a separate step — but only
# when agent/VERSION differs from what the existing binaries were built as
# (a five-platform build takes a minute or two), or the binaries are missing.
AGENT_VERSION="$(tr -d '[:space:]' < agent/VERSION)"
AGENT_STAMP="agent/bin/.built-version"
BUILT_VERSION="$(tr -d '[:space:]' 2>/dev/null < "$AGENT_STAMP" || true)"
if [ "$BUILT_VERSION" = "$AGENT_VERSION" ] && [ -f agent/bin/looksee-agent-linux-amd64 ]; then
  echo "==> Agent binaries are already v$AGENT_VERSION — skipping the agent build"
else
  echo "==> Building agent binaries v$AGENT_VERSION (was: ${BUILT_VERSION:-none}) — local Go, or the golang Docker image"
  bash agent/build-all.sh
  echo "$AGENT_VERSION" > "$AGENT_STAMP"
fi

# The site collector bundle is rebuilt every time (a second or two); the Node
# runtimes agents download for it are cached and only fetched when
# engine/src/collector/NODE_VERSION changes. COLLECTOR_PLATFORMS in the root
# .env limits which runtimes are kept.
COLLECTOR_PLATFORMS="$(read_root_env COLLECTOR_PLATFORMS)"
[ -n "$COLLECTOR_PLATFORMS" ] && export COLLECTOR_PLATFORMS
bash scripts/build-collector.sh

echo "==> Restarting processes"
# startOrReload (not restart) so the update also works when pm2 has no
# record of the apps — after a reboot without `pm2 save`/`pm2 startup`, or
# when run as a different user than the one that first started them. A
# plain `pm2 restart` fails with "Process or Namespace not found" there.
# systemd equivalent: `sudo systemctl restart looksee-engine looksee-dashboard`.
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

EXPECTED_VERSION="$(node -p "require('./engine/package.json').version")"
echo "==> Waiting for the engine to report healthy on v$EXPECTED_VERSION"
HEALTHY=0
for _ in $(seq 1 30); do
  HEALTH="$(curl -sf "$ENGINE_URL/api/health" || true)"
  # The version must match too: an old process left running under another
  # name (or another user's pm2) would otherwise answer "ok" on old code.
  if echo "$HEALTH" | grep -q '"status":"ok"' && echo "$HEALTH" | grep -q "\"version\":\"$EXPECTED_VERSION\""; then
    HEALTHY=1
    break
  fi
  sleep 2
done
if [ "$HEALTHY" != 1 ]; then
  echo "Engine did not report healthy on v$EXPECTED_VERSION within 60s." >&2
  echo "Last health response: ${HEALTH:-<none>}" >&2
  echo "Check 'pm2 list' (as the user that runs Looksee) and 'pm2 logs looksee-engine'." >&2
  echo "If an older version answered, something else still holds port 4100: 'ss -ltnp | grep 4100'." >&2
  exit 1
fi
echo "    Engine is healthy on v$EXPECTED_VERSION."

# Post-deploy security checks against the public address, through the
# reverse proxy as the internet sees it: HTTPS and certificate, security
# headers, admin routes refusing anonymous requests, CORS, sign-in rate
# limiting. Set LOOKSEE_PUBLIC_URL in the root .env to enable them.
PUBLIC_URL="${LOOKSEE_PUBLIC_URL:-$(read_root_env LOOKSEE_PUBLIC_URL)}"
if [ ! -f scripts/security-check.sh ]; then
  # A rollback to a release from before the security gate existed.
  echo "==> Skipping post-deploy security checks: $TARGET_REF predates scripts/security-check.sh."
elif [ -n "$PUBLIC_URL" ]; then
  echo "==> Post-deploy security checks against $PUBLIC_URL"
  if ! bash scripts/security-check.sh --live "$PUBLIC_URL"; then
    echo "Update deployed, but the post-deploy security checks FAILED (see above and security-reports/)." >&2
    echo "The new version is running; fix the failing item or roll back: ./update.sh <previous tag>" >&2
    exit 1
  fi
else
  echo "==> Skipping post-deploy security checks: set LOOKSEE_PUBLIC_URL in $REPO_ROOT/.env to enable them."
fi

echo "Update complete — v$EXPECTED_VERSION is live."
