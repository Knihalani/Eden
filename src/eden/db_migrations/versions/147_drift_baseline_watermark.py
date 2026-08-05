"""147 — watermark table for drift_baseline_worker's org/agent-pair selection (OPT-8).

Revision ID: 147_drift_baseline_watermark
Revises: 146_classifier_retrain_watermark
Create Date: 2026-08-05

``DriftBaselineWorker.run_once`` selected its weekly batch of
(org_id, agent_id) pairs with::

    SELECT DISTINCT org_id, agent_id
    FROM agent_issues
    WHERE last_seen >= now() - interval '7 days'
    LIMIT $1

No ``ORDER BY``, no watermark — the same missing-watermark defect class
OPT-3 (144_auto_curator_watermark) fixed for ``auto_curator``. The
7-day activity floor narrows blast radius somewhat, but the same
stable-but-arbitrary ``LIMIT`` subset of pairs can still win every tick
forever while everything past it starves silently.

This table is the durable "when did we last refresh this (org, agent)
pair's drift baselines" watermark, using the composite call contract
``eden.storage.watermark.fetch_stale_candidates`` / ``advance_watermark``
gained this wave (see 146_classifier_retrain_watermark for the sibling
OPT-7 fix using the identical idiom).

Unlike ``signal_events`` (OPT-7's source table), ``agent_issues.org_id``
is ``VARCHAR(128)`` and ``agent_issues.agent_id`` is ``VARCHAR(256)``
(see 084_agent_issues — deliberately *not* FK'd to
``organizations.id``, "app-friendly"), so neither is guaranteed to be
valid UUID text. This table's composite primary key therefore matches
``agent_issues``'s actual ``VARCHAR`` types rather than casting to
``UUID``; the caller passes ``id_cast=None`` to
``advance_watermark`` so the upsert binds the pair's raw string values
with no cast (see ``eden.insights.drift_baseline_worker``).
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "147_drift_baseline_watermark"
down_revision: str | Sequence[str] | None = "146_classifier_retrain_watermark"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS drift_baseline_watermark (
            org_id VARCHAR(128) NOT NULL,
            agent_id VARCHAR(256) NOT NULL,
            last_processed_at TIMESTAMPTZ,
            PRIMARY KEY (org_id, agent_id)
        )
        """
    )
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS drift_baseline_watermark_last_processed_idx
        ON drift_baseline_watermark (last_processed_at)
        """
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS drift_baseline_watermark_last_processed_idx")
    op.execute("DROP TABLE IF EXISTS drift_baseline_watermark")
