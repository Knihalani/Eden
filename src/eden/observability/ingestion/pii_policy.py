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
from collections import OrderedDict

from eden.data_platform.pii import PIIPolicy

logger = logging.getLogger(__name__)

# TTL: 60 seconds. Policy changes take at most a minute to
# propagate to all ingest workers. Adjust per operational experience.
_POLICY_CACHE_TTL_SECONDS = 60.0

# F64 — ``_cache`` is now an ``OrderedDict`` keyed by
# ``tenant_id`` with a hard cap and a TTL eviction sweep.
# Pre-F64 the dict grew unbounded against unique-tenant
# traffic: every distinct ``tenant_id`` that ever had a
# policy lookup added an entry, and the only way to drop
# it was the explicit ``invalidate_policy`` call. A
# long-running pod would accumulate one stale entry per
# tenant who ever sent a single event.
#
# * ``_POLICY_CACHE_MAX_ENTRIES`` — hard cap on the
#   number of tenant entries. Sized for healthy
#   multi-tenant traffic; a busy multi-tenant API
#   process sees < 100 entries. Once exceeded, the
#   least-recently-touched tenant is dropped.
# * ``_evict_expired_pii_policies`` — sweep helper
#   that drops entries past their TTL.
# * ``_touch_pii_policy`` — LRU bump on every cache
#   hit so active tenants survive eviction.
_POLICY_CACHE_MAX_ENTRIES: int = 4096
_cache: OrderedDict[str, tuple[float, PIIPolicy]] = OrderedDict()
_cache_lock = asyncio.Lock()


def _touch_pii_policy(tenant_id: str) -> None:
    """Bump the LRU position for a tenant's PII policy.

    Best-effort: any exception inside the OrderedDict
    rewrite is silently dropped so a transient bookkeeping
    issue cannot break a paying customer's API call.
    Mirrors ``gateway._upstream_client_cache.move_to_end``
    (F62) and ``ingestion._touch_bucket`` (F63)."""
    try:
        if tenant_id in _cache:
            _cache.move_to_end(tenant_id)
    except Exception:
        pass


def _evict_expired_pii_policies(now: float) -> None:
    """Drop ``_cache`` entries whose TTL has elapsed.

    Pre-F64 nothing reaped expired entries — a tenant
    who called once and never came back still pinned a
    key in the dict for the pod's lifetime. F64 walks
    the dict opportunistically and drops expired entries.
    """
    stale: list[str] = []
    for tenant_id, (expires_at, _policy) in _cache.items():
        if now >= expires_at:
            stale.append(tenant_id)
    for tenant_id in stale:
        _cache.pop(tenant_id, None)


def _enforce_pii_policy_cap() -> None:
    """Enforce the hard cap on ``_cache``.

    Drops the least-recently-touched tenant until the
    size is back under the limit. The new tenant
    always succeeds — only older ones are evicted.
    Mirrors ``multi_agent._enforce_cap_on_insert`` (F61)
    and ``ingestion._enforce_rate_buckets_cap`` (F63)."""
    while len(_cache) >= _POLICY_CACHE_MAX_ENTRIES:
        try:
            _cache.popitem(last=False)
        except KeyError:
            break


async def resolve_policy(tenant_id: str) -> PIIPolicy:
    """Return the active PIIPolicy for ``tenant_id``.

    Hits an in-process cache first; on miss, queries Postgres and
    caches the result with a TTL.
    """
    now = time.monotonic()
    # F64: opportunistic housekeeping on the hot path.
    _evict_expired_pii_policies(now)
    _enforce_pii_policy_cap()
    cached = _cache.get(tenant_id)
    if cached is not None:
        expires_at, policy = cached
        if now < expires_at:
            # F64: bump LRU so an active tenant survives a
            # subsequent cap-eviction triggered by a churning
            # one-shot tenant.
            _touch_pii_policy(tenant_id)
            return policy

    async with _cache_lock:
        # Double-checked locking — another task may have populated
        # the cache between our check and the lock acquisition.
        cached = _cache.get(tenant_id)
        if cached is not None:
            expires_at, policy = cached
            if now < expires_at:
                _touch_pii_policy(tenant_id)
                return policy
        policy = await _load_policy_from_db(tenant_id)
        _cache[tenant_id] = (now + _POLICY_CACHE_TTL_SECONDS, policy)
        _touch_pii_policy(tenant_id)
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
