#!/usr/bin/env bash
# Manual backup fallback: dumps the database and copies both .env files
# (secrets that aren't in git and can't be regenerated) into one dated
# directory, then prunes anything older than RETENTION_DAYS. This is a
# stopgap, not the real mechanism — see docs/deployment-guide.md's Backups
# section for why (no encrypted/deduplicated/off-host story yet). Intended
# for a daily cron entry:
#   0 3 * * * /path/to/Looksee/scripts/backup.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

BACKUP_DIR="${LOOKSEE_BACKUP_DIR:-$HOME/looksee-backups}"
RETENTION_DAYS="${LOOKSEE_BACKUP_RETENTION_DAYS:-14}"
STAMP="$(date +%Y%m%d-%H%M%S)"
# Named after the version actually running (app_meta, upserted on every
# boot) rather than package.json, which can drift from what's deployed —
# falls back to "unknown" on a pre-migration database.
VERSION="$(docker compose exec -T postgres psql -U looksee -d looksee -tAc "SELECT version FROM app_meta WHERE id = 1" 2>/dev/null || true)"
VERSION="${VERSION:-unknown}"
DEST="$BACKUP_DIR/v${VERSION}-$STAMP"

mkdir -p "$DEST"
docker compose exec -T postgres pg_dump -U looksee --clean --if-exists looksee | gzip > "$DEST/looksee.sql.gz"
[ -f engine/.env ] && cp engine/.env "$DEST/engine.env"
[ -f dashboard/.env ] && cp dashboard/.env "$DEST/dashboard.env"

echo "Backed up to $DEST"

find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -mtime "+$RETENTION_DAYS" -print -exec rm -rf {} \;
