#!/usr/bin/env bash
# Restores a database dump produced by backup.sh or update.sh's pre-update
# snapshot. Destructive: replaces every row in the live database with the
# snapshot's contents. Usage:
#   scripts/restore.sh /path/to/looksee.sql.gz
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DUMP_FILE="${1:?Usage: scripts/restore.sh /path/to/dump.sql.gz}"
[ -f "$DUMP_FILE" ] || { echo "No such file: $DUMP_FILE" >&2; exit 1; }

echo "This will REPLACE all data in the 'looksee' database with the contents of:"
echo "  $DUMP_FILE"
read -r -p "Type RESTORE to continue: " confirm
[ "$confirm" = "RESTORE" ] || { echo "Aborted."; exit 1; }

gunzip -c "$DUMP_FILE" | docker compose exec -T postgres psql -U looksee looksee

echo "Restore complete. Run 'cd engine && npm run db:migrate' if this dump predates recent migrations."
