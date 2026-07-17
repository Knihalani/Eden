"""PII pre-mask wrapper for the ingest edge (Phase 7.3a — per-tenant policy).

The ingestion layer masks ``payload`` and ``attributes`` on every event
*before* the row is written to Postgres. The masker is the existing
``eden.data_platform.pii.PIIMasker`` (synchronous). We wrap it in
``asyncio.to_thread`` so it doesn't block the event loop on large
batches.

Per-tenant policy: the masker is constructed with a ``PIIPolicy``
resolved from the ``org_pii_policies`` table (cached 60s in-process).
This lets tenants:

- Disable specific categories (e.g. allow URLs with credentials
  if they run an internal-secret-management flow)
- Enable fail-closed mode for credential-like categories (jwt,
  api_key, password_field, url_with_creds). When enabled, a
  detected credential causes the masker to raise ``PIIMaskingError``;
  the ingest handler maps that to a 422.

Failure policy is fail-closed for unexpected masker errors when the
tenant policy sets ``fail_closed_on_credentials`` (Wave 1). Otherwise
unexpected exceptions remain fail-open with a warning log so soft
telemetry paths do not drop events. ``PIIMaskingError`` always
propagates so ingest handlers can return 422.
"""

from __future__ import annotations

import asyncio
import logging
from typing import Any

from eden.data_platform.pii import PIIMasker, PIIMaskingError, PIIPolicy
from eden.observability.ingestion.pii_policy import resolve_policy

logger = logging.getLogger(__name__)


async def mask_payload(
    payload: Any,
    *,
    tenant_id: str | None = None,
) -> Any:
    """Run PIIMasker on a payload dict/list/scalar in a worker thread.

    ``PIIMaskingError`` always propagates. Unexpected exceptions
    propagate when the tenant policy is fail-closed; otherwise the
    original value is returned (fail-open) with a warning.
    """
    if payload is None:
        return payload
    policy = (
        await resolve_policy(tenant_id)
        if tenant_id is not None
        else PIIPolicy()
    )

    if isinstance(payload, str):
        masker = PIIMasker(policy=policy)
        try:
            return await asyncio.to_thread(masker.mask, payload)
        except PIIMaskingError:
            raise
        except Exception as exc:
            if policy.fail_closed_on_credentials or getattr(policy, "mode", None) == "fail_closed":
                raise
            logger.warning(f"PII pre-mask failed on string; persisting unmasked: {exc}")
            return payload
    if isinstance(payload, list):
        return [await mask_payload(item, tenant_id=tenant_id) for item in payload]
    if isinstance(payload, dict):
        masker = PIIMasker(policy=policy)
        try:
            return await asyncio.to_thread(masker.mask, payload)
        except PIIMaskingError:
            raise
        except Exception as exc:
            if policy.fail_closed_on_credentials or getattr(policy, "mode", None) == "fail_closed":
                raise
            logger.warning(f"PII pre-mask failed; persisting unmasked: {exc}")
            return payload
    return payload


async def mask_attributes(
    attributes: dict[str, str],
    *,
    tenant_id: str | None = None,
) -> dict[str, str]:
    """Mask string values inside an ``attributes`` dict. Each value is
    masked independently. Keys are not masked (they're schema names).

    Returns a new dict; the input is not mutated.
    """
    if not attributes:
        return attributes
    policy = (
        await resolve_policy(tenant_id)
        if tenant_id is not None
        else PIIPolicy()
    )
    masker = PIIMasker(policy=policy)

    out: dict[str, str] = {}
    for key, value in attributes.items():
        if not isinstance(value, str):
            out[key] = value
            continue
        try:
            masked = await asyncio.to_thread(masker.mask, value)
            out[key] = masked if isinstance(masked, str) else str(masked)
        except PIIMaskingError:
            raise
        except Exception as exc:
            logger.debug(f"attribute {key} PII mask failed: {exc}")
            out[key] = value
    return out
