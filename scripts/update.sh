#!/usr/bin/env bash
# One-command production update: snapshot, pull (or check out a specific
# version), install, migrate, build, restart, verify. Refuses to run over
# uncommitted local changes so it can never silently overwrite server-side
# state. Run from anywhere; always operates on the repo this script lives in.
#
# Usage:
#   ./update.sh            # deploy the latest commit on the current branch
#   ./update.sh v0.3.1     # deploy (or roll back to) a specific tagged version
#
# Rolling back with a tag here only rolls back code — it's always safe and
# reproducible. It does NOT touch the database. If the schema changed
# non-additively since that version, old code will error against the current
# schema; the fix is restoring the matching pre-update snapshot this script
# takes below (see docs/deployment-guide.md's "Rolling back" section), which
# discards data created since. That's never done automatically.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${LOOKSEE_BACKUP_DIR:-$HOME/looksee-backups}"
ENGINE_URL="${LOOKSEE_ENGINE_URL:-http://localhost:4100}"
TARGET_REF="${1:-}"

# package-lock.json drift isn't a real local change: before 3.0.3 this script
# ran `npm install`, which rewrites the lockfiles whenever the server's npm
# version serializes them differently from the one that generated them. Put
# them back so that leftover drift can't block the pull. Only these two
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

echo "==> Taking a pre-update database snapshot"
mkdir -p "$BACKUP_DIR"
# Named after the version actually running before this update (read from
# app_meta, upserted on every boot) so a rollback later can pick the right
# snapshot off a directory listing instead of cross-referencing timestamps.
CURRENT_VERSION="$(docker compose exec -T postgres psql -U looksee -d looksee -tAc "SELECT version FROM app_meta WHERE id = 1" 2>/dev/null || true)"
CURRENT_VERSION="${CURRENT_VERSION:-unknown}"
SNAPSHOT_FILE="$BACKUP_DIR/pre-update-v${CURRENT_VERSION}-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T postgres pg_dump -U looksee --clean --if-exists looksee | gzip > "$SNAPSHOT_FILE"
echo "    Saved to $SNAPSHOT_FILE"

if [ -n "$TARGET_REF" ]; then
  echo "==> Fetching tags and checking out $TARGET_REF"
  git fetch --tags
  git checkout "$TARGET_REF"
else
  echo "==> Pulling latest code"
  git pull
fi

echo "==> Installing dependencies"
# npm ci installs exactly what the committed lockfile pins and never
# rewrites it, so the checkout stays clean for the next pull (npm install
# re-serializes the lockfile with the server's npm version).
(cd engine && npm ci)
(cd dashboard && npm ci)

echo "==> Running database migrations"
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
if [ -f .env ]; then
  COLLECTOR_PLATFORMS="$(grep -E '^COLLECTOR_PLATFORMS=' .env | tail -1 | cut -d= -f2- | tr -d '"' || true)"
  [ -n "$COLLECTOR_PLATFORMS" ] && export COLLECTOR_PLATFORMS
fi
bash scripts/build-collector.sh

echo "==> Restarting processes"
# startOrReload (not restart) so the update also works when pm2 has no
# record of the apps — after a reboot without `pm2 save`/`pm2 startup`, or
# when run as a different user than the one that first started them. A
# plain `pm2 restart` fails with "Process or Namespace not found" there.
pm2 startOrReload ecosystem.config.cjs --update-env
pm2 save

EXPECTED_VERSION="$(node -p "require('./engine/package.json').version")"
echo "==> Waiting for the engine to report healthy on v$EXPECTED_VERSION"
for _ in $(seq 1 30); do
  HEALTH="$(curl -sf "$ENGINE_URL/api/health" || true)"
  # The version must match too: an old process left running under another
  # name (or another user's pm2) would otherwise answer "ok" on old code.
  if echo "$HEALTH" | grep -q '"status":"ok"' && echo "$HEALTH" | grep -q "\"version\":\"$EXPECTED_VERSION\""; then
    echo "Update complete — engine is healthy on v$EXPECTED_VERSION."
    exit 0
  fi
  sleep 2
done

echo "Engine did not report healthy on v$EXPECTED_VERSION within 60s." >&2
echo "Last health response: ${HEALTH:-<none>}" >&2
echo "Check 'pm2 list' (as the user that runs Looksee) and 'pm2 logs looksee-engine'." >&2
echo "If an older version answered, something else still holds port 4100: 'ss -ltnp | grep 4100'." >&2
exit 1
