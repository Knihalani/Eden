#!/usr/bin/env bash
# Daily Postgres backup (§9.5.3).
#
# Dumps the ``eden`` database to a gzipped SQL file and uploads
# to S3 if BACKUP_S3_BUCKET is set. Cron via the
# `.github/workflows/db-backup.yml` workflow or a system cron.
set -euo pipefail

CONTAINER="${PG_CONTAINER:-eden_postgres}"
DB="${PG_DB:-eden}"
USER="${PG_USER:-eden}"
LOCAL_DIR="${BACKUP_LOCAL_DIR:-./backups}"
S3_BUCKET="${BACKUP_S3_BUCKET:-}"

mkdir -p "$LOCAL_DIR"
TS=$(date -u +"%Y%m%dT%H%M%SZ")
OUT="$LOCAL_DIR/eden-${TS}.sql.gz"

echo "[backup] dumping $DB → $OUT"
docker exec "$CONTAINER" pg_dump -U "$USER" -d "$DB" --no-owner --no-acl | gzip > "$OUT"
echo "[backup] wrote $OUT ($(du -h "$OUT" | cut -f1))"

# Retain 30 days locally
find "$LOCAL_DIR" -name "eden-*.sql.gz" -mtime +30 -delete

if [ -n "$S3_BUCKET" ]; then
    echo "[backup] uploading to s3://$S3_BUCKET/"
    aws s3 cp "$OUT" "s3://$S3_BUCKET/$(basename "$OUT")"
fi
