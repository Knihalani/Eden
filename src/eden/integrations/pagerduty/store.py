"""Per-org PagerDuty Events API v2 routing key storage.

Mirrors ``eden.integrations.slack.store``: one row per org in
``org_pagerduty_configs`` (Fernet-encrypted at rest via
``eden.api.utils.encryption``), with a single-tenant env-var fallback
for dev / orgs that haven't configured their own integration.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

from eden.api.utils.encryption import decrypt_value, encrypt_value

logger = logging.getLogger(__name__)


async def _pg() -> Any | None:
    try:
        from eden.storage.postgres import get_postgres_client

        return await get_postgres_client()
    except Exception as exc:  # noqa: BLE001
        logger.debug("pagerduty_store: postgres unavailable: %s", exc)
        return None


async def upsert_routing_key(
    org_id: str,
    routing_key: str,
    *,
    service_name: str = "",
    created_by_user_id: str | None = None,
) -> bool:
    """Store (or replace) an org's PagerDuty Events API v2 routing key."""
    client = await _pg()
    if client is None:
        return False
    try:
        await client.execute(
            """
            INSERT INTO org_pagerduty_configs
                (id, org_id, routing_key_enc, service_name, active,
                 created_by_user_id)
            VALUES ($1, $2, $3, $4, TRUE, $5)
            ON CONFLICT (org_id) DO UPDATE SET
                routing_key_enc = EXCLUDED.routing_key_enc,
                service_name = EXCLUDED.service_name,
                active = TRUE,
                updated_at = NOW()
            """,
            str(uuid.uuid4()),
            org_id,
            encrypt_value(routing_key),
            service_name,
            created_by_user_id,
        )
        return True
    except Exception as exc:  # noqa: BLE001
        logger.warning("pagerduty_store: upsert_routing_key failed: %s", exc)
        return False


async def get_routing_key(org_id: str | None) -> str | None:
    """Decrypt + return the org's PagerDuty routing key.

    Falls back to the single-tenant ``PAGERDUTY_ROUTING_KEY``
    (``settings.pagerduty_routing_key``) when no per-org row exists —
    the same dev / single-tenant fallback used by
    ``eden.integrations.slack.store.get_bot_token``. Many of the alerts
    that page PagerDuty (sandbox escapes, PII-breach anomalies) are
    Eden-platform incidents rather than a specific customer's, so the
    global fallback is the common path; the per-org row exists for
    orgs that want their own security/data alerts routed to their own
    PagerDuty service.
    """
    if org_id:
        client = await _pg()
        if client is not None:
            try:
                enc = await client.fetchval(
                    """
                    SELECT routing_key_enc FROM org_pagerduty_configs
                    WHERE org_id = $1 AND active
                    LIMIT 1
                    """,
                    org_id,
                )
                if enc:
                    key = decrypt_value(str(enc))
                    if key:
                        return key
            except Exception as exc:  # noqa: BLE001
                logger.debug("pagerduty_store: routing key decrypt failed: %s", exc)

    # Single-tenant / platform-level fallback.
    try:
        from eden.config import get_settings

        fallback = (getattr(get_settings(), "pagerduty_routing_key", "") or "").strip()
        if fallback:
            return fallback
    except Exception:  # noqa: BLE001
        pass
    return None


__all__ = ["get_routing_key", "upsert_routing_key"]
