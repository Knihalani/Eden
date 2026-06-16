# Disaster Recovery Drill

> **Owner:** DevOps · **Cadence:** quarterly · **Driven by:**
> `.github/workflows/dr-drill.yml` + `scripts/dr_drill.sh`
>
> Closes §9.1.4 of the roadmap.

## Goal

Prove that we can restore Eden production data from a recent
backup, with no human intervention, in under 60 minutes.

## Pre-requisites

- Access to a staging environment that mirrors production
  (the `docker/docker-compose.yml` + the `streaming` / `grpc` /
  `edge` profiles).
- A backup in `${BACKUP_S3_BUCKET}` or local
  `${BACKUP_LOCAL_DIR}/eden-{date}.sql.gz` that is less than 24h old.
- The `eden_restore_test` database does NOT exist (we'll create it).

## Drill steps

1. **Snapshot the current state.** `pg_dump` the production
   database to `${BACKUP_LOCAL_DIR}/pre-drill-{ts}.sql.gz`. This
   is the "before" state we can diff against later.

2. **Drop a test schema in production** to simulate a disaster
   (in staging only — never do this in real production):
   ```bash
   psql -h $PGHOST -U $PGUSER -d eden -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
   ```

3. **Run the restore script:**
   ```bash
   ./scripts/dr_drill.sh
   ```
   The script:
   - Downloads the latest `eden-*.sql.gz` from S3
   - Restores into the `eden_restore_test` database (NOT production)
   - Runs `psql -c "SELECT COUNT(*) FROM jobs;"` to verify
   - Runs the golden-dataset eval against the restored DB to
     confirm the test environment is healthy
   - Writes a report to `reports/dr-drill-{ts}.json`

4. **Verify the report.** The JSON contains:
   - `backup_age_hours` — how old the backup was
   - `restore_duration_s` — wall-clock time for the restore
   - `tables_present` — list of expected tables found
   - `eval_pass` — whether the golden-dataset eval ran clean

5. **Tear down the test DB.** The script drops
   `eden_restore_test` at the end so the next drill starts clean.

## Success criteria

| Metric | Target | Action if missed |
|--------|--------|------------------|
| `restore_duration_s` | < 1800s (30 min) | Investigate; bump IOPS on restore volume |
| `eval_pass` | true | Open a Sev2 incident; the restore is partial |
| `tables_present` | all 18 migrations accounted for | Migration gap; backfill before continuing |
| `backup_age_hours` | < 24h | Backup schedule broken; fix before next drill |

## Failure mode: backup is corrupt

1. Pull an older backup (we retain 30 days).
2. Run the same restore drill against the older backup.
3. If the older one is also corrupt, the issue is upstream
   (Postgres WAL archiving, S3 lifecycle policy). Open a Sev1.

## After the drill

- File a 1-pager in `reports/dr-drill-{ts}.md` summarizing:
  did the drill hit its SLO? what was the slowest step?
  what should we change before next quarter?
- Update the §9.1.4 row in the roadmap (mark ✅ if passed, ⚠ with
  notes if degraded).
