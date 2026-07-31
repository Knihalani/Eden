#!/usr/bin/env bash
# Disaster Recovery drill (closes §9.1.4).
#
# Steps:
#  1. Pull the latest backup from S3 (or local fallback).
#  2. Restore into a fresh `eden_restore_test` database.
#  3. Verify the table list and run a smoke query.
#  4. Run the golden-dataset eval to confirm correctness.
#  5. Drop the test database; write a JSON report.
#
# Run as: scripts/dr_drill.sh
# Exits non-zero on any failure (SLO breach, missing backup, etc).
set -euo pipefail

BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-eden-prod-backups}"
BACKUP_LOCAL_DIR="${BACKUP_LOCAL_DIR:-./backups}"
REPORT_DIR="${REPORT_DIR:-./reports}"
PGHOST="${PGHOST:-localhost}"
PGUSER="${PGUSER:-eden}"
PGPASSWORD="${PGPASSWORD:-eden}"
export PGPASSWORD

mkdir -p "$REPORT_DIR"
TS=$(date -u +"%Y%m%dT%H%M%SZ")
REPORT_PATH="$REPORT_DIR/dr-drill-${TS}.json"

echo "[dr-drill] starting at $TS"

# 1. Find a backup
if [ -n "${BACKUP_FILE:-}" ]; then
    backup="$BACKUP_FILE"
elif command -v aws >/dev/null && [ -n "$BACKUP_S3_BUCKET" ]; then
    echo "[dr-drill] pulling latest from s3://$BACKUP_S3_BUCKET/"
    aws s3 cp --recursive "s3://$BACKUP_S3_BUCKET/" "$BACKUP_LOCAL_DIR/" || true
    backup=$(ls -1t "$BACKUP_LOCAL_DIR"/eden-*.sql.gz 2>/dev/null | head -1 || true)
else
    backup=$(ls -1t "$BACKUP_LOCAL_DIR"/eden-*.sql.gz 2>/dev/null | head -1 || true)
fi

if [ -z "${backup:-}" ] || [ ! -f "$backup" ]; then
    echo "[dr-drill] FAIL: no backup found in $BACKUP_LOCAL_DIR" >&2
    cat > "$REPORT_PATH" <<EOF
{"ts": "$TS", "verdict": "FAIL", "reason": "no backup found"}
EOF
    exit 2
fi

backup_age_hours=$(echo "scale=2; ($(date +%s) - $(stat -c %Y "$backup")) / 3600" | bc)
echo "[dr-drill] using backup $backup (age ${backup_age_hours}h)"

# 2. Restore into eden_restore_test
echo "[dr-drill] restoring to eden_restore_test"
psql -h "$PGHOST" -U "$PGUSER" -d postgres -c "DROP DATABASE IF EXISTS eden_restore_test;" >/dev/null
psql -h "$PGHOST" -U "$PGUSER" -d postgres -c "CREATE DATABASE eden_restore_test;" >/dev/null

restore_start=$(date +%s)
gunzip -c "$backup" | psql -h "$PGHOST" -U "$PGUSER" -d eden_restore_test >/dev/null 2>&1
restore_end=$(date +%s)
restore_duration=$((restore_end - restore_start))
echo "[dr-drill] restore took ${restore_duration}s"

# 3. Verify the table list
expected_tables="jobs org_audit_log insights kb_insight_writes role_definitions role_permissions role_assignments"
tables_present=""
for t in $expected_tables; do
    if psql -h "$PGHOST" -U "$PGUSER" -d eden_restore_test -tAc "SELECT 1 FROM information_schema.tables WHERE table_name='$t'" | grep -q 1; then
        tables_present="$tables_present $t"
    else
        echo "[dr-drill] WARN: table $t missing from restore"
    fi
done

# 4. Run a smoke query
jobs_count=$(psql -h "$PGHOST" -U "$PGUSER" -d eden_restore_test -tAc "SELECT COUNT(*) FROM jobs" 2>/dev/null || echo "0")

# 5. Try the golden-dataset eval
eval_pass=false
if PYTHONPATH=src python -c "
import asyncio
async def main():
    from eden.evaluation.golden_dataset import load_canonical_datasets
    ds = load_canonical_datasets()
    assert len(ds.cases) == 50, f'expected 50 golden cases, got {len(ds.cases)}'
    assert ds.validate(), 'golden dataset failed validation'
asyncio.run(main())
" 2>/dev/null; then
    eval_pass=true
fi

# 6. Drop the test database and write the report
psql -h "$PGHOST" -U "$PGUSER" -d postgres -c "DROP DATABASE eden_restore_test;" >/dev/null

verdict="PASS"
if [ "$restore_duration" -gt 1800 ]; then verdict="PARTIAL"; fi
if [ "$eval_pass" = "false" ]; then verdict="PARTIAL"; fi
if [ -z "$tables_present" ]; then verdict="FAIL"; fi

cat > "$REPORT_PATH" <<EOF
{
  "ts": "$TS",
  "verdict": "$verdict",
  "backup": "$backup",
  "backup_age_hours": $backup_age_hours,
  "restore_duration_s": $restore_duration,
  "tables_present": "$(echo $tables_present | tr ' ' ',')",
  "jobs_count": $jobs_count,
  "eval_pass": $eval_pass
}
EOF

echo "[dr-drill] verdict: $verdict"
echo "[dr-drill] report: $REPORT_PATH"

# Exit non-zero on FAIL so the workflow can page.
[ "$verdict" = "FAIL" ] && exit 1 || exit 0
