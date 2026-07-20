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


def _fail_closed(policy: PIIPolicy) -> bool:
    return bool(
        policy.fail_closed_on_credentials
        or getattr(policy, "mode", None) == "fail_closed"
    )


def _mask_value_sync(
    masker: PIIMasker,
    value: Any,
    *,
    policy: PIIPolicy,
    fail_open_log: str,
) -> Any:
    """Synchronous mask helper used inside ``to_thread`` workers."""
    try:
        return masker.mask(value)
    except PIIMaskingError:
        raise
    except Exception as exc:
        if _fail_closed(policy):
            raise
        logger.warning(fail_open_log.format(exc=exc))
        return value


def _mask_list_sync(
    items: list[Any],
    *,
    masker: PIIMasker,
    policy: PIIPolicy,
) -> list[Any]:
    """Mask a list in one thread (avoids N sequential ``to_thread`` awaits)."""
    out: list[Any] = []
    for item in items:
        if item is None:
            out.append(item)
        elif isinstance(item, list):
            out.append(_mask_list_sync(item, masker=masker, policy=policy))
        elif isinstance(item, (str, dict)):
            out.append(
                _mask_value_sync(
                    masker,
                    item,
                    policy=policy,
                    fail_open_log=(
                        "PII pre-mask failed on list item; "
                        "persisting unmasked: {exc}"
                    ),
                )
            )
        else:
            out.append(item)
    return out


def _mask_attributes_sync(
    attributes: dict[str, Any],
    *,
    masker: PIIMasker,
) -> dict[str, Any]:
    """Mask all string attribute values in one thread hop."""
    out: dict[str, Any] = {}
    for key, value in attributes.items():
        if not isinstance(value, str):
            out[key] = value
            continue
        try:
            masked = masker.mask(value)
            out[key] = masked if isinstance(masked, str) else str(masked)
        except PIIMaskingError:
            raise
        except Exception as exc:
            logger.debug(f"attribute {key} PII mask failed: {exc}")
            out[key] = value
    return out


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
    masker = PIIMasker(policy=policy)

    if isinstance(payload, list):
        return await asyncio.to_thread(
            _mask_list_sync, payload, masker=masker, policy=policy
        )
    if isinstance(payload, (str, dict)):
        return await asyncio.to_thread(
            _mask_value_sync,
            masker,
            payload,
            policy=policy,
            fail_open_log=(
                "PII pre-mask failed; persisting unmasked: {exc}"
                if isinstance(payload, dict)
                else "PII pre-mask failed on string; persisting unmasked: {exc}"
            ),
        )
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
    return await asyncio.to_thread(
        _mask_attributes_sync, attributes, masker=masker
    )
