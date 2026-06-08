"""013_org_pii_policies — Phase 7.3a per-tenant PII policy override.

Revision ID: 013
Revises: 012
Create Date: 2026-06-05

Adds per-tenant control over the PII filter that runs on every
inbound telemetry event. The hard-coded category list in
``PIIMasker`` becomes the *default* policy; tenants can override
via this table to:

  - Disable specific categories (e.g. allow URLs with credentials
    if the customer runs an internal-secret-management flow that
    already encodes them safely).
  - Enable fail-closed mode for credential-like categories
    (jwt, api_key, password_field, url_with_creds). With
    fail-closed, a detected credential in the payload causes
    the whole event to be rejected with 422 instead of redacted.
  - Add extra redact keys for tenant-specific secrets
    (internal service names, custom credential headers).

The policy is time-effective: we keep history so a customer can
audit when a policy was active.
"""

from alembic import op

revision = "013"
down_revision = "012"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("""
        CREATE TABLE IF NOT EXISTS org_pii_policies (
            policy_id              UUID PRIMARY KEY,
            tenant_id              VARCHAR(128) NOT NULL,
            enabled_categories     TEXT[] NOT NULL DEFAULT '{email,phone,ssn,credit_card,ipv4,ipv6,jwt,api_key,url_with_creds,password_field}',
            disabled_categories    TEXT[] NOT NULL DEFAULT '{}',
            fail_closed_on_credentials BOOLEAN NOT NULL DEFAULT FALSE,
            redact_keys_extra      TEXT[] NOT NULL DEFAULT '{}',
            created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_from         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            effective_until        TIMESTAMPTZ,
            created_by             VARCHAR(128),
            notes                  TEXT,
            UNIQUE (tenant_id, effective_from)
        )
    """)
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pii_policy_lookup
        ON org_pii_policies (tenant_id, effective_from DESC)
    """)
    # A partial index: most policies are unbounded. We index rows
    # that have a non-NULL effective_until so listing "active"
    # policies is cheap.
    op.execute("""
        CREATE INDEX IF NOT EXISTS idx_pii_policy_effective
        ON org_pii_policies (tenant_id)
        WHERE effective_until IS NULL
    """)


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_pii_policy_effective")
    op.execute("DROP INDEX IF EXISTS idx_pii_policy_lookup")
    op.execute("DROP TABLE IF EXISTS org_pii_policies")
