"""Eden LLMOps — AI Gateway (filters, cache, cost attribution).

Slim orchestration layer used by ``/gateway/v1`` for PII/guardrail
filters, semantic/exact cache helpers, and per-request cost
resolution. Multi-provider routing was removed in FEAT-137 — customer
traffic is proxied through a single upstream in
``eden.api.routes.gateway``.
"""

from __future__ import annotations

import hashlib
import json
import logging
from dataclasses import dataclass
from enum import StrEnum
from typing import Any

from eden.llmops.filters import (
    FilterRegistry,
    GatewayFilter,
    PIIFilter,
    PIIFilterConfig,
)
from eden.llmops.pricing import PricingCatalog

logger = logging.getLogger(__name__)


def _pricing_version_from_catalog(catalog: PricingCatalog) -> str:
    """Best-effort pricing version tag for telemetry provenance."""
    from eden.llmops.pricing import _SEED_LAST_REFRESH
    if catalog.last_refresh:
        return f"seed={_SEED_LAST_REFRESH};or={int(catalog.last_refresh)}"
    return f"seed={_SEED_LAST_REFRESH};or=none"


class Provider(StrEnum):
    """LLM provider identifiers for cost attribution and telemetry."""

    OPENAI = "openai"
    OPENROUTER = "openrouter"
    MINIMAX = "minimax"
    ANTHROPIC = "anthropic"
    OLLAMA = "ollama"
    OLLAMA_CLOUD = "ollama_cloud"
    VLLM = "vllm"
    LMSTUDIO = "lmstudio"
    LLAMACPP = "llamacpp"
    SELF_HOSTED = "self_hosted"


_SELF_HOSTED_PROVIDERS = frozenset({
    Provider.OLLAMA,
    Provider.OLLAMA_CLOUD,
    Provider.VLLM,
    Provider.LMSTUDIO,
    Provider.LLAMACPP,
    Provider.SELF_HOSTED,
})


def _is_self_hosted(provider: Provider) -> bool:
    return provider in _SELF_HOSTED_PROVIDERS


@dataclass
class ModelRequest:
    model_family: str
    model_version: str
    prompt: str
    temperature: float = 0.7
    max_tokens: int = 2048
    min_quality: float = 0.8
    max_latency_ms: int = 5000
    estimated_tokens: int = 0
    tenant_id: str = ""
    job_id: str = ""
    # Per-request opt-out for the default PII filter. Defaults to True
    # (i.e. "scrub PII") to match the pre-registry behavior.
    pii_filter_enabled: bool = True
    cache_read_tokens: int = 0
    """Tokens served from cache (Anthropic / OpenAI prompt cache /
    Gemini implicit cache). Used by the cost engine to apply the
    cache-read discount instead of the full input rate."""
    cache_write_tokens: int = 0
    """Tokens written into cache (Anthropic cache writes, OpenAI
    prompt-cache writes). Used by the cost engine to apply the
    cache-write rate."""
    # Cat 20 time-travel recording hooks (optional; best-effort).
    trace_id: str = ""
    step_index: int = 0
    seed: int | None = None
    cache_mode: str | None = None

    @property
    def prompt_hash(self) -> str:
        canonical = json.dumps({"p": self.prompt, "m": self.model_version, "t": self.temperature}, sort_keys=True, separators=(",", ":"))
        return hashlib.sha256(canonical.encode()).hexdigest()[:32]


@dataclass
class ModelResponse:
    text: str
    input_tokens: int
    output_tokens: int
    latency_ms: int
    cost_usd: float
    provider: str
    model: str
    cached: bool = False
    # Cost provenance - tells the operator which tier produced
    # this number. ``"override"`` (per-tenant contract) is the
    # most trustworthy; ``"static"`` (training-data estimate) is
    # the least. Surfaced in the telemetry event so post-hoc
    # reconciliation can flag drift.
    cost_source: str = "static"
    pricing_version: str = ""
    """Git sha or release tag of the PricingCatalog seed that
    produced this cost. Empty string means the seed has never
    been refreshed (e.g. before any OpenRouter fetch)."""
    cache_read_tokens: int = 0
    """Tokens served from cache. Surfaced in telemetry so cost
    analytics can show the cache savings vs the no-cache bill."""
    cache_write_tokens: int = 0
    """Tokens written into cache. Surfaced in telemetry so cost
    analytics can show the cache amortisation."""
    cache_cost_usd: float = 0.0
    """USD spent on cache reads + writes (subset of ``cost_usd``).
    ``cost_usd - cache_cost_usd`` is the no-cache bill; the gap
    is the cache discount applied to this request."""
    cost_no_cache_usd: float = 0.0
    """What this request would have cost without cache - useful
    for the "you saved $X via caching" widget in the portal."""


class AIGateway:
    """Filter pipeline, cache helpers, and cost attribution for /gateway/v1."""

    MODEL_PERFORMANCE: dict[str, tuple[float, int, float, float]] = {
        # Tuple shape: (quality, latency_p95_ms, cost_per_1k_blended, reliability).
        # ``cost_per_1k_blended`` is the per-1k-token BLENDED rate
        # (input + output averaged) used for routing decisions. For
        # billing, :meth:`_estimate_cost` uses the per-model rate
        # against input + output token counts. Local/self-hosted
        # entries always have cost 0.0 — running on the user's own
        # GPU has no per-token price.
        #
        # ── OpenAI (2026-07 snapshot) ───────────────────────────────
        # GPT-5 family replaces GPT-4o / o-series as the default
        # frontier; GPT-4o / o1 are kept for back-compat.
        "gpt-5": (0.95, 800, 0.005, 0.999),
        "gpt-5-mini": (0.90, 400, 0.0006, 0.999),
        "gpt-5-nano": (0.85, 250, 0.00015, 0.999),
        "gpt-4o": (0.93, 700, 0.00625, 0.998),
        "gpt-4o-mini": (0.85, 350, 0.00015, 0.999),
        "o1": (0.95, 5000, 0.0375, 0.998),
        "o1-mini": (0.88, 2000, 0.0015, 0.998),
        "o3": (0.96, 8000, 0.025, 0.998),
        "o3-mini": (0.90, 3000, 0.0019, 0.998),
        # ── Anthropic (2026-07 snapshot) ────────────────────────────
        "claude-sonnet-4-6": (0.94, 900, 0.009, 0.999),
        "claude-sonnet-4": (0.94, 900, 0.009, 0.999),
        "claude-haiku-4-5": (0.88, 350, 0.0019, 0.999),
        "claude-haiku": (0.87, 250, 0.0019, 0.999),
        "claude-opus-4-5": (0.97, 1500, 0.045, 0.999),
        "claude-opus-4": (0.96, 1500, 0.045, 0.999),
        # ── Google (Gemini 3 family, 2026-07) ───────────────────────
        "gemini-3-pro": (0.95, 1100, 0.005, 0.999),
        "gemini-3-flash": (0.88, 450, 0.0004, 0.999),
        "gemini-2.5-pro": (0.93, 1200, 0.005, 0.998),
        "gemini-2.5-flash": (0.86, 500, 0.0003, 0.998),
        # ── OpenRouter (mix of providers) ───────────────────────────
        "anthropic/claude-sonnet-4.6": (0.94, 1000, 0.0096, 0.999),
        "openai/gpt-5": (0.95, 850, 0.0054, 0.999),
        "google/gemini-3-pro": (0.95, 1150, 0.0054, 0.999),
        # ── MiniMax (Eden primary) ──────────────────────────────────
        "minimax-m2.7": (0.86, 500, 0.00015, 0.995),
        "MiniMax-M3": (0.87, 550, 0.0005, 0.995),
        "MiniMax-M4": (0.89, 600, 0.0007, 0.995),
        # ── Local: Ollama (and Ollama Cloud) ────────────────────────
        "llama3.1:8b": (0.78, 400, 0.0, 0.99),
        "llama3.2:3b": (0.72, 200, 0.0, 0.99),
        "llama4:8b": (0.81, 420, 0.0, 0.99),
        "qwen2.5:32b": (0.86, 1200, 0.0, 0.99),
        "qwen2.5:7b": (0.80, 350, 0.0, 0.99),
        "qwen3:32b": (0.88, 1100, 0.0, 0.99),
        "mistral-nemo": (0.82, 700, 0.0, 0.99),
        "deepseek-r1:8b": (0.84, 1500, 0.0, 0.99),
        "gemma3:27b": (0.85, 950, 0.0, 0.99),
        # ── Local: vLLM / LM Studio / llama.cpp ─────────────────────
        "meta-llama/Llama-3.1-8B-Instruct": (0.82, 350, 0.0, 0.99),
        "meta-llama/Llama-4-8B-Instruct": (0.83, 380, 0.0, 0.99),
    }

    def __init__(
        self,
        semantic_cache: Any | None = None,
        exact_cache: Any | None = None,
        pricing: PricingCatalog | None = None,
        cost_resolver: Any | None = None,
    ):
        self.semantic_cache = semantic_cache
        self.exact_cache = exact_cache
        self.pricing: PricingCatalog = pricing or PricingCatalog.default()
        from eden.llmops.cost_resolver import CostResolver as _CostResolver
        self.cost_resolver = cost_resolver or _CostResolver(catalog=self.pricing)
        self._pricing_version = _pricing_version_from_catalog(self.pricing)
        self._filters: FilterRegistry = FilterRegistry()
        self._default_filters: dict[str, GatewayFilter] = {}
        self._register_default_filters()

    def _register_default_filters(self) -> None:
        """Register the default filter chain. Called from __init__.

        Tests that want a minimal gateway can call
        ``AIGateway(filters=FilterRegistry())`` to skip defaults.
        """
        pii = PIIFilter(PIIFilterConfig())
        self._filters.register(pii)
        self._default_filters[pii.name] = pii
        try:
            from eden.llmops.filters.trajectory import get_trajectory_filter

            traj = get_trajectory_filter()
            self._filters.register(traj)
            self._default_filters[traj.name] = traj
        except Exception as exc:
            logger.debug("gateway: trajectory filter unavailable: %s", exc)

    def register_filter(self, f: GatewayFilter) -> None:
        """Add a custom filter to the chain.

        Filters run in registration order, so to run *after* PII use
        ``gateway.register_filter(MyFilter())`` on a fresh gateway.
        """
        self._filters.register(f)

    def unregister_filter(self, name: str) -> int:
        """Remove all filters with the given name. Returns count removed."""
        return self._filters.unregister(name)

    def set_filter_enabled(self, name: str, enabled: bool) -> bool:
        """Globally enable/disable a default filter by name.

        Returns True if a filter with that name was found.
        """
        f = self._default_filters.get(name)
        if f is None:
            return False
        if hasattr(f, "config") and hasattr(f.config, "enabled"):
            f.config.enabled = enabled
            return True
        return False

    # ── Pricing ────────────────────────────────────────────────────

    async def refresh_pricing(
        self,
        *,
        api_key: str | None = None,
        base_url: str | None = None,
        force: bool = False,
    ) -> bool:
        """Refresh the live pricing catalog from OpenRouter.

        Returns True if a refresh ran (or is running) on this call.
        Callers wired into the request path should use this so the
        first request after process start triggers the fetch and
        subsequent requests hit the cache.

        Safe to call repeatedly: concurrent calls share the same
        in-flight task, and a failed refresh is logged but never
        raised.
        """
        return await self.pricing.ensure_fresh(
            api_key=api_key, base_url=base_url, force=force,
        )

    async def refresh_pricing_from_models_dev(
        self,
        *,
        url: str = "https://models.dev/api.json",
        force: bool = False,
    ) -> int:
        """Refresh the live pricing catalog from models.dev.

        models.dev is the higher-trust overlay - it carries pricing
        for native vendor endpoints (OpenAI / Anthropic / Google /
        MiniMax / Mistral / DeepSeek / xAI / Cohere) sourced from
        each vendor's public pricing page. OpenRouter's overlay is
        kept separately because it carries the routing markup that
        ``openrouter/<vendor>/<model>`` rows actually bill at.

        The resolver in :mod:`eden.llmops.cost_resolver` prefers
        models.dev over the static seed for native vendor rows but
        defers to OpenRouter's overlay for ``openrouter/``-prefixed
        ids.

        Returns the number of rows updated. Failures are logged
        but never raised - the static seed is the fallback.
        """
        # Reuse the catalog's in-flight dedup so we don't double-
        # fetch when the OpenRouter refresh just ran.
        if not force and self.pricing.is_fresh():
            return 0
        try:
            return await self.pricing.refresh_from_models_dev(url=url)
        except Exception as exc:  # noqa: BLE001 - never propagate
            logger.warning(f"models.dev pricing refresh failed: {exc!r}")
            return 0

    def pricing_summary(self) -> dict[str, Any]:
        """Diagnostic snapshot of the pricing catalog.

        Used by the diagnostics/health endpoint and tests to verify
        the catalog loaded correctly.
        """
        sources: dict[str, int] = {}
        for row in self.pricing.rows.values():
            sources[row.source] = sources.get(row.source, 0) + 1
        return {
            "total_rows": len(self.pricing),
            "fresh": self.pricing.is_fresh(),
            "last_refresh": self.pricing.last_refresh,
            "sources": sources,
            "model_ids": sorted(self.pricing.rows.keys()),
        }

    async def _record_cache_lookup_hit(
        self,
        request: ModelRequest,
        *,
        cache_key: str,
        tokens_used: int,
    ) -> None:
        """Best-effort write to ``cache_lookups`` (never breaks hot path)."""
        try:
            if not request.tenant_id:
                return
            from eden.time_travel._common import record_cache_lookup

            await record_cache_lookup(
                org_id=request.tenant_id,
                cache_key=cache_key,
                tokens_used=tokens_used,
                cost_usd=0.0,
            )
        except Exception as exc:  # noqa: BLE001
            logger.debug("ai_gateway: cache_lookups write failed: %s", exc)

    async def _check_exact_cache(self, request: ModelRequest) -> ModelResponse | None:
        if not self.exact_cache:
            return None
        try:
            key = f"exact:{request.prompt_hash}"
            cached = await self.exact_cache.get(key)
            if cached:
                data = json.loads(cached)
                return ModelResponse(
                    text=data["text"],
                    input_tokens=data["input_tokens"],
                    output_tokens=data["output_tokens"],
                    latency_ms=0,
                    cost_usd=0.0,
                    provider=data.get("provider", "cache"),
                    model=data.get("model", ""),
                    cached=True,
                    cost_source="cache",
                )
        except Exception:
            pass
        return None

    async def _check_semantic_cache(self, request: ModelRequest) -> ModelResponse | None:
        if not self.semantic_cache:
            return None
        try:
            # ``SemanticCache.get`` requires the model_version
            # positionally (entries are keyed per model). The old
            # call omitted it, so every lookup raised TypeError and
            # was swallowed by the except below — the cache could
            # never hit. Fixed when the cache was wired into the
            # live gateway singleton (2026-08).
            result = await self.semantic_cache.get(
                request.prompt,
                request.model_version,
                similarity_threshold=0.95,
            )
            if result:
                return ModelResponse(
                    text=result,
                    input_tokens=request.estimated_tokens,
                    output_tokens=len(result.split()),
                    latency_ms=0,
                    cost_usd=0.0,
                    provider="semantic_cache",
                    model=request.model_version,
                    cached=True,
                    cost_source="cache",
                )
        except Exception:
            pass
        return None

    async def _cache_response(self, request: ModelRequest, response: ModelResponse) -> None:
        if response.cached:
            return
        try:
            if self.exact_cache:
                key = f"exact:{request.prompt_hash}"
                payload = json.dumps({
                    "text": response.text,
                    "input_tokens": response.input_tokens,
                    "output_tokens": response.output_tokens,
                    "provider": response.provider,
                    "model": response.model,
                })
                await self.exact_cache.set(key, payload, ttl=3600)
            if self.semantic_cache:
                # Store under the *requested* model version so the
                # lookup key in ``_check_semantic_cache`` matches
                # (``response.model`` may be a provider-resolved
                # alias and would never be found again).
                await self.semantic_cache.set(
                    request.prompt,
                    response.text,
                    request.model_version,
                    ttl_seconds=3600,
                )
        except Exception:
            pass

    def _estimate_provider_performance(
        self, provider: Provider, model_version: str | None = None
    ) -> tuple[float, int, float, float]:
        """Return (quality, latency_p95_ms, cost_per_1k, reliability) for a request.

        Lookup order:
          1. :attr:`PricingCatalog` (live-refreshed from OpenRouter;
             preferred for ``openrouter/<vendor>/<model>`` ids and
             any model OpenRouter has added since the seed).
          2. :attr:`MODEL_PERFORMANCE` by exact model name (legacy
             per-model overrides, kept for back-compat with code
             that mutates it directly).
          3. Generic conservative fallback (0.8, 1000, 0.001, 0.99).

        Cost here is a single blended rate (input+output average) used
        for cost-estimate fallbacks; actual billing uses the per-model
        rate via :meth:`_estimate_cost`.
        """
        if model_version:
            row = self.pricing.lookup(model_version)
            if row is not None:
                return (
                    row.quality,
                    row.latency_p95_ms,
                    row.cost_per_1k_blended,
                    row.reliability,
                )
        if model_version and model_version in self.MODEL_PERFORMANCE:
            return self.MODEL_PERFORMANCE[model_version]
        return (0.8, 1000, 0.001, 0.99)

    def _estimate_cost(
        self,
        provider: Provider,
        input_tokens: int,
        output_tokens: int,
        model_version: str = "",
        *,
        org_id: str | None = None,
    ) -> float:
        """Per-token cost using the per-model rate when known.

        Cost lookup order:
          1. Self-hosted providers (cost == 0.0) -> return 0.0.
          2. :class:`CostResolver` when ``org_id`` is provided -
             walks org_cost_overrides, then catalog (live
             OpenRouter overlay), then catalog (static seed).
          3. :attr:`PricingCatalog` entry for ``model_version`` -
             uses the **split** input/output rates so we can apply
             them precisely to ``input_tokens`` vs ``output_tokens``.
          4. :attr:`MODEL_PERFORMANCE` entry for ``model_version`` -
             legacy per-model overrides, blended rate.
          5. Generic blended fallback via _estimate_provider_performance.

        For self-hosted providers (OLLAMA / VLLM / LMSTUDIO /
        LLAMACPP / SELF_HOSTED) the per-model entry has cost 0.0 and
        we return 0.0 without further arithmetic - running on the
        user's own GPU has no per-token price.

        This method is the **synchronous, non-org-aware** code path.
        Call sites that have an ``org_id`` and want full provenance
        should use :meth:`resolve_cost` instead, which returns a
        :class:`CostResolution` carrying ``source`` + ``cached``.
        """
        if _is_self_hosted(provider):
            return 0.0
        if org_id and self.cost_resolver is not None:
            # Sync path: the cache hit is the common case; the
            # uncached case requires Postgres. We block here to
            # match the existing _estimate_cost signature, but
            # callers that want non-blocking should use
            # :meth:`resolve_cost` instead.
            import asyncio as _asyncio
            try:
                _loop = _asyncio.get_event_loop()
                if _loop.is_running():
                    # We're inside an event loop; the caller
                    # should have used ``resolve_cost``. Fall
                    # through to the catalog-only path so we don't
                    # deadlock.
                    pass
                else:
                    res = _loop.run_until_complete(
                        self.cost_resolver.resolve(
                            org_id=org_id,
                            provider=provider.value,
                            model_id=model_version,
                        )
                    )
                    return float(
                        res.estimate(input_tokens, output_tokens)
                    )
            except RuntimeError:
                # No event loop (very early startup); fall through.
                pass
        # Live catalog wins over legacy per-model overrides.
        if model_version:
            row = self.pricing.lookup(model_version)
            if row is not None:
                return (
                    (input_tokens / 1000) * row.cost_per_1k_input
                    + (output_tokens / 1000) * row.cost_per_1k_output
                )
        # Per-model override (most accurate - gpt-4o-mini is 30x
        # cheaper than gpt-4o on the same provider).
        if model_version and model_version in self.MODEL_PERFORMANCE:
            blended = self.MODEL_PERFORMANCE[model_version][2]
            return ((input_tokens + output_tokens) / 1000) * blended
        perf = self._estimate_provider_performance(provider, model_version)
        return ((input_tokens + output_tokens) / 1000) * perf[2]

    async def resolve_cost(
        self,
        provider: Provider,
        input_tokens: int,
        output_tokens: int,
        model_version: str = "",
        *,
        org_id: str | None = None,
        cache_read_tokens: int = 0,
        cache_write_tokens: int = 0,
    ) -> tuple[float, str, float, float]:
        """Async cost lookup with cache-aware billing.

        Returns ``(cost_usd, source, no_cache_cost_usd, cache_cost_usd)``
        where:

        * ``cost_usd`` — what the customer is billed, with cache
          discounts applied (Anthropic 10%/25%, OpenAI 50%/full,
          Gemini 0% etc.).
        * ``source`` — provenance ("override", "openrouter",
          "models_dev", "static", "unknown", "self_hosted").
        * ``no_cache_cost_usd`` — what the same request would have
          cost without cache. Useful for the "you saved $X" widget.
        * ``cache_cost_usd`` — USD spent on cache reads + writes
          (subset of ``cost_usd``).

        Use this from request handlers where the org_id is in
        scope and you want the full provenance for telemetry.
        Synchronous callers without an event loop should fall
        back to :meth:`_estimate_cost`.
        """
        if _is_self_hosted(provider):
            return 0.0, "self_hosted", 0.0, 0.0
        has_cache = bool(cache_read_tokens or cache_write_tokens)
        if self.cost_resolver is not None and model_version:
            res = await self.cost_resolver.resolve(
                org_id=org_id,
                provider=provider.value,
                model_id=model_version,
            )
            # Always compute the no-cache figure so callers can
            # surface the cache discount in telemetry.
            no_cache = float(res.estimate(input_tokens, output_tokens))
            if has_cache:
                cost = float(
                    res.estimate_with_cache(
                        input_tokens=input_tokens,
                        output_tokens=output_tokens,
                        cache_read_tokens=cache_read_tokens,
                        cache_write_tokens=cache_write_tokens,
                    )
                )
                cache_cost = no_cache - cost
                return cost, res.source, no_cache, max(0.0, cache_cost)
            return no_cache, res.source, no_cache, 0.0
        # No resolver or no model_version: fall back to the
        # synchronous path. Wrapped so the source reflects the
        # catalog seed vs legacy table distinction.
        cost = self._estimate_cost(
            provider, input_tokens, output_tokens, model_version,
        )
        # If we have cache info, try to apply the cache-aware
        # estimate from the catalog row directly.
        no_cache = cost
        cache_cost = 0.0
        row = self.pricing.lookup(model_version) if model_version else None
        if has_cache and row is not None:
            no_cache = (
                (input_tokens / 1000.0) * row.cost_per_1k_input
                + (output_tokens / 1000.0) * row.cost_per_1k_output
            )
            cost = row.cost_for_request(
                input_tokens=input_tokens,
                output_tokens=output_tokens,
                cache_read_tokens=cache_read_tokens,
                cache_write_tokens=cache_write_tokens,
            )
            cache_cost = max(0.0, no_cache - cost)
        if row is not None:
            row_source = row.source
            if row_source == "openrouter":
                source = "openrouter"
            elif row_source == "models_dev":
                source = "models_dev"
            elif row_source == "merged":
                source = "openrouter"  # legacy: merged -> openrouter
            else:
                source = "static"
        else:
            source = "unknown"
        return cost, source, no_cache, cache_cost

    def get_filter_metrics(self) -> dict[str, Any]:
        """Return filter-pipeline counters: total invocations, total
        findings, total errors, and the list of registered filter names.
        Used by tests and the observability layer."""
        return {
            "invocations": self._filters.invocations,
            "findings": self._filters.findings,
            "errors": self._filters.errors,
            "filter_names": self._filters.names(),
        }
