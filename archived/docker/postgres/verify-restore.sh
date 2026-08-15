#!/usr/bin/env bash
# Restore-and-verify (§9.5.3 — backup/restore drill step).
#
# Restores the latest backup into a SEPARATE ``eden_restore_test``
# database (so production is untouched), runs a smoke query, and
# drops the test DB. Used by `scripts/dr_drill.sh` and can be
# invoked standalone.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-eden_postgres}"
USER="${PG_USER:-eden}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-./backups}"
TARGET_DB="eden_restore_test"

backup=$(ls -1t "$LOCAL_DIR"/eden-*.sql.gz 2>/dev/null | head -1 || true)
if [ -z "$backup" ]; then
    echo "[verify-restore] no backup found in $LOCAL_DIR" >&2
    exit 1
fi
echo "[verify-restore] using $backup"

docker exec "$CONTAINER" dropdb -U "$USER" --if-exists "$TARGET_DB"
docker exec "$CONTAINER" createdb -U "$USER" "$TARGET_DB"
gunzip -c "$backup" | docker exec -i "$CONTAINER" psql -U "$USER" -d "$TARGET_DB" >/dev/null

echo "[verify-restore] smoke queries:"
docker exec "$CONTAINER" psql -U "$USER" -d "$TARGET_DB" -c "SELECT COUNT(*) AS jobs FROM jobs;"
docker exec "$CONTAINER" psql -U "$USER" -d "$TARGET_DB" -c "SELECT COUNT(*) AS insights FROM insights;"

docker exec "$CONTAINER" dropdb -U "$USER" "$TARGET_DB"
echo "[verify-restore] OK"
