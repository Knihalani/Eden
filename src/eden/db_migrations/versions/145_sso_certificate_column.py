"""145 — add sso_configurations.certificate for SAML signature verification (FEAT-1).

Revision ID: 145_sso_certificate_column
Revises: 144_auto_curator_watermark
Create Date: 2026-08-05

``sso_callback`` previously discarded every incoming ``code``/
``saml_response`` and unconditionally raised 503 "sso_not_enabled" — the
IdP token/assertion exchange was never wired up. Wiring up SAML
requires a place to store each tenant's IdP signing certificate (the
X.509 cert used to verify the ``<ds:Signature>`` on a SAML assertion —
see ``_validate_saml_assertion`` in ``eden/api/routes/sso.py``).

This is public key material (not a shared secret): unlike
``client_secret`` (encrypted at rest via
``eden.api.utils.encryption.encrypt_value``, the existing tenant-secret
broker pattern already used for Slack/export-destination tokens), a
signing certificate needs no confidentiality protection — only
integrity, which the column already gets from being inside the same
row/table as everything else guarded by ``require_org_admin``. Stored
as PEM (or bare base64, normalized on read — see
``_normalize_pem_certificate``) plaintext ``TEXT``.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "145_sso_certificate_column"
down_revision: str | Sequence[str] | None = "144_auto_curator_watermark"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE sso_configurations
        ADD COLUMN IF NOT EXISTS certificate TEXT
        """
    )


def downgrade() -> None:
    op.execute(
        """
        ALTER TABLE sso_configurations
        DROP COLUMN IF EXISTS certificate
        """
    )
