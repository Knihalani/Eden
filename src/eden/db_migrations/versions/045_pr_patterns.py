"""045 — PR patterns (Cat 23 real implementation, June 2026).

Revision ID: 045
Revises: 044
Create Date: 2026-06-20

Adds the ``pr_patterns`` table for :class:`eden.code_change.pr_patterns.
PRPatternService`. The service mines the last N merged PRs via the
:class:`RepoProvider` and extracts (via a T1 model call) the
repo's PR conventions:

* title format (``[Eden Agent] Fix: ...`` / ``fix(scope): ...`` / freeform)
* body template (4-paragraph vs 1-paragraph vs bullet list)
* common labels (``eden-agent``, ``auto-revertable``, ``needs-review``)
* common reviewers (the CODEOWNERS + per-PR reviewer pattern)
* common branch naming (``eden/auto-fix-<trace>`` / ``fix/...``)

The PatchGenerator + PRCreator read this table before opening a
PR to match the repo's house style. Without this table, the agent
generates patches that don't match the team's conventions and
get rejected in review.
"""

from __future__ import annotations

from alembic import op

revision = "045"
down_revision = "044"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pr_patterns (
            id                          VARCHAR(64) PRIMARY KEY,
            org_id                      VARCHAR(128) NOT NULL,
            repo_id                     VARCHAR(64) NOT NULL,
            title_format                VARCHAR(128) NOT NULL DEFAULT '',
            body_template               TEXT NOT NULL DEFAULT '',
            common_labels               JSONB NOT NULL DEFAULT '[]',
            common_reviewers            JSONB NOT NULL DEFAULT '[]',
            common_branch_prefix        VARCHAR(64) NOT NULL DEFAULT 'eden/auto-fix',
            sample_size                 INT NOT NULL DEFAULT 50,
            sample_window_days          INT NOT NULL DEFAULT 90,
            last_mined_at               TIMESTAMPTZ,
            last_mined_from_pr_id       VARCHAR(64),
            last_mined_from_pr_number   INT,
            created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_pr_patterns_pk "
        "ON pr_patterns (org_id, repo_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_pr_patterns_mined "
        "ON pr_patterns (org_id, last_mined_at DESC)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pr_patterns_mined")
    op.execute("DROP INDEX IF EXISTS idx_pr_patterns_pk")
    op.execute("DROP TABLE IF EXISTS pr_patterns")
