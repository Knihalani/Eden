"""146 — watermark table for classifier_retrain's org/signal-pair selection (OPT-7).

Revision ID: 146_classifier_retrain_watermark
Revises: 142_session_summaries
Create Date: 2026-08-05

``ClassifierTrainingPipeline.retrain_due_orgs`` (run from
``cron_tick._run_classifier_retrain`` every 15 minutes — 96 ticks/day,
the highest tick frequency among this class of bugs) selected its batch
of (org_id, signal_id) pairs with
``SELECT DISTINCT org_id::text, signal_id::text FROM signal_events
WHERE detected_at > NOW() - INTERVAL '7 days' LIMIT 50`` — no
``ORDER BY``, no watermark. Postgres has no obligation to vary that
plan's output, and in practice doesn't, so the same 50 pairs could win
every single tick forever while every other pair silently starved. It
never raised, so nothing paged on it.

This table is the durable "when did we last retrain this (org, signal)
pair" watermark that ``eden.storage.watermark.fetch_stale_candidates`` /
``advance_watermark`` left-join / upsert against — the same idiom
``auto_curator_watermark`` (144) already uses for auto_curator's
single-key ``org_id`` selection, generalized this wave to accept a
*sequence* of columns for a genuine composite join/upsert key (see
``eden.storage.watermark`` for the generalized call contract) rather
than faking a composite key with a single hashed column. ``org_id`` and
``signal_id`` are both native ``UUID`` on ``signal_events`` (see
092_market_ready_consolidated), so a real ``(org_id, signal_id) UUID``
composite primary key matches the source data's actual types with no
cast risk.

Sibling fix in the same wave: 147_drift_baseline_watermark (OPT-8),
which needs the identical composite-key accommodation for
``drift_baseline_worker``'s own ``(org_id, agent_id)`` pair — but keyed
on ``VARCHAR`` rather than ``UUID`` columns, since its source table
(``agent_issues``) isn't UUID-typed. See that migration's docstring.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "146_classifier_retrain_watermark"
down_revision: str | Sequence[str] | None = "142_session_summaries"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS classifier_retrain_watermark (
            org_id UUID NOT NULL,
            signal_id UUID NOT NULL,
            last_processed_at TIMESTAMPTZ,
            PRIMARY KEY (org_id, signal_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS classifier_retrain_watermark_last_processed_idx
        ON classifier_retrain_watermark (last_processed_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS classifier_retrain_watermark_last_processed_idx")
    op.execute("DROP TABLE IF EXISTS classifier_retrain_watermark")
