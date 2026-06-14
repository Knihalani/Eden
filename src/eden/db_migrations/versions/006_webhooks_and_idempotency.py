"""Add webhooks and idempotency tables.

Revision ID: 006
Revises: 005
Create Date: 2026-05-30 00:00:00.000000

"""
from collections.abc import Sequence

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "006"
down_revision: str | None = "005"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # ========================================================================
    # Webhooks
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS webhooks (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
            url TEXT NOT NULL,
            description TEXT,
            events TEXT[] NOT NULL DEFAULT '{}',
            secret TEXT NOT NULL,
            active BOOLEAN DEFAULT TRUE,
            created_by UUID NOT NULL REFERENCES users(id),
            created_at TIMESTAMPTZ DEFAULT NOW(),
            updated_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhooks_org ON webhooks (org_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhooks_active ON webhooks (org_id, active)")

    # ========================================================================
    # Webhook Deliveries
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            webhook_id UUID NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
            event_type TEXT NOT NULL,
            payload JSONB NOT NULL,
            status TEXT NOT NULL DEFAULT 'pending',
            response_status INT,
            response_body TEXT,
            error_message TEXT,
            attempt_count INT NOT NULL DEFAULT 0,
            max_attempts INT NOT NULL DEFAULT 10,
            next_attempt_at TIMESTAMPTZ,
            delivered_at TIMESTAMPTZ,
            signature TEXT,
            created_at TIMESTAMPTZ DEFAULT NOW()
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhook_del_webhook ON webhook_deliveries (webhook_id)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhook_del_status ON webhook_deliveries (status)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_webhook_del_next_attempt ON webhook_deliveries (next_attempt_at) WHERE status IN ('pending', 'retrying')")

    # ========================================================================
    # Idempotency Keys
    # ========================================================================
    op.execute("""
        CREATE TABLE IF NOT EXISTS idempotency_keys (
            id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
            key_hash TEXT NOT NULL,
            request_method TEXT NOT NULL,
            request_path TEXT NOT NULL,
            request_body_hash TEXT,
            request_identity TEXT NOT NULL DEFAULT '',
            response_status INT NOT NULL,
            response_body JSONB NOT NULL,
            org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
            user_id UUID REFERENCES users(id) ON DELETE CASCADE,
            expires_at TIMESTAMPTZ NOT NULL,
            created_at TIMESTAMPTZ DEFAULT NOW(),
            UNIQUE (key_hash, request_method, request_path, request_body_hash, request_identity)
        )
    """)
    op.execute("CREATE INDEX IF NOT EXISTS idx_idempotency_key_hash ON idempotency_keys (key_hash)")
    op.execute("CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at)")

    # ========================================================================
    # Auto-update trigger for webhooks
    # ========================================================================
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_trigger
                WHERE tgname = 'webhooks_updated_at'
            ) THEN
                CREATE TRIGGER webhooks_updated_at
                    BEFORE UPDATE ON webhooks
                    FOR EACH ROW
                    EXECUTE FUNCTION update_updated_at();
            END IF;
        END $$;
    """)


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS idempotency_keys CASCADE")
    op.execute("DROP TABLE IF EXISTS webhook_deliveries CASCADE")
    op.execute("DROP TABLE IF EXISTS webhooks CASCADE")
