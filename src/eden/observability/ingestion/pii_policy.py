"""Per-tenant PII policy resolution (Phase 7.3a).

Looks up the active ``org_pii_policies`` row for a tenant and
returns a ``PIIPolicy`` the ingestion layer can use to construct
a per-tenant ``PIIMasker``. Falls back to the default policy when
the tenant has no row.

A small in-process LRU cache keeps recently-resolved policies
hot — the ingest path is on the hot path and a Postgres round
trip per event would dominate latency.
"""

from __future__ import annotations

import asyncio
import logging
import time
from functools import lru_cache
from typing import Any, Optional

from eden.data_platform.pii import PIIPolicy

logger = logging.getLogger(__name__)

# TTL: 60 seconds. Policy changes take at most a minute to
# propagate to all ingest workers. Adjust per operational experience.
_POLICY_CACHE_TTL_SECONDS = 60.0

_cache: dict[str, tuple[float, PIIPolicy]] = {}
_cache_lock = asyncio.Lock()


async def resolve_policy(tenant_id: str) -> PIIPolicy:
    """Return the active PIIPolicy for ``tenant_id``.

    Hits an in-process cache first; on miss, queries Postgres and
    caches the result with a TTL.
    """
    now = time.monotonic()
    cached = _cache.get(tenant_id)
    if cached is not None:
        expires_at, policy = cached
        if now < expires_at:
            return policy

    async with _cache_lock:
        # Double-checked locking — another task may have populated
        # the cache between our check and the lock acquisition.
        cached = _cache.get(tenant_id)
        if cached is not None:
            expires_at, policy = cached
            if now < expires_at:
                return policy
        policy = await _load_policy_from_db(tenant_id)
        _cache[tenant_id] = (now + _POLICY_CACHE_TTL_SECONDS, policy)
        return policy


async def _load_policy_from_db(tenant_id: str) -> PIIPolicy:
    """Query Postgres for the most-recent-effective policy row."""
    try:
        from eden.storage.postgres import get_postgres_client
        client = await get_postgres_client()
        if not client:
            return PIIPolicy()
        row = await client.fetchrow(
            """
            SELECT enabled_categories, disabled_categories,
                   fail_closed_on_credentials, redact_keys_extra
            FROM org_pii_policies
            WHERE tenant_id = $1
              AND effective_from <= NOW()
              AND (effective_until IS NULL OR effective_until > NOW())
            ORDER BY effective_from DESC
            LIMIT 1
            """,
            tenant_id,
        )
        if not row:
            return PIIPolicy()
        return PIIPolicy.from_db_row(dict(row))
    except Exception as exc:
        logger.debug(f"PII policy lookup failed for {tenant_id}: {exc}")
        return PIIPolicy()


def invalidate_policy(tenant_id: str) -> None:
    """Drop a tenant's cached policy. Call this from the
    PII-policy PUT route so changes propagate immediately."""
    _cache.pop(tenant_id, None)
