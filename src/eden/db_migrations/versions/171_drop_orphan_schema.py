"""171 — drop orphan schema (Wave 7.1 hygiene).

Revision ID: 171_drop_orphan_schema
Revises: 170_post_merge_windows
Create Date: 2026-08-11

Wave 7 (7.1): 20 tables were created by the legacy ``migrations/*.sql``
tree (raw SQL, filename order) but no ``src/eden`` code and no portal
code ever reads or writes them — they are schema-only orphans. On
databases built by alembic alone (CI/test) they never existed; on
production (legacy SQL applied first) they exist inert. This revision
drops the 19 confirmed-dead ones so the real posture is visible.

The one exception is ``org_approval_policies`` — investigated first per
the wave plan. Its legacy schema (``migrations/016_specs.sql``) is a
deliberate N22 per-action approval surface (``require_approval`` /
``min_approvers`` / ``required_roles`` / ``auto_approve_threshold`` /
``approval_timeout_hours``) that nothing uses yet. Rather than destroy a
designed surface, it is **kept and reserved** for the N22 approval
feature. Everything else drops.

Verified safe: zero alembic revisions reference any of the 19 tables
(grep over ``src/eden/db_migrations/versions``), zero incoming FKs exist
in the live schema, and the ``sql_schema_guard`` model already treats
the legacy tree's orphan columns as not-live.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "171_drop_orphan_schema"
down_revision: str | Sequence[str] | None = "170_post_merge_windows"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

#: Legacy-schema orphans (Wave 7 audit, re-verified 2026-08-11). Every
#: table has zero non-migration code references. ``org_approval_policies``
#: is intentionally absent — kept as the reserved N22 approval surface.
_ORPHAN_TABLES: tuple[str, ...] = (
    # org/SSO (replaced by org_sso_settings / sso_configurations / org_scim_config)
    "org_sso_providers",
    "org_sso_sessions",
    "org_regions",
    # gateway — circuit breaker was never wired to this table
    "circuit_breaker_state",
    # PR discipline — PR decisions/dedupe never audited to these
    "pr_decision_audit",
    "pr_dedupe_index",
    # retrieval tuner — relevance scores never written
    "retrieval_relevance_scores",
    # env cards — full orphan family
    "env_cards",
    "env_card_versions",
    "env_card_reviews",
    "env_card_ratings",
    "env_card_fork_lineage",
    # builder graphs
    "builder_graphs",
    # insights chat (the shipped chat uses ai_conversations / ai_messages)
    "ai_insights_chat_sessions",
    "ai_insights_chat_messages",
    # interview sessions
    "interview_sessions",
    # specs (spec_templates / spec_approvals / spec_comments)
    "spec_templates",
    "spec_approvals",
    "spec_comments",
)


def upgrade() -> None:
    # IF EXISTS keeps this a no-op on alembic-only databases and correct
    # on legacy-SQL databases. No CASCADE: if anything unexpected FKs to
    # one of these, the migration fails loudly rather than silently
    # dropping a kept table.
    for table in _ORPHAN_TABLES:
        op.execute(f"DROP TABLE IF EXISTS {table}")


def downgrade() -> None:
    # Documented no-op. Recreating 19 legacy tables exactly requires the
    # original ``migrations/*.sql`` DDL, which is retained in git; these
    # tables were dead, so a downgrade re-creating them would restore
    # nothing but inert schema.
    pass
