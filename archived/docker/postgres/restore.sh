#!/usr/bin/env bash
# Restore from a backup file (§9.5.3).
#
# Usage: restore.sh <path-to-sql.gz>
#        restore.sh --latest   # use the most recent local backup
set -euo pipefail

CONTAINER="${PG_CONTAINER:-eden_postgres}"
DB="${PG_DB:-eden}"
USER="${PG_USER:-eden}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-./backups}"

if [ "${1:-}" = "--latest" ]; then
    target=$(ls -1t "$LOCAL_DIR"/eden-*.sql.gz 2>/dev/null | head -1 || true)
    if [ -z "$target" ]; then
        echo "[restore] no backup found in $LOCAL_DIR" >&2
        exit 1
    fi
else
    target="${1:?usage: restore.sh <path-to-sql.gz> | --latest}"
fi

echo "[restore] reading $target"
echo "[restore] dropping and recreating $DB"
docker exec "$CONTAINER" dropdb -U "$USER" --if-exists "$DB"
docker exec "$CONTAINER" createdb -U "$USER" "$DB"

echo "[restore] loading"
gunzip -c "$target" | docker exec -i "$CONTAINER" psql -U "$USER" -d "$DB" >/dev/null

echo "[restore] done. Verify with: docker exec $CONTAINER psql -U $USER -d $DB -c 'SELECT COUNT(*) FROM jobs;'"
