#!/usr/bin/env bash
# One-command production update: snapshot, pull, install, migrate, build,
# restart, verify. Refuses to run over uncommitted local changes so it can
# never silently overwrite server-side state. Run from anywhere; always
# operates on the repo this script lives in.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${LOOKSEE_BACKUP_DIR:-$HOME/looksee-backups}"
ENGINE_URL="${LOOKSEE_ENGINE_URL:-http://localhost:4100}"

if [ -n "$(git status --porcelain)" ]; then
  echo "Refusing to update: uncommitted local changes in $REPO_ROOT." >&2
  echo "Commit, stash, or discard them first." >&2
  exit 1
fi

echo "==> Taking a pre-update database snapshot"
mkdir -p "$BACKUP_DIR"
SNAPSHOT_FILE="$BACKUP_DIR/pre-update-$(date +%Y%m%d-%H%M%S).sql.gz"
docker compose exec -T postgres pg_dump -U looksee --clean --if-exists looksee | gzip > "$SNAPSHOT_FILE"
echo "    Saved to $SNAPSHOT_FILE"

echo "==> Pulling latest code"
git pull

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
