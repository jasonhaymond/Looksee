#!/usr/bin/env bash
# Restores a database dump produced by backup.sh or update.sh's pre-update
# snapshot (a gzipped plain-SQL pg_dump), making the database exactly what it
# was when the snapshot was taken.
#
# Destructive: everything in the live 'looksee' database is deleted first —
# every table, including ones the snapshot never had — and then the
# snapshot is loaded. Anything recorded since the snapshot is lost. That's
# deliberate: loading an older snapshot *over* a newer schema (for example a
# 4.3 snapshot over a 5.0 database, whose tables were renamed) can't merge
# the two and would leave a broken mix of both, so the old schema is cleared
# completely before the snapshot goes in.
#
# Usage:
#   scripts/restore.sh /path/to/looksee.sql.gz
#
# Typical use is rolling back: restore the snapshot taken before an upgrade,
# then deploy the matching code with `scripts/update.sh vX.Y.Z` (see
# docs/deployment-guide.md → Rolling back). Asks for typed confirmation
# before touching anything.
set -euo pipefail

# Work from the repository root so `docker compose` finds the project's
# compose file (and its postgres service) whatever folder this is run from.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# The dump to restore: first argument, required, must exist.
DUMP_FILE="${1:?Usage: scripts/restore.sh /path/to/dump.sql.gz}"
[ -f "$DUMP_FILE" ] || { echo "No such file: $DUMP_FILE" >&2; exit 1; }

# Make sure the file is a readable gzip before anything is deleted — a
# truncated or wrong file found now costs nothing; found after the wipe it
# would leave an empty database.
gunzip -t "$DUMP_FILE" || { echo "$DUMP_FILE isn't a readable .gz file — nothing was changed." >&2; exit 1; }

echo "This will DELETE all data in the 'looksee' database and replace it with:"
echo "  $DUMP_FILE"
echo "Anything recorded since that snapshot was taken will be lost."
read -r -p "Type RESTORE to continue: " confirm
[ "$confirm" = "RESTORE" ] || { echo "Aborted."; exit 1; }

# Clear the database: the app's tables live in the 'public' schema and
# Drizzle's record of applied migrations in the 'drizzle' schema. Dropping
# both (CASCADE removes everything inside them) leaves an empty database
# for the snapshot to recreate exactly. ON_ERROR_STOP makes psql stop at
# the first error instead of carrying on with a half-done job; the
# client_min_messages line hides the long list of what CASCADE removed.
docker compose exec -T postgres psql -U looksee -v ON_ERROR_STOP=1 -q looksee <<'SQL'
SET client_min_messages = warning;
DROP SCHEMA IF EXISTS drizzle CASCADE;
DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;
SQL

# Load the snapshot. The dump was made with --clean --if-exists, so its own
# DROP ... IF EXISTS lines are harmless no-ops on the now-empty database.
# A failure here stops immediately with psql's message.
if ! gunzip -c "$DUMP_FILE" | docker compose exec -T postgres psql -U looksee -v ON_ERROR_STOP=1 -q looksee >/dev/null; then
  echo "Restore FAILED part-way — the database is incomplete. Fix the error above and run this again with the same file." >&2
  exit 1
fi

# Show which app version's data this was: app_meta holds the version that
# last ran against it (absent in snapshots from before 4.0).
version="$(docker compose exec -T postgres psql -U looksee -tA looksee -c "select version from app_meta where id = 1" 2>/dev/null || true)"
echo "Restore complete${version:+ — this data was last used by Looksee v$version}."
echo "Deploy the matching code next, e.g.: scripts/update.sh v${version:-X.Y.Z}"
