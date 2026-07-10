"""084 — agent stumbles + agent issues (F28 / F29).

Revision ID: 084
Revises: 083
Create Date: 2026-07-10

Introduces the "issues" data layer that the closed-loop error-diagnosis
system is built on:

* ``agent_stumbles`` — one atomic per-trace failure record (F28). Deduped
  on ``(org_id, trace_id, kind, fingerprint)`` so a re-scan of the same
  trace updates ``detail`` instead of inserting a duplicate.
* ``agent_issues`` — grouped, Sentry-style issue keyed by
  ``(org_id, fingerprint)`` (F29). A new matching stumble bumps
  ``stumble_count`` / ``last_seen`` rather than creating a new issue.

Conventions match the existing intelligence-gap tables (migration 020):
``org_id VARCHAR(128)`` (no cross-schema FK), app-friendly
``gen_random_uuid()`` PKs, and per-access-pattern btree indexes.

``kind`` and ``status`` are plain ``VARCHAR`` (not Postgres enums) so the
F28↔F29 kind reconciliation and the F46 status extension
(``triaged``/``fix_pending``/``verifying``/``learning``) never require an
``ALTER TYPE`` migration.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "084"
down_revision: str | Sequence[str] | None = "083"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ── agent_stumbles ──────────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_stumbles (
            id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id        VARCHAR(128) NOT NULL,
            trace_id      VARCHAR(128) NOT NULL,
            session_id    VARCHAR(128),
            user_id       VARCHAR(256),
            agent_id      VARCHAR(256),
            span_id       VARCHAR(128),
            kind          VARCHAR(32) NOT NULL,
            fingerprint   VARCHAR(64) NOT NULL,
            title         TEXT NOT NULL,
            detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
            severity      VARCHAR(4) NOT NULL
                          CHECK (severity IN ('p0','p1','p2','p3')),
            detected_by   VARCHAR(64) NOT NULL,
            detected_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_agent_stumbles_dedup
                UNIQUE (org_id, trace_id, kind, fingerprint)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_fingerprint "
        "ON agent_stumbles (org_id, fingerprint, detected_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_trace "
        "ON agent_stumbles (org_id, trace_id, detected_at DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_stumbles_agent "
        "ON agent_stumbles (org_id, agent_id, kind, detected_at DESC)"
    )

    # ── agent_issues ────────────────────────────────────────────────
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS agent_issues (
            id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id              VARCHAR(128) NOT NULL,
            fingerprint         VARCHAR(64) NOT NULL,
            kind                VARCHAR(32) NOT NULL,
            title               TEXT NOT NULL,
            status              VARCHAR(16) NOT NULL DEFAULT 'open'
                                CHECK (status IN (
                                    'open','triaged','fix_pending','verifying',
                                    'resolved','regressed','ignored','learning'
                                )),
            severity            VARCHAR(4) NOT NULL
                                CHECK (severity IN ('p0','p1','p2','p3')),
            agent_id            VARCHAR(256),
            first_seen          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            last_seen           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            stumble_count       INTEGER NOT NULL DEFAULT 1,
            user_count          INTEGER NOT NULL DEFAULT 1,
            repetition_count    INTEGER NOT NULL DEFAULT 1,
            affected_user_ids   TEXT[] NOT NULL DEFAULT '{}',
            example_stumble_ids UUID[] NOT NULL DEFAULT '{}',
            triage_result       JSONB,
            assignee            VARCHAR(256),
            experiment_id       UUID,
            resolved_at         TIMESTAMPTZ,
            created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT uq_agent_issues_fingerprint
                UNIQUE (org_id, fingerprint)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_issues_org_status "
        "ON agent_issues (org_id, status, severity, last_seen DESC)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_issues_fingerprint "
        "ON agent_issues (org_id, fingerprint, last_seen DESC)"
    )
    # "repeat incident" surface (Wave 7 badge).
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_agent_issues_repetition "
        "ON agent_issues (org_id, status) WHERE repetition_count > 1"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS agent_issues CASCADE")
    op.execute("DROP TABLE IF EXISTS agent_stumbles CASCADE")
