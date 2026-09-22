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
(cd engine && npm install)
(cd dashboard && npm install)

echo "==> Running database migrations"
(cd engine && npm run db:migrate)

echo "==> Building for production"
(cd engine && npm run build)
(cd dashboard && npm run build)

echo "==> Restarting processes"
pm2 restart looksee-engine looksee-dashboard

echo "==> Waiting for the engine to report healthy"
for _ in $(seq 1 30); do
  if curl -sf "$ENGINE_URL/api/health" | grep -q '"status":"ok"'; then
    echo "Update complete — engine is healthy."
    exit 0
  fi
  sleep 2
done

echo "Engine did not report healthy within 60s after restart — check 'pm2 logs looksee-engine'." >&2
exit 1
