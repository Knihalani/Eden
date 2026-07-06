"""Per-request cost resolution.

This is the right place to compute cost in Eden. The gateway
estimates cost for two distinct reasons:

  1. **Routing** (pre-call): pick the cheapest provider that meets
     quality/latency requirements. Only needs a *blended* rate.
  2. **Billing / observability** (post-call): the dollar figure
     on the customer's invoice. Needs the *actual* rate the
     customer pays, which for enterprise contracts can differ
     wildly from list price.

:class:`CostResolver` answers (2) by walking a four-tier chain:

  1. **Per-tenant override** (``org_cost_overrides`` row) - the
     authoritative source for any tenant with a contract,
     volume discount, or private Bedrock deal.
  2. **PricingCatalog live overlay** - OpenRouter's
     ``/api/v1/models`` for ``openrouter/<vendor>/<model>`` ids.
  3. **PricingCatalog static seed** - verified public list price
     for native OpenAI / Anthropic / Google / self-hosted.
  4. **Zero** - unknown model, no row, no fallback. We *don't*
     default to a conservative estimate; that produces bills the
     customer can't reconcile. The cost_source field carries
     ``"unknown"`` so observability can flag this for review.

The resolver is async (Postgres lookup for tier 1) with an
in-process LRU cache mirroring the PII-policy pattern
(``eden.observability.ingestion.pii_policy``). Cache TTL is 60s
- rate changes take at most a minute to propagate, matching the
existing PII policy TTL.

Resolution is pure: same inputs always produce the same output,
no side effects beyond the cache. Tests can call
:meth:`CostResolver.resolve` directly without spinning up the
gateway.

Schema
------
The returned :class:`CostResolution` is::

    CostResolution(
        cost_per_1k_input: Decimal,
        cost_per_1k_output: Decimal,
        source: Literal["override", "openrouter", "static", "unknown"],
        provider: str,
        model_id: str,
        cached: bool,
        as_of: datetime,    # when this row became effective
        notes: str | None,  # human-readable provenance
    )
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from datetime import UTC, datetime
from decimal import Decimal
from typing import Any, Literal

logger = logging.getLogger(__name__)

# Cache TTL: 60s, matches the PII policy resolver. Rate changes
# take at most a minute to propagate to all gateway workers.
_CACHE_TTL_SECONDS = 60.0

# Maximum cache size. The PII policy resolver doesn't bound this
# (LRU via dict insertion order); we add a hard cap because cost
# overrides can grow with the org list and we don't want a memory
# regression.
_CACHE_MAX_ENTRIES = 4096

CostSource = Literal["override", "openrouter", "static", "unknown"]


@dataclass(frozen=True)
class CostResolution:
    """Result of a cost lookup.

    Frozen because callers should not mutate the resolved values;
    if they need a different rate they should re-resolve with a
    different org_id or model.
    """

    cost_per_1k_input: Decimal
    cost_per_1k_output: Decimal
    source: CostSource
    provider: str
    model_id: str
    cached: bool
    as_of: datetime
    notes: str | None = None

    @property
    def cost_per_1k_blended(self) -> Decimal:
        """Average of input + output rates - used by routing."""
        return (self.cost_per_1k_input + self.cost_per_1k_output) / 2

    def estimate(self, input_tokens: int, output_tokens: int) -> Decimal:
        """Compute the dollar cost for a request.

        ``Decimal`` throughout so we never lose precision on
        rounding - the input rate is in USD per 1K tokens and we
        multiply by tokens / 1000, which can produce ugly floats
        if done in IEEE-754.
        """
        in_cost = (Decimal(input_tokens) / Decimal(1000)) * self.cost_per_1k_input
        out_cost = (Decimal(output_tokens) / Decimal(1000)) * self.cost_per_1k_output
        return in_cost + out_cost


class CostResolver:
    """Per-tenant cost lookup with cache + fallback chain.

    Designed for the gateway hot path: a single resolve() call is
    one cache check, and on miss one Postgres query + one catalog
    lookup, all async-safe under a single lock.
    """

    def __init__(
        self,
        *,
        catalog: Any | None = None,
        cache_ttl_seconds: float = _CACHE_TTL_SECONDS,
        cache_max_entries: int = _CACHE_MAX_ENTRIES,
    ) -> None:
        from eden.llmops.pricing import PricingCatalog as _PricingCatalog

        self.catalog = catalog or _PricingCatalog.default()
        self.cache_ttl_seconds = cache_ttl_seconds
        self.cache_max_entries = cache_max_entries
        # ``dict`` is insertion-ordered; we evict the oldest entry
        # when we exceed the cap.
        self._cache: dict[tuple[str, str, str], tuple[float, CostResolution]] = {}
        self._lock = asyncio.Lock()

    @staticmethod
    def cache_key(org_id: str, provider: str, model_id: str) -> tuple[str, str, str]:
        """Stable cache key. ``org_id`` of ``""`` collapses to a
        single bucket so unauthenticated callers share the
        same cache entry.
        """
        return (org_id or "", provider or "", model_id or "")

    async def resolve(
        self,
        *,
        org_id: str | None,
        provider: str,
        model_id: str,
        force: bool = False,
    ) -> CostResolution:
        """Walk the four-tier chain and return a :class:`CostResolution`.

        Parameters
        ----------
        org_id:
            The tenant's org id. Pass ``None`` or ``""`` for the
            platform-default lookup (no tenant override applies).
        provider:
            Provider enum value (``openai``, ``openrouter``, ...).
            Used to filter overrides (an override for ``openai``
            doesn't apply to an ``openrouter`` request).
        model_id:
            The model id as the gateway sees it. For OpenRouter
            this is the prefixed form (``anthropic/claude-sonnet-4.6``);
            for native providers it's the bare id (``gpt-4o``).
        force:
            Skip the cache. Useful for admin endpoints that need
            to see the latest override.
        """
        key = self.cache_key(org_id or "", provider, model_id)
        if not force:
            cached = self._cache_get(key)
            if cached is not None:
                return cached

        async with self._lock:
            # Re-check under the lock - another task may have
            # populated the cache between the check above and the
            # lock acquisition.
            if not force:
                cached = self._cache_get(key)
                if cached is not None:
                    return cached

            resolution = await self._resolve_uncached(
                org_id=org_id, provider=provider, model_id=model_id,
            )
            self._cache_put(key, resolution)
            return resolution

    async def resolve_batch(
        self,
        *,
        org_id: str | None,
        items: list[tuple[str, str]],
    ) -> list[CostResolution]:
        """Resolve many ``(provider, model_id)`` pairs in one call.

        Used by ``/v1/cost/estimate`` and the admin cost-summary
        endpoint, which need to fan out across many models.
        Concurrent resolves share the same lock so the cache is
        consistent within the batch.
        """
        out: list[CostResolution] = []
        for provider, model_id in items:
            out.append(
                await self.resolve(org_id=org_id, provider=provider, model_id=model_id),
            )
        return out

    async def invalidate(self, org_id: str | None = None) -> int:
        """Drop cached resolutions.

        Pass ``org_id`` to clear only that tenant's entries (used
        by the admin route after a PUT). Pass ``None`` to clear
        everything (used when the catalog refreshes so we don't
        hand out stale "openrouter" rows after a price change).
        """
        async with self._lock:
            if org_id is None:
                n = len(self._cache)
                self._cache.clear()
                return n
            target_prefix = (org_id or "",)
            keys_to_drop = [k for k in self._cache if k[0:1] == target_prefix]
            for k in keys_to_drop:
                del self._cache[k]
            return len(keys_to_drop)

    # ── Internal ───────────────────────────────────────────────────

    def _cache_get(self, key: tuple[str, str, str]) -> CostResolution | None:
        entry = self._cache.get(key)
        if entry is None:
            return None
        expires_at, resolution = entry
        if time.monotonic() >= expires_at:
            del self._cache[key]
            return None
        # Mark as cached without re-resolving.
        return CostResolution(
            cost_per_1k_input=resolution.cost_per_1k_input,
            cost_per_1k_output=resolution.cost_per_1k_output,
            source=resolution.source,
            provider=resolution.provider,
            model_id=resolution.model_id,
            cached=True,
            as_of=resolution.as_of,
            notes=resolution.notes,
        )

    def _cache_put(self, key: tuple[str, str, str], resolution: CostResolution) -> None:
        # Bounded LRU via insertion-order dict: drop the oldest
        # entry when we exceed the cap.
        if len(self._cache) >= self.cache_max_entries:
            oldest_key = next(iter(self._cache))
            del self._cache[oldest_key]
        self._cache[key] = (
            time.monotonic() + self.cache_ttl_seconds,
            resolution,
        )

    async def _resolve_uncached(
        self,
        *,
        org_id: str | None,
        provider: str,
        model_id: str,
    ) -> CostResolution:
        # Tier 1: per-tenant override (Postgres).
        if org_id:
            override = await self._load_override(org_id, provider, model_id)
            if override is not None:
                return override
        # Tier 2 + 3: PricingCatalog. The catalog already carries
        # the live-overlay vs static-seed provenance via its
        # ``source`` field; we map it to our source enum.
        row = self.catalog.lookup(model_id)
        if row is not None:
            if row.source == "openrouter" or row.source == "merged":
                src: CostSource = "openrouter"
            else:
                src = "static"
            return CostResolution(
                cost_per_1k_input=Decimal(str(row.cost_per_1k_input)),
                cost_per_1k_output=Decimal(str(row.cost_per_1k_output)),
                source=src,
                provider=provider,
                model_id=model_id,
                cached=False,
                as_of=datetime.fromtimestamp(self.catalog.last_refresh or 0, tz=UTC)
                if self.catalog.last_refresh
                else datetime.now(UTC),
                notes=f"catalog:{row.source}",
            )
        # Tier 4: unknown. Returning Decimal("0") instead of None
        # makes downstream cost arithmetic safe; the ``source``
        # field tells observability this row needs review.
        return CostResolution(
            cost_per_1k_input=Decimal("0"),
            cost_per_1k_output=Decimal("0"),
            source="unknown",
            provider=provider,
            model_id=model_id,
            cached=False,
            as_of=datetime.now(UTC),
            notes="no pricing data found",
        )

    async def _load_override(
        self,
        org_id: str,
        provider: str,
        model_id: str,
    ) -> CostResolution | None:
        """Query ``org_cost_overrides`` for the most-recent-effective row.

        Returns ``None`` if no override exists, leaving the lookup
        to fall through to the catalog. Wraps the Postgres call
        in try/except so a database blip doesn't poison the
        gateway hot path - we log and fall through.
        """
        try:
            from eden.storage.postgres import get_postgres_client

            client = await get_postgres_client()
            if client is None:
                return None
            row = await client.fetchrow(
                """
                SELECT cost_per_1k_input, cost_per_1k_output, currency,
                       source, effective_from, notes
                FROM org_cost_overrides
                WHERE org_id = $1
                  AND provider IN ($2, '*')
                  AND model_id = $3
                  AND effective_from <= NOW()
                  AND (effective_until IS NULL OR effective_until > NOW())
                ORDER BY (provider = $2) DESC, effective_from DESC
                LIMIT 1
                """,
                org_id,
                provider,
                model_id,
            )
        except Exception as exc:  # noqa: BLE001 - DB blip must not break the gateway
            logger.warning(f"cost override lookup failed for org={org_id}: {exc!r}")
            return None

        if row is None:
            return None

        return CostResolution(
            cost_per_1k_input=Decimal(str(row["cost_per_1k_input"])),
            cost_per_1k_output=Decimal(str(row["cost_per_1k_output"])),
            source="override",
            provider=provider,
            model_id=model_id,
            cached=False,
            as_of=row["effective_from"],
            notes=f"override:{row.get('source') or 'manual'} | {row.get('notes') or ''}".rstrip(" |"),
        )


__all__ = ["CostResolver", "CostResolution", "CostSource"]
