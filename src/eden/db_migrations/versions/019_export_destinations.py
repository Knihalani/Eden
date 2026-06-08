"""019_export_destinations — Phase 8 export management.

Revision ID: 019
Revises: 016
Create Date: 2026-06-08

Adds the two tables that back the new Exports settings tab:

  - ``export_destinations`` — where exports land (S3 or GCS bucket),
    with the secret credentials encrypted at rest via Fernet
    (``config_encrypted`` is a Fernet ciphertext of the JSON blob
    the operator pasted in the UI).
  - ``export_schedules``    — one-shot or recurring schedules that
    trigger an export of a single data type (catalog: traces,
    judge_scores, audit_log, usage_events, insights,
    telemetry_events) in a chosen format (CSV, Parquet, JSONL)
    to a destination, on a cron expression (or NULL for one-shot).

Schedule evaluation is not part of this migration — the API
exposes ``POST /export/run-now`` to trigger a single schedule
out-of-band, and a future worker will pick up cron-eligible
schedules via ``last_run_at`` polling.
"""

from alembic import op

revision = "019"
down_revision = "016"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── export_destinations ───────────────────────────────────────
    # A destination belongs to exactly one org. The
    # ``config_encrypted`` column holds a Fernet-encrypted JSON
    # blob with the bucket name, region, and secret credentials
    # for the chosen cloud (S3 or GCS). Plaintext secrets must
    # never be persisted.
    op.execute("""
        CREATE TABLE IF NOT EXISTS export_destinations (
            destination_id    UUID PRIMARY KEY,
            org_id            VARCHAR(128) NOT NULL,
            name              VARCHAR(128) NOT NULL,
            type              VARCHAR(16) NOT NULL,
            config_encrypted  TEXT NOT NULL,
            created_by        VARCHAR(128),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            UNIQUE (org_id, name),
            CHECK (type IN ('s3', 'gcs'))
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_destinations_org
        ON export_destinations (org_id, created_at DESC)
    """)

    # ── export_schedules ──────────────────────────────────────────
    # ``destination_id`` may be NULL to indicate a one-shot
    # "download" schedule (the run-now endpoint streams the
    # bytes back to the caller instead of pushing to a bucket).
    # ``cron_expression`` is NULL for one-shot schedules; for
    # recurring schedules the API stores a standard 5-field cron
    # string ("m h dom mon dow") validated at write time.
    op.execute("""
        CREATE TABLE IF NOT EXISTS export_schedules (
            schedule_id       UUID PRIMARY KEY,
            org_id            VARCHAR(128) NOT NULL,
            destination_id    UUID,
            data_type         VARCHAR(64) NOT NULL,
            format            VARCHAR(16) NOT NULL,
            cron_expression   VARCHAR(64),
            last_run_at       TIMESTAMPTZ,
            next_run_at       TIMESTAMPTZ,
            created_by        VARCHAR(128),
            created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CHECK (format IN ('csv', 'parquet', 'jsonl')),
            CHECK (data_type IN (
                'traces', 'judge_scores', 'audit_log',
                'usage_events', 'insights', 'telemetry_events'
            ))
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_schedules_org
        ON export_schedules (org_id, created_at DESC)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_schedules_destination
        ON export_schedules (destination_id)
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_export_schedules_next_run
        ON export_schedules (next_run_at)
        WHERE cron_expression IS NOT NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_export_schedules_next_run")
    op.execute("DROP INDEX IF EXISTS idx_export_schedules_destination")
    op.execute("DROP INDEX IF EXISTS idx_export_schedules_org")
    op.execute("DROP TABLE IF EXISTS export_schedules")
    op.execute("DROP INDEX IF EXISTS idx_export_destinations_org")
    op.execute("DROP TABLE IF EXISTS export_destinations")
