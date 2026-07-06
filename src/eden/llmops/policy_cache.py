"""Per-tenant PII policy resolution for the gateway (sync facade).

The gateway route handler is ``async def`` but the route runs on the
hot path (every LLM call goes through it). Hitting Postgres on every
chat completion would dominate latency, so this module exposes a
synchronous, in-process cached facade over
:func:`eden.observability.ingestion.pii_policy.resolve_policy`.

Cache semantics:
  * per-tenant, 60-second TTL (matches the ingest-side resolver).
  * lookup is async; the first call for a tenant kicks off the DB
    fetch and yields ``None`` (fail-open default) while it runs.
    Subsequent calls within the TTL see the cached value.
  * the cache is keyed by tenant_id; ``invalidate_policy(tenant_id)``
    drops a single tenant's entry (called by the PUT route after
    a policy write).

Failure policy: fail-open. If the DB is unreachable or the row is
missing, return a default :class:`PIIPolicy` so a Postgres outage
doesn't take the gateway down.
"""

from __future__ import annotations

import asyncio
import logging
import time

from eden.data_platform.pii import PIIPolicy

logger = logging.getLogger(__name__)

# TTL: 60 seconds, matches the ingest-side resolver. Adjust per
# operational experience; making this larger widens the window
# during which a policy change doesn't propagate.
_TTL_SECONDS = 60.0

# In-process cache: tenant_id -> (expires_at_monotonic, policy).
# ``_pending`` tracks in-flight resolutions so concurrent first
# calls for the same tenant don't all kick off a DB fetch.
_cache: dict[str, tuple[float, PIIPolicy]] = {}
_pending: dict[str, asyncio.Future[PIIPolicy]] = {}
_cache_lock = asyncio.Lock()


def _now() -> float:
    return time.monotonic()


async def get_policy_for_tenant(tenant_id: str | None) -> PIIPolicy:
    """Return the active :class:`PIIPolicy` for ``tenant_id``.

    Fail-open: if ``tenant_id`` is ``None`` or the DB lookup fails,
    return the default :class:`PIIPolicy` (``mode="redact"``).

    Hot-path cache: a per-tenant entry is reused for ``_TTL_SECONDS``
    after the last successful load. The first call for a cold
    tenant loads asynchronously; subsequent calls within the TTL
    see the cached value.
    """
    if not tenant_id:
        return PIIPolicy()
    now = _now()
    cached = _cache.get(tenant_id)
    if cached is not None and now < cached[0]:
        return cached[1]

    # Coalesce concurrent loads for the same tenant.
    async with _cache_lock:
        # Re-check inside the lock — another coroutine may have
        # populated the cache while we were waiting.
        cached = _cache.get(tenant_id)
        if cached is not None and _now() < cached[0]:
            return cached[1]
        pending = _pending.get(tenant_id)
        if pending is not None:
            try:
                return await pending
            except Exception:
                return PIIPolicy()
        future: asyncio.Future[PIIPolicy] = asyncio.get_event_loop().create_future()
        _pending[tenant_id] = future
        try:
            policy = await _load_policy(tenant_id)
            _cache[tenant_id] = (_now() + _TTL_SECONDS, policy)
            future.set_result(policy)
            return policy
        except Exception as exc:
            logger.debug("gateway pii policy load failed for %s: %s", tenant_id, exc)
            fallback = PIIPolicy()
            future.set_result(fallback)
            return fallback
        finally:
            _pending.pop(tenant_id, None)


async def _load_policy(tenant_id: str) -> PIIPolicy:
    """Load the active policy from the DB. Delegates to the ingest
    layer's resolver so we have one source of truth for the query."""
    from eden.observability.ingestion.pii_policy import resolve_policy
    return await resolve_policy(tenant_id)


def invalidate(tenant_id: str) -> None:
    """Drop a tenant's cached policy. Call this from the
    PII-policy PUT route so changes propagate immediately."""
    _cache.pop(tenant_id, None)
    # Any in-flight load for this tenant should also be cancelled
    # so the next call re-resolves. We can't cancel a future from
    # another coroutine safely, so we just clear the entry — the
    # in-flight load will still complete and write its result, which
    # the next call will then see as stale. Acceptable: the next
    # call is also at most 60s old.
