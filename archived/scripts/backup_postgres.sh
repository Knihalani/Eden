#!/usr/bin/env bash
# Produce a Postgres backup that scripts/dr_drill.sh can actually restore.
#
# Why this exists
# ---------------
# Nothing in this repository has ever created a backup. ``dr_drill.sh`` looks for
# ``$BACKUP_LOCAL_DIR/eden-*.sql.gz`` (or pulls the same shape from S3) and, when
# it finds none, writes ``{"verdict": "FAIL", "reason": "no backup found"}`` and
# exits 2 — correctly. The weekly ``dr-drill.yml`` workflow has therefore been
# red every Monday since it was added, and ``w29_flag_dr_drills.sh`` swallowed
# the exit code so its own report still said PASS.
#
# A restore verifier with nothing to restore is theatre. This script is the
# missing half: it writes exactly the artifact the drill expects, so the drill
# becomes a real end-to-end check instead of a permanent failure.
#
# Honesty note
# ------------
# This has been exercised against a local Postgres only. The Neon and S3 paths
# are written from their documented interfaces and have NOT been run against a
# real Neon project or bucket — that needs credentials this repo does not carry.
# Treat the first scheduled run as the verification, and read its log. The script
# fails loudly on every error rather than degrading to a warning, precisely so
# that first run cannot quietly report success.
#
# Usage
#   DATABASE_URL=postgres://…            scripts/backup_postgres.sh
#   BACKUP_S3_BUCKET=eden-prod-backups   scripts/backup_postgres.sh   # + upload
#   BACKUP_RETENTION_DAYS=14             scripts/backup_postgres.sh   # default 14

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-$ROOT/backups}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
REPORT_DIR="${REPORT_DIR:-$ROOT/reports}"

mkdir -p "$BACKUP_LOCAL_DIR" "$REPORT_DIR"
TS=$(date -u +"%Y%m%dT%H%M%SZ")
# The name must match dr_drill.sh's glob (eden-*.sql.gz) or the drill will not
# find what this just wrote.
OUT="$BACKUP_LOCAL_DIR/eden-${TS}.sql.gz"
REPORT="$REPORT_DIR/backup-${TS}.json"

fail() {
    echo "[backup] FAIL: $*" >&2
    cat > "$REPORT" <<EOF
{"ts": "$TS", "verdict": "FAIL", "reason": "$*"}
EOF
    exit 1
}

if [ -z "${DATABASE_URL:-}" ]; then
    fail "DATABASE_URL is not set; refusing to claim a backup was taken"
fi
command -v pg_dump >/dev/null || fail "pg_dump not on PATH"
command -v gzip >/dev/null || fail "gzip not on PATH"

echo "[backup] dumping to $OUT"
# --no-owner/--no-privileges so the dump restores into a differently-owned
# database (the drill restores into a scratch role, and Neon's roles differ from
# a local one). Plain SQL rather than a custom-format archive because the drill
# restores with psql, not pg_restore.
if ! pg_dump \
        --no-owner \
        --no-privileges \
        --format=plain \
        --dbname="$DATABASE_URL" \
    | gzip -9 > "$OUT"; then
    rm -f "$OUT"
    fail "pg_dump failed"
fi

# A gzip stream that decompresses is the minimum bar for calling this a backup.
gzip -t "$OUT" || { rm -f "$OUT"; fail "produced file is not valid gzip"; }

bytes=$(wc -c < "$OUT" | tr -d ' ')
# An empty-ish dump means pg_dump "succeeded" against nothing. 1 KiB is far
# below any real schema and catches the wrong-database case.
if [ "$bytes" -lt 1024 ]; then
    rm -f "$OUT"
    fail "dump is only ${bytes} bytes — refusing to pass off an empty backup"
fi
echo "[backup] wrote $OUT (${bytes} bytes)"

uploaded=false
if [ -n "$BACKUP_S3_BUCKET" ]; then
    command -v aws >/dev/null || fail "BACKUP_S3_BUCKET set but aws CLI missing"
    echo "[backup] uploading to s3://$BACKUP_S3_BUCKET/"
    # No ``|| true`` here. A backup that only exists on an ephemeral CI runner
    # is not a backup, so an upload failure is a hard failure.
    aws s3 cp "$OUT" "s3://$BACKUP_S3_BUCKET/$(basename "$OUT")" \
        || fail "s3 upload failed"
    uploaded=true
fi

# Retention: local copies only. S3 lifecycle rules own the remote side; deleting
# remote objects from a backup job is how a bad run destroys history.
pruned=0
while IFS= read -r old; do
    rm -f "$old"
    pruned=$((pruned + 1))
done < <(find "$BACKUP_LOCAL_DIR" -name 'eden-*.sql.gz' -type f \
             -mtime "+${BACKUP_RETENTION_DAYS}" 2>/dev/null || true)

cat > "$REPORT" <<EOF
{
  "ts": "$TS",
  "verdict": "PASS",
  "path": "$OUT",
  "bytes": $bytes,
  "uploaded_to_s3": $uploaded,
  "pruned_local": $pruned,
  "retention_days": $BACKUP_RETENTION_DAYS
}
EOF
echo "[backup] verdict: PASS (report $REPORT)"
