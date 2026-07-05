"""053_webhook_dlq — D.13 webhook reliability schema per upgradespec §D.13 / §B.11.

Revision ID: 053
Revises: 052
Create Date: 2026-06-24

The webhook reliability surface already has ``webhooks`` +
``webhook_deliveries`` (migration 006). This migration adds
the DLQ table that the spec calls out:

* ``webhook_dlq`` — terminal-state deliveries that
  exceeded the retry budget. The portal renders this as
  the DLQ + replay UI per §D.13.

Also adds the spec's signing-format column expected by
external consumers (``X-Eden-Signature: t=<ts>,v1=<sig>``).
The existing service writes a single
``X-Webhook-Signature: sha256=<hex>`` header; we keep that
for backward compat and add a ``signature_v1`` column
holding the new format.

Conventions (per the v1.4 cat-ship pattern, mirrors
:file:`052_budgets.py`):
* Tables include ``org_id VARCHAR(128) NOT NULL`` and
  ``created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()``.
* Every table gets an ``idx_<name>_org (org_id, created_at DESC)``
  index for the per-org time-series access pattern.

Backoff schedule (per spec §D.13): 1s, 5s, 25s, 2m, 10m,
1h, then DLQ. The existing ``_RETRY_DELAYS`` constant in
``webhook_delivery.py`` is ``[0, 5, 15, 30, 60, 120, 300,
600, 1800, 3600]`` — 10 attempts. We update it to match
the spec's exact 7-step ladder in a follow-up commit.
"""

from __future__ import annotations

from alembic import op

revision = "053"
down_revision = "052"
branch_labels = None
depends_on = None


def _table(name: str, body: str, extra_index: str = "") -> None:
    op.execute(f"CREATE TABLE IF NOT EXISTS {name} ({body})")
    op.execute(
        f"CREATE INDEX IF NOT EXISTS idx_{name}_org "
        f"ON {name} (org_id, created_at DESC)"
    )
    if extra_index:
        op.execute(extra_index)


def upgrade() -> None:
    # ── 1. webhook_dlq — terminal-state deliveries ────────────────
    _table(
        "webhook_dlq",
        """
        id                UUID PRIMARY KEY,
        org_id            VARCHAR(128) NOT NULL,
        webhook_id        VARCHAR(64) NOT NULL,
        event_type        VARCHAR(64) NOT NULL,
        payload           TEXT NOT NULL,
        last_response_status INT,
        last_error        TEXT,
        attempt_count     INT NOT NULL,
        max_attempts      INT NOT NULL,
        first_attempt_at  TIMESTAMPTZ,
        last_attempt_at   TIMESTAMPTZ,
        replay_count      INT NOT NULL DEFAULT 0,
        last_replayed_at  TIMESTAMPTZ,
        signature_v1      TEXT,
        created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
        """,
        "CREATE INDEX IF NOT EXISTS idx_webhook_dlq_webhook "
        "ON webhook_dlq (org_id, webhook_id, created_at DESC)",
    )

    # ── 2. signature_v1 column on webhook_deliveries ──────────────
    # (Idempotent: ALTER TABLE ... ADD COLUMN IF NOT EXISTS)
    op.execute(
        "ALTER TABLE webhook_deliveries "
        "ADD COLUMN IF NOT EXISTS signature_v1 TEXT"
    )

    # ── 3. webhook_endpoints view (per spec naming) ───────────────
    # The existing ``webhooks`` table holds the same data the
    # spec names ``webhook_endpoints``. We create a view so
    # the spec-aligned API + portal work without forcing a
    # rename of the underlying table.
    op.execute(
        """
        CREATE OR REPLACE VIEW webhook_endpoints AS
        SELECT id, org_id::text AS org_id_text, url, events,
               active, created_at, updated_at
          FROM webhooks
        """
    )


def downgrade() -> None:
    op.execute("DROP VIEW IF EXISTS webhook_endpoints")
    op.execute("DROP TABLE IF EXISTS webhook_dlq")
