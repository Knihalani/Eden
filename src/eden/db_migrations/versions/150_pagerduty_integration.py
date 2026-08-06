"""150 — PagerDuty Events API v2 integration tables.

Revision ID: 150_pagerduty_integration
Revises: 149_promotion_candidates_ref_id_text
Create Date: 2026-08-05

FEAT-42: ``_dispatch_pagerduty`` in ``eden.realtime.alert_stream`` and the
``pagerduty`` branch of ``AnomalyDetector.dispatch_alerts`` were both
no-ops (log-only). This adds the storage this pass's real sender needs:

* ``org_pagerduty_configs`` — one row per org's PagerDuty Events API v2
  routing key. Fernet-encrypted at rest (``routing_key_enc``), same
  pattern as ``org_slack_installs.bot_token_enc``. A org without a row
  here falls back to the single-tenant ``PAGERDUTY_ROUTING_KEY`` env
  var (mirrors the ``slack_bot_token`` fallback in
  ``eden.integrations.slack.store.get_bot_token``).
* ``pagerduty_dlq`` — failed sends (all retry-ladder attempts
  exhausted) land here for on-call visibility / manual replay, mirroring
  ``webhook_dlq``. Not FK'd to a "pagerduty deliveries" table because,
  unlike customer webhooks, PagerDuty sends are triggered synchronously
  out of the in-memory alert dispatch path rather than an outbox table.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "150_pagerduty_integration"
down_revision: str | Sequence[str] | None = "149_promotion_candidates_ref_id_text"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS org_pagerduty_configs (
            id UUID PRIMARY KEY,
            org_id TEXT NOT NULL,
            routing_key_enc TEXT NOT NULL,
            service_name TEXT NOT NULL DEFAULT '',
            active BOOLEAN NOT NULL DEFAULT TRUE,
            created_by_user_id TEXT,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            CONSTRAINT org_pagerduty_configs_org_uq UNIQUE (org_id)
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS org_pagerduty_configs_org_idx "
        "ON org_pagerduty_configs (org_id) WHERE active"
    )

    op.execute(
        """
        CREATE TABLE IF NOT EXISTS pagerduty_dlq (
            id UUID PRIMARY KEY,
            org_id TEXT,
            event_action TEXT NOT NULL DEFAULT 'trigger',
            dedup_key TEXT,
            summary TEXT NOT NULL DEFAULT '',
            payload JSONB NOT NULL,
            error_message TEXT,
            attempt_count INT NOT NULL DEFAULT 0,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS pagerduty_dlq_org_idx "
        "ON pagerduty_dlq (org_id)"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS pagerduty_dlq")
    op.execute("DROP TABLE IF EXISTS org_pagerduty_configs")
