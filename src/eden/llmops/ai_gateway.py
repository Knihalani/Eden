"""Eden LLMOps — AI Gateway v2.

Unified chokepoint between Eden's pipeline and all LLM providers.
Enforces security, cost management, observability, caching, and
automatic failover with circuit breakers.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Any

import httpx

from eden.config import get_settings as _get_settings
from eden.llm.models import INTERNAL_CHAT_MODEL
from eden.llmops.filters import (
    FilterRegistry,
    GatewayFilter,
    PIIFilter,
    PIIFilterConfig,
)
from eden.llmops.pricing import PricingCatalog

logger = logging.getLogger(__name__)


def _pricing_version_from_catalog(catalog: PricingCatalog) -> str:
    """Best-effort pricing version tag for telemetry provenance.

    Combines the seed's last-refresh date (``2026-07`` from the
    in-tree data) with the OpenRouter overlay timestamp so ops
    can tell at a glance whether a cost figure came from the
    static seed or a live refresh.
    """
    from eden.llmops.pricing import _SEED_LAST_REFRESH
    if catalog.last_refresh:
        return f"seed={_SEED_LAST_REFRESH};or={int(catalog.last_refresh)}"
    return f"seed={_SEED_LAST_REFRESH};or=none"


class Provider(StrEnum):
    """LLM provider identifiers.

    Every provider that the AI gateway can route to.  Values match the
    lowercase name used in env vars (``OPENAI_API_KEY`` → ``openai``,
    ``OLLAMA_HOST`` → ``ollama``, …) so :func:`register_providers_from_env`
    can wire them up automatically.
    """

    # Cloud — OpenAI-compatible wire format (chat completions).  ``OPENAI``
    # is the canonical slot for any provider that speaks the OpenAI wire
    # format — point ``OPENAI_BASE_URL`` at Groq, Together, Fireworks,
    # Mistral, DeepSeek, Together, or any custom proxy and it just works.
    # No need for one enum entry per OpenAI-compat provider.
    OPENAI = "openai"
    OPENROUTER = "openrouter"  # multi-model router; also OpenAI-compat
    MINIMAX = "minimax"  # Eden's primary upstream (see config.py)

    # Cloud — Anthropic wire format (/v1/messages).
    ANTHROPIC = "anthropic"

    # Local — Ollama-compatible (its /v1/chat/completions is OpenAI-compat,
    # but ``ollama`` is exposed as its own wire format because users may
    # also hit ``/api/chat`` natively — see OllamaClient).
    OLLAMA = "ollama"
    OLLAMA_CLOUD = "ollama_cloud"  # ollama.com hosted service

    # Local — generic OpenAI-compatible servers.
    VLLM = "vllm"
    LMSTUDIO = "lmstudio"
    LLAMACPP = "llamacpp"

    # Catch-all for unknown providers registered by name.
    SELF_HOSTED = "self_hosted"


class WireFormat(StrEnum):
    """The three wire formats the gateway supports."""

    OPENAI = "openai"  # POST /v1/chat/completions
    ANTHROPIC = "anthropic"  # POST /v1/messages
    OLLAMA = "ollama"  # POST /api/chat (native) — falls back to OpenAI-compat


@dataclass(frozen=True)
class ProviderSpec:
    """Static metadata about a provider — how to talk to it and where to find creds.

    ponytail: this is the minimum data needed for the gateway to construct
    a working client from env vars alone.  No DB lookup, no settings file,
    no per-tenant override — those are v2 concerns.
    """

    wire_format: WireFormat
    base_url: str  # full base URL including ``/v1`` where the API expects it
    api_key_env: str  # env var name (or "" if no auth required, e.g. local Ollama)
    default_model: str  # sensible default when caller doesn't specify
    cost_per_1k_input: float  # USD; 0.0 for self-hosted
    cost_per_1k_output: float  # USD; 0.0 for self-hosted
    quality: float  # 0..1 — used by _select_provider for min_quality filter
    latency_p95_ms: int  # typical p95 latency for routing decisions
    reliability: float  # 0..1 — historical uptime estimate


# PROVIDER_SPECS — the source of truth for "what providers exist + how to
# talk to them".  Adding a new provider is one entry; everything else
# (client construction, env detection, perf estimation, cost tracking)
# falls out of this table.
#
# Cost figures are USD per 1K tokens as of mid-2026. Pricing drifts
# roughly quarterly; refresh when the next quarter's bills arrive.
# **Source of truth note**: figures here come from training data, not
# live vendor pricing pages — treat the *shape* (provider exists, model
# maps to that provider, cloud vs self-hosted cost split) as the real
# signal, and the exact per-token rates as a starting point that ops
# should override via tenant overrides when a customer reports a
# discrepancy.
#
# Self-hosted entries have cost 0.0 — running on the user's own GPU
# has no per-token price, only amortised hardware.
PROVIDER_SPECS: dict[Provider, ProviderSpec] = {
    # ── Cloud: OpenAI-compatible wire format ──────────────────────────
    Provider.OPENAI: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="https://api.openai.com/v1",
        api_key_env="OPENAI_API_KEY",
        # Provider-level default; per-model overrides below carry
        # the latest pricing for the flagship models. Updated
        # 2026-07.
        default_model="gpt-4o-mini",
        # OpenAI raised gpt-4o output pricing in 2025 to $10/1M;
        # input held at $2.5/1M. Provider-level default averages
        # over the current flagship (gpt-4o).
        cost_per_1k_input=0.0025,
        cost_per_1k_output=0.010,
        quality=0.93, latency_p95_ms=650, reliability=0.999,
    ),
    Provider.OPENROUTER: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="https://openrouter.ai/api/v1",
        api_key_env="OPENROUTER_API_KEY",
        # Wave 5: align with INTERNAL_CHAT_MODEL SSOT (deepseek flash),
        # not Sonnet — callers that omit model should not burn frontier $.
        default_model=INTERNAL_CHAT_MODEL,
        # deepseek-v4-flash list (~$0.09/$0.18 per 1M) as provider default.
        cost_per_1k_input=0.00009, cost_per_1k_output=0.00018,
        quality=0.90, latency_p95_ms=800, reliability=0.999,
    ),
    Provider.MINIMAX: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="https://api.minimax.io/v1",
        api_key_env="MINIMAX_API_KEY",
        default_model="MiniMax-M3",
        # MiniMax-M3 list price through 2026-07 — still the cheapest
        # frontier-tier option. Refresh when M4 ships.
        cost_per_1k_input=0.0002, cost_per_1k_output=0.0008,
        quality=0.86, latency_p95_ms=500, reliability=0.995,
    ),
    # ── Cloud: Anthropic wire format ─────────────────────────────────
    Provider.ANTHROPIC: ProviderSpec(
        wire_format=WireFormat.ANTHROPIC,
        base_url="https://api.anthropic.com",
        api_key_env="ANTHROPIC_API_KEY",
        # Cheap Anthropic default (Haiku) — INTERNAL_CHAT_MODEL is an
        # OpenRouter id and is not valid on the Anthropic Messages API.
        default_model="claude-haiku-4-5",
        cost_per_1k_input=0.001, cost_per_1k_output=0.005,
        quality=0.88, latency_p95_ms=350, reliability=0.999,
    ),
    # ── Local: Ollama (default localhost) + Ollama Cloud ─────────────
    Provider.OLLAMA: ProviderSpec(
        wire_format=WireFormat.OLLAMA,
        base_url="http://localhost:11434",
        api_key_env="",  # local Ollama ignores auth
        default_model="llama3.1:8b",
        cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        quality=0.78, latency_p95_ms=400, reliability=0.99,
    ),
    Provider.OLLAMA_CLOUD: ProviderSpec(
        wire_format=WireFormat.OLLAMA,
        base_url="https://ollama.com",
        api_key_env="OLLAMA_CLOUD_API_KEY",
        default_model="llama3.1:8b",
        cost_per_1k_input=0.0001, cost_per_1k_output=0.0001,  # approximate
        quality=0.80, latency_p95_ms=600, reliability=0.99,
    ),
    # ── Local: generic OpenAI-compatible servers ─────────────────────
    Provider.VLLM: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="http://localhost:8000/v1",
        api_key_env="VLLM_API_KEY",  # vLLM's --api-key flag; empty if none
        default_model="meta-llama/Llama-3.1-8B-Instruct",
        cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        quality=0.82, latency_p95_ms=350, reliability=0.99,
    ),
    Provider.LMSTUDIO: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="http://localhost:1234/v1",
        api_key_env="",  # LM Studio's local server has no auth
        default_model="llama-3.1-8b",
        cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        quality=0.80, latency_p95_ms=450, reliability=0.99,
    ),
    Provider.LLAMACPP: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="http://localhost:8080/v1",
        api_key_env="",
        default_model="llama",
        cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        quality=0.78, latency_p95_ms=500, reliability=0.99,
    ),
    # ── Catch-all ────────────────────────────────────────────────────
    Provider.SELF_HOSTED: ProviderSpec(
        wire_format=WireFormat.OPENAI,
        base_url="http://localhost:11434/v1",
        api_key_env="",
        default_model="custom",
        cost_per_1k_input=0.0, cost_per_1k_output=0.0,
        quality=0.80, latency_p95_ms=600, reliability=0.99,
    ),
}


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



@dataclass
class ProviderHealth:
    provider: Provider
    healthy: bool
    avg_latency_ms: int
    error_rate: float
    last_checked: datetime = field(default_factory=lambda: datetime.now(UTC))


class CircuitBreaker:
    """Simple circuit breaker for provider failover."""

    def __init__(self, failure_threshold: int = 5, recovery_timeout_sec: int = 30):
        self.failure_threshold = failure_threshold
        self.recovery_timeout_sec = recovery_timeout_sec
        self._failures = 0
        self._last_failure_time: float | None = None
        self._state = "closed"  # closed | open | half_open

    @property
    def state(self) -> str:
        if (
            self._state == "open"
            and self._last_failure_time
            and (time.time() - self._last_failure_time) > self.recovery_timeout_sec
        ):
            self._state = "half_open"
        return self._state

    def record_success(self) -> None:
        self._failures = 0
        self._state = "closed"

    def record_failure(self) -> None:
        self._failures += 1
        self._last_failure_time = time.time()
        if self._failures >= self.failure_threshold:
            self._state = "open"

    async def call(self, fn: Callable, *args: Any, **kwargs: Any) -> Any:
        st = self.state
        if st == "open":
            raise ProviderUnavailableError("Circuit breaker OPEN for provider")
        try:
            result = await fn(*args, **kwargs)
            self.record_success()
            return result
        except Exception:
            self.record_failure()
            raise


class ProviderUnavailableError(Exception):
    pass


class BudgetExceededError(Exception):
    pass


class AIGateway:
    """AI Gateway with auth, routing, caching, cost tracking, and failover."""

    # Per-model overrides keyed by full model id (e.g. ``gpt-4o``,
    # ``llama3.1:8b``).  When a model appears here it wins over the
    # provider-level estimate from :data:`PROVIDER_SPECS`.  Cost is
    # kept here (not in PROVIDER_SPECS) because pricing varies per
    # model within a provider — ``gpt-4o-mini`` is 30× cheaper than
    # ``gpt-4o`` on the same OpenAI base URL.
    #
    # Self-hosted entries always have cost 0.0 — running on the user's
    # own GPU has no per-token price, only amortised hardware.
    # _PERFORMANCE_LAST_REFRESH = "2026-07" — bump this comment each
    # quarter when refreshing the table so the diff is visible.
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
        # Pricing catalog — live-refreshed from OpenRouter when an
        # api_key is available; falls back to the in-tree seed
        # otherwise. See ``eden.llmops.pricing`` for the schema.
        self.pricing: PricingCatalog = pricing or PricingCatalog.default()
        # Per-tenant cost resolver. Walks override -> catalog
        # (openrouter overlay) -> catalog (static seed) -> zero.
        # Optional so unit tests that only care about routing can
        # pass ``cost_resolver=None``.
        from eden.llmops.cost_resolver import CostResolver as _CostResolver
        self.cost_resolver = cost_resolver or _CostResolver(catalog=self.pricing)
        self._pricing_version = _pricing_version_from_catalog(self.pricing)
        self._providers: dict[Provider, Any] = {}
        self._circuit_breakers: dict[Provider, CircuitBreaker] = {}
        # DL-12: bounded deque of recent metric events. The fixed
        # maxlen prevents a long-lived pod from OOM'ing on a noisy
        # tenant — the oldest entries fall off automatically. Exposed
        # as both ``self.metrics`` (public) and ``self._metrics``
        # (legacy/test alias) for backward compatibility with code
        # that still references the underscored name.
        from collections import deque as _deque
        self.metrics: Any = _deque(maxlen=10_000)
        self._metrics = self.metrics
        self._tenant_budgets: dict[str, dict[str, Any]] = {}
        self._health: dict[Provider, ProviderHealth] = {}

        # Filter pipeline — runs in registration order before any
        # provider call. PII is registered by default; the registry
        # is fail-open so a buggy custom filter cannot block traffic.
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

    def register_provider(self, provider: Provider, client: Any) -> None:
        self._providers[provider] = client
        self._circuit_breakers[provider] = CircuitBreaker()
        self._health[provider] = ProviderHealth(provider=provider, healthy=True, avg_latency_ms=0, error_rate=0.0)

    def set_tenant_budget(self, tenant_id: str, remaining_tokens: int, soft_limit: int, hard_limit: int) -> None:
        self._tenant_budgets[tenant_id] = {
            "remaining": remaining_tokens,
            "soft": soft_limit,
            "hard": hard_limit,
        }

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

    # Audit 2026-07-02 P-19 — walk up to 3 fallback providers via
    # the per-provider CircuitBreaker. Pre-fix: 1 fallback attempt
    # with NO breaker on the fallback path — a broken fallback
    # burned money on every retry.
    _MAX_FALLBACK_DEPTH: int = 3

    async def complete(self, request: ModelRequest) -> ModelResponse:
        # 0. Filter chain — PII by default, plus any registered custom
        # filters. Fail-open by default (see FilterRegistry).
        request, _filter_findings = self._filters.run(request)

        # 1. Check exact cache
        if self.exact_cache:
            cached = await self._check_exact_cache(request)
            if cached:
                await self._record_cache_lookup_hit(
                    request,
                    cache_key=f"exact:{request.prompt_hash}",
                    tokens_used=int(
                        (cached.input_tokens or 0) + (cached.output_tokens or 0)
                    ),
                )
                return cached

        # 2. Check semantic cache
        if self.semantic_cache:
            cached = await self._check_semantic_cache(request)
            if cached:
                await self._record_cache_lookup_hit(
                    request,
                    cache_key=f"semantic:{request.prompt_hash}",
                    tokens_used=int(
                        (cached.input_tokens or 0) + (cached.output_tokens or 0)
                    ),
                )
                return cached

        # 3. Enforce token budget
        budget = self._tenant_budgets.get(request.tenant_id)
        if budget and budget["remaining"] < request.estimated_tokens:
            raise BudgetExceededError(
                f"Tenant {request.tenant_id} budget exceeded: "
                f"remaining={budget['remaining']}, requested={request.estimated_tokens}"
            )

        # 4. Select best provider
        provider = self._select_provider(request)
        if not provider:
            raise ProviderUnavailableError("No healthy provider available for request")

        # 5. Walk the primary + up to ``_MAX_FALLBACK_DEPTH`` fallbacks,
        # each attempt routed through its own CircuitBreaker. Any
        # breaker in ``open`` state is skipped (cheap, in-process).
        start_ms = int(time.time() * 1000)
        last_exc: Exception | None = None
        attempts = 0
        while provider is not None and attempts <= self._MAX_FALLBACK_DEPTH:
            try:
                cb = self._circuit_breakers[provider]
                response = await cb.call(self._execute_provider, provider, request)
                last_exc = None
                break
            except ProviderUnavailableError as exc:
                last_exc = exc
                provider = self._select_fallback(provider, request)
                attempts += 1
        else:  # exhausted attempts
            if last_exc is not None:
                raise ProviderUnavailableError(
                    f"All {self._MAX_FALLBACK_DEPTH + 1} providers unavailable"
                ) from last_exc
            raise ProviderUnavailableError("All providers unavailable")

        latency_ms = int(time.time() * 1000) - start_ms

        # 6. Record metrics
        self._record_metrics(request, provider, response, latency_ms)

        # 7. Update budget
        if budget:
            budget["remaining"] -= response.input_tokens + response.output_tokens

        # 8. Cache response
        await self._cache_response(request, response)

        # 9. Record usage in the budget service (DL-15: per-tenant cost
        # tracking). Best-effort — a budget service outage MUST NOT
        # break the chat response. The test patches
        # ``eden.services.budget_service.record_usage`` to verify the
        # call signature. Skip the call when cost_usd is 0 (a cache
        # hit) — there's no cost to record and no row to update.
        if float(response.cost_usd or 0.0) > 0:
            try:
                from eden.services.budget_service import record_usage

                await record_usage(request.tenant_id, response.cost_usd)
            except Exception as exc:
                logger.debug("ai_gateway: record_usage failed: %s", exc)

        # 10. Cat 20 — best-effort time-travel step recording. Never
        # breaks the hot path; gated by ``time_travel_recording_enabled``.
        await self._maybe_record_time_travel_step(request, response)

        return response

    async def _maybe_record_time_travel_step(
        self,
        request: ModelRequest,
        response: ModelResponse,
    ) -> None:
        """Feature-flagged TraceRecorder hook (Cat 20). Fail-open."""
        try:
            settings = _get_settings()
            if not getattr(settings, "time_travel_recording_enabled", True):
                return
            if not request.tenant_id:
                return
            from eden.time_travel import TraceRecorder

            trace_id = (
                request.trace_id
                or request.job_id
                or f"gw_{request.tenant_id}_{request.prompt_hash[:12]}"
            )
            response_hash = hashlib.sha256(
                (response.text or "").encode("utf-8", errors="replace")
            ).hexdigest()[:32]
            await TraceRecorder().record_step(
                request.tenant_id,
                trace_id=trace_id,
                step_index=int(request.step_index or 0),
                request={
                    "model": request.model_version,
                    "prompt_hash": request.prompt_hash,
                    "temperature": request.temperature,
                    # Persist usable prompt content for Cat 20 replay
                    # (capped). Replayer reads prompt/messages from
                    # payload.request or top-level payload.
                    "prompt": (request.prompt or "")[:8000],
                    "messages": (
                        [{"role": "user", "content": (request.prompt or "")[:8000]}]
                        if (request.prompt or "").strip()
                        else []
                    ),
                },
                response={
                    "response_hash": response_hash,
                    "provider": response.provider,
                    "model": response.model,
                    "tokens_used": int(
                        (response.input_tokens or 0)
                        + (response.output_tokens or 0)
                    ),
                    "cost_usd": float(response.cost_usd or 0.0),
                },
                temperature=request.temperature,
                seed=request.seed,
                cache_mode=request.cache_mode,
            )
        except Exception as exc:  # noqa: BLE001 — never break hot path
            logger.debug("ai_gateway: time-travel record_step failed: %s", exc)

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
            result = await self.semantic_cache.get(request.prompt, similarity_threshold=0.95)
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
                await self.semantic_cache.set(
                    request.prompt,
                    response.text,
                    ttl_seconds=3600,
                )
        except Exception:
            pass

    def _select_provider(self, request: ModelRequest) -> Provider | None:
        """Select the cheapest provider that meets quality/latency requirements."""
        candidates = []
        for provider in Provider:
            if provider not in self._providers:
                continue
            cb = self._circuit_breakers.get(provider)
            if cb and cb.state == "open":
                continue
            health = self._health.get(provider)
            if health and not health.healthy:
                continue

            # Map provider to model performance — SELF_HOSTED entries
            # are model-keyed so a Qwen-32B tenant doesn't get charged
            # with an 8B-class latency estimate.
            perf = self._estimate_provider_performance(provider, request.model_version)
            if perf[0] < request.min_quality:
                continue
            if perf[1] > request.max_latency_ms:
                continue

            candidates.append((provider, perf[2]))  # (provider, cost)

        if not candidates:
            return None
        candidates.sort(key=lambda x: x[1])
        return candidates[0][0]

    def _select_fallback(self, current: Provider, request: ModelRequest) -> Provider | None:
        """Select next-best provider excluding current."""
        candidates = []
        for provider in Provider:
            if provider == current or provider not in self._providers:
                continue
            cb = self._circuit_breakers.get(provider)
            if cb and cb.state == "open":
                continue
            perf = self._estimate_provider_performance(provider, request.model_version)
            if perf[0] < request.min_quality:
                continue
            candidates.append((provider, perf[2]))
        if not candidates:
            return None
        candidates.sort(key=lambda x: x[1])
        return candidates[0][0]

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
          3. :data:`PROVIDER_SPECS` for the provider (provider-level
             defaults).
          4. Generic conservative fallback (0.8, 1000, 0.001, 0.99).

        Cost here is a single blended rate (input+output average) used
        for routing decisions only; actual billing uses the per-model
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
        spec = PROVIDER_SPECS.get(provider)
        if spec is not None:
            # Blended cost = average of input + output rates.
            blended_cost = (spec.cost_per_1k_input + spec.cost_per_1k_output) / 2
            return (spec.quality, spec.latency_p95_ms, blended_cost, spec.reliability)
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
          5. PROVIDER_SPECS cost rates (input/output split).
          6. Generic blended fallback via _estimate_provider_performance.

        For self-hosted providers (OLLAMA / VLLM / LMSTUDIO /
        LLAMACPP / SELF_HOSTED) the per-model entry has cost 0.0 and
        we return 0.0 without further arithmetic - running on the
        user's own GPU has no per-token price.

        This method is the **synchronous, non-org-aware** code path.
        Call sites that have an ``org_id`` and want full provenance
        should use :meth:`resolve_cost` instead, which returns a
        :class:`CostResolution` carrying ``source`` + ``cached``.
        """
        spec = PROVIDER_SPECS.get(provider)
        if spec is not None and (spec.cost_per_1k_input == 0.0 and spec.cost_per_1k_output == 0.0):
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
        if spec is not None:
            return (
                (input_tokens / 1000) * spec.cost_per_1k_input
                + (output_tokens / 1000) * spec.cost_per_1k_output
            )
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
        spec = PROVIDER_SPECS.get(provider)
        if spec is not None and (spec.cost_per_1k_input == 0.0 and spec.cost_per_1k_output == 0.0):
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

    async def _execute_provider(self, provider: Provider, request: ModelRequest) -> ModelResponse:
        client = self._providers.get(provider)
        if not client:
            raise ProviderUnavailableError(f"Provider {provider.value} not registered")

        # DL-10: enforce gateway_max_tokens_cap. 0 = disabled.
        settings = _get_settings()
        if (
            settings.gateway_max_tokens_cap > 0
            and request.max_tokens > settings.gateway_max_tokens_cap
        ):
            raise ValueError(
                f"max_tokens {request.max_tokens} exceeds gateway "
                f"cap {settings.gateway_max_tokens_cap}"
            )
        start = time.perf_counter()
        # Delegate to actual client
        if hasattr(client, "complete"):
            raw = await client.complete(
                model=request.model_version,
                prompt=request.prompt,
                temperature=request.temperature,
                max_tokens=request.max_tokens,
            )
        else:
            # Fallback mock for dev
            raw = {"text": f"[mock response from {provider.value}]", "input_tokens": 100, "output_tokens": 50}

        latency_ms = int((time.perf_counter() - start) * 1000)
        # Use the org-aware async path so ModelResponse carries
        # the cost_source + pricing_version for downstream
        # telemetry. ``request.tenant_id`` is the org id the
        # request was scoped to (matches the resolver's org_id
        # parameter). The new return tuple also carries the
        # cache-aware bill so the response can surface
        # "saved $X via caching" in the portal.
        cache_read = int(raw.get("cache_read_tokens", 0) or request.cache_read_tokens)
        cache_write = int(raw.get("cache_write_tokens", 0) or request.cache_write_tokens)
        cost, cost_source, no_cache_cost, cache_cost = await self.resolve_cost(
            provider,
            raw.get("input_tokens", 0),
            raw.get("output_tokens", 0),
            model_version=request.model_version,
            org_id=request.tenant_id or None,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
        )

        return ModelResponse(
            text=raw.get("text", ""),
            input_tokens=raw.get("input_tokens", 0),
            output_tokens=raw.get("output_tokens", 0),
            latency_ms=latency_ms,
            cost_usd=cost,
            provider=provider.value,
            model=request.model_version,
            cost_source=cost_source,
            pricing_version=self._pricing_version,
            cache_read_tokens=cache_read,
            cache_write_tokens=cache_write,
            cache_cost_usd=cache_cost,
            cost_no_cache_usd=no_cache_cost,
        )

    def _record_metrics(
        self,
        request: ModelRequest,
        provider: Provider,
        response: ModelResponse,
        latency_ms: int,
    ) -> None:
        self.metrics.append({
            "tenant_id": request.tenant_id,
            "job_id": request.job_id,
            "provider": provider.value,
            "model": request.model_version,
            "input_tokens": response.input_tokens,
            "output_tokens": response.output_tokens,
            "latency_ms": latency_ms,
            "cost_usd": response.cost_usd,
            "cached": response.cached,
            "timestamp": datetime.now(UTC).isoformat(),
        })

    def get_metrics(self, tenant_id: str | None = None, limit: int = 1000) -> list[dict[str, Any]]:
        metrics = self.metrics
        if tenant_id:
            metrics = [m for m in metrics if m["tenant_id"] == tenant_id]
        return metrics[-limit:]

    def get_provider_health(self) -> list[ProviderHealth]:
        return list(self._health.values())

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


# ---------------------------------------------------------------------------
# Self-hosted provider (Ollama / vLLM / llama.cpp / LM Studio)
# ---------------------------------------------------------------------------


class OllamaClient:
    """Async client for an Ollama server's OpenAI-compatible endpoint.

    Talks to ``<host>/v1/chat/completions`` — same wire format the
    OpenAI Python SDK uses, so the request/response shape matches what
    :class:`AIGateway._execute_provider` expects (``text``, ``input_tokens``,
    ``output_tokens``).

    The host comes from ``OLLAMA_HOST`` env (default
    ``http://localhost:11434``).  When ``OLLAMA_HOST`` ends without
    ``/v1``, we append it so the URL is well-formed.

    ponytail: this is the minimum client needed for the gateway to
    actually exercise a local Ollama server in tests.  Production
    tenants will eventually want streaming + per-request timeouts;
    add when a tenant needs it.
    """

    def __init__(self, host: str | None = None, *, timeout_s: float = 60.0) -> None:
        import os

        raw = (host or os.environ.get("OLLAMA_HOST") or "http://localhost:11434").rstrip("/")
        # Normalise: if the host already includes ``/v1`` keep it,
        # otherwise append so ``/chat/completions`` resolves.
        if not raw.endswith("/v1"):
            raw = raw + "/v1"
        self._base_url = raw
        self._timeout_s = timeout_s
        # Reuse one OpenAICompatibleClient (and its pooled httpx
        # AsyncClient) across calls — instantiating per-request paid a
        # fresh TCP handshake for every local LLM call.
        self._delegate = OpenAICompatibleClient(
            base_url=self._base_url,
            api_key="ollama",  # required by the SDK shape; Ollama ignores it
            timeout_s=self._timeout_s,
        )

    async def aclose(self) -> None:
        await self._delegate.aclose()

    async def complete(
        self,
        model: str,
        prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        """One-shot chat completion against the local Ollama server.

        Returns ``{"text": ..., "input_tokens": ..., "output_tokens": ...}``
        so :meth:`AIGateway._execute_provider` can consume it without
        knowing it's Ollama.
        """
        # Ollama's ``/v1/chat/completions`` is OpenAI-wire-compatible.
        # Delegate to the cached OpenAICompatibleClient for the actual
        # HTTP call so we have exactly one implementation of that wire
        # format AND keep its pooled connection alive across calls.
        return await self._delegate.complete(
            model=model,
            prompt=prompt,
            temperature=temperature,
            max_tokens=max_tokens,
            **_kwargs,
        )


# ---------------------------------------------------------------------------
# OpenAI-compatible client (covers OpenAI, Groq, Together, Fireworks,
# OpenRouter, MiniMax, vLLM, LM Studio, llama.cpp, Ollama's /v1 endpoint).
# ---------------------------------------------------------------------------


class OpenAICompatibleClient:
    """Async client for any provider speaking the OpenAI chat-completions wire format.

    Used for: OpenAI, Groq, Together, Fireworks, OpenRouter, MiniMax,
    vLLM, LM Studio, llama.cpp, Ollama's ``/v1`` endpoint.  Any provider
    that exposes ``POST /chat/completions`` with the standard
    ``{choices:[{message:{content}}], usage:{prompt_tokens,
    completion_tokens}}`` response shape is supported.

    ponytail: this is the minimum surface needed for the gateway to
    actually exercise a remote OpenAI-compatible provider in tests.
    Streaming + tool calls + JSON-mode responses are the v2 upgrade
    path when a tenant needs them.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        api_key_env: str | None = None,
        timeout_s: float = 60.0,
    ) -> None:
        import os

        if api_key is None and api_key_env:
            api_key = os.environ.get(api_key_env) or None
        if api_key is None:
            api_key = "not-needed"  # local servers (Ollama, LM Studio) ignore auth

        self._base_url = base_url.rstrip("/")
        self._api_key = api_key
        self._timeout_s = timeout_s
        # Lazy-init the AsyncClient so we get connection pooling across
        # requests — otherwise every LLM call pays a fresh TCP+TLS
        # handshake (50–300ms) and burns the provider's per-IP
        # connection rate limit.  Lazy avoids the cost when the client
        # is constructed but never used.
        self._http: httpx.AsyncClient | None = None

    def _get_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self._timeout_s)
        return self._http

    async def aclose(self) -> None:
        """Close the underlying HTTP connection pool. Call on shutdown."""
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def complete(
        self,
        model: str,
        prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        *,
        system_prompt: str | None = None,
        messages: list[dict[str, str]] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        """One-shot chat completion.

        ``messages`` takes precedence over ``prompt`` when given, so
        callers that want multi-turn history can pass it directly.
        Returns ``{text, input_tokens, output_tokens}``.
        """
        url = f"{self._base_url}/chat/completions"
        if messages is None:
            messages = []
            if system_prompt:
                messages.append({"role": "system", "content": system_prompt})
            messages.append({"role": "user", "content": prompt})
        payload: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        headers = {
            "Authorization": f"Bearer {self._api_key}",
            "Content-Type": "application/json",
        }
        resp = await self._get_http().post(url, json=payload, headers=headers)
        resp.raise_for_status()
        data = resp.json()

        # OpenAI-compat shape: ``choices[0].message.content`` + ``usage``.
        choices = data.get("choices") or []
        text = ""
        if choices:
            text = (choices[0].get("message") or {}).get("content", "") or ""
        usage = data.get("usage") or {}
        return {
            "text": text,
            "input_tokens": int(usage.get("prompt_tokens") or 0),
            "output_tokens": int(usage.get("completion_tokens") or 0),
        }


# ---------------------------------------------------------------------------
# Anthropic-compatible client.
# ---------------------------------------------------------------------------


class AnthropicCompatibleClient:
    """Async client for the Anthropic Messages wire format.

    Uses the official ``anthropic`` Python SDK async client when
    available (richer error handling + retries).  Falls back to a
    pure-httpx implementation when the SDK isn't installed, so the
    gateway still works in slim environments.

    Wire format reference:
      POST <base_url>/v1/messages
      Headers: x-api-key, anthropic-version
      Body:    {model, messages:[{role, content}], max_tokens, system?, temperature?}
      Response: {content:[{type:"text", text}], usage:{input_tokens, output_tokens}}
    """

    _ANTHROPIC_VERSION = "2023-06-01"

    def __init__(
        self,
        api_key: str | None = None,
        *,
        api_key_env: str | None = None,
        base_url: str = "https://api.anthropic.com",
        timeout_s: float = 60.0,
    ) -> None:
        import os

        if api_key is None and api_key_env:
            api_key = os.environ.get(api_key_env) or None
        if not api_key:
            raise ValueError(
                "AnthropicCompatibleClient requires an api_key or api_key_env "
                "pointing at a non-empty env var (e.g. ANTHROPIC_API_KEY)"
            )
        self._api_key = api_key
        self._base_url = base_url.rstrip("/")
        self._timeout_s = timeout_s
        # Lazy-init: see OpenAICompatibleClient.__init__ for why.
        self._http: httpx.AsyncClient | None = None

    def _get_http(self) -> httpx.AsyncClient:
        if self._http is None:
            self._http = httpx.AsyncClient(timeout=self._timeout_s)
        return self._http

    async def aclose(self) -> None:
        if self._http is not None:
            await self._http.aclose()
            self._http = None

    async def complete(
        self,
        model: str,
        prompt: str,
        temperature: float = 0.7,
        max_tokens: int = 2048,
        *,
        system_prompt: str | None = None,
        messages: list[dict[str, str]] | None = None,
        **_kwargs: Any,
    ) -> dict[str, Any]:
        """One-shot Anthropic Messages completion.

        Returns ``{text, input_tokens, output_tokens}`` — same shape as
        the OpenAI-compatible clients so the gateway can consume it
        uniformly.
        """
        if messages is None:
            messages = [{"role": "user", "content": prompt}]

        url = f"{self._base_url}/v1/messages"
        body: dict[str, Any] = {
            "model": model,
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
        }
        if system_prompt:
            body["system"] = system_prompt
        headers = {
            "x-api-key": self._api_key,
            "anthropic-version": self._ANTHROPIC_VERSION,
            "Content-Type": "application/json",
        }
        resp = await self._get_http().post(url, json=body, headers=headers)
        resp.raise_for_status()
        data = resp.json()

        # Anthropic response shape: ``content:[{type:"text", text}]``.
        content_blocks = data.get("content") or []
        text_parts = [
            block.get("text", "") for block in content_blocks if block.get("type") == "text"
        ]
        text = "".join(text_parts)
        usage = data.get("usage") or {}
        return {
            "text": text,
            "input_tokens": int(usage.get("input_tokens") or 0),
            "output_tokens": int(usage.get("output_tokens") or 0),
        }


# ---------------------------------------------------------------------------
# Client factory — picks the right wire-format client from a ProviderSpec.
# ---------------------------------------------------------------------------


def _build_client_for_provider(spec: ProviderSpec) -> Any:
    """Construct the right client for a provider spec.

    Looks up credentials from the spec's ``api_key_env``.  For local
    providers with no auth (Ollama, LM Studio, llama.cpp) this still
    returns a working client — auth is filled with a sentinel that
    the server ignores.
    """
    if spec.wire_format == WireFormat.OPENAI:
        return OpenAICompatibleClient(
            base_url=spec.base_url,
            api_key_env=spec.api_key_env or None,
        )
    if spec.wire_format == WireFormat.ANTHROPIC:
        # Anthropic requires a real key — raise early if missing so
        # the user gets a clear error rather than a 401 mid-request.
        return AnthropicCompatibleClient(
            api_key_env=spec.api_key_env,
            base_url=spec.base_url,
        )
    if spec.wire_format == WireFormat.OLLAMA:
        return OllamaClient(host=spec.base_url)
    raise ValueError(f"Unknown wire format: {spec.wire_format!r}")


def register_providers_from_env(gateway: AIGateway) -> list[Provider]:
    """Auto-register every provider whose creds are present in the environment.

    Walks :data:`PROVIDER_SPECS` and, for each entry:

      - If the spec's ``api_key_env`` is set and non-empty, OR the
        provider is one of the local servers (OLLAMA, VLLM, LMSTUDIO,
        LLAMACPP — known to run without an API key on default
        ports), register the right wire-format client.
      - Otherwise, skip silently.

    Returns the list of providers actually registered, so callers
    (startup, tests) can log "registered N providers".

    This replaces the older :func:`register_default_providers` (which
    only wired Ollama as SELF_HOSTED).  It's idempotent — re-running
    it just overwrites the same slot.
    """
    # Local servers that run with no auth on default ports — register
    # them whenever the corresponding base-URL env var is set or the
    # server is reachable on its canonical port.  We don't ping the
    # server here (the circuit breaker handles unreachable cases at
    # request time), but we do honour explicit user opt-out via the
    # same env var being explicitly set to empty.
    local_always_on = {
        Provider.OLLAMA,  # default localhost:11434 — almost always desired
    }
    local_opt_in = {
        Provider.VLLM, Provider.LMSTUDIO, Provider.LLAMACPP,
    }

    registered: list[Provider] = []
    for provider, spec in PROVIDER_SPECS.items():
        # Skip the legacy catch-all — it overlaps with the explicit
        # local providers and should never auto-register.
        if provider == Provider.SELF_HOSTED:
            continue

        # Idempotency: skip if a usable client is already wired.
        # This keeps ``first is second`` true across repeated calls
        # and lets users replace a client manually via
        # ``gateway.register_provider(provider, custom_client)`` and
        # have it survive subsequent calls to this function.
        if provider in gateway._providers:
            registered.append(provider)
            continue

        if spec.api_key_env:
            import os
            if os.environ.get(spec.api_key_env):
                gateway.register_provider(provider, _build_client_for_provider(spec))
                registered.append(provider)
                continue

        # No api key required.
        if provider in local_always_on:
            gateway.register_provider(provider, _build_client_for_provider(spec))
            registered.append(provider)
            continue
        if provider in local_opt_in:
            import os
            # For opt-in local servers, register only if the user set
            # the relevant env var explicitly (VLLM_BASE_URL, etc).
            opt_env = f"{provider.value.upper()}_BASE_URL"
            if os.environ.get(opt_env):
                # Honour a custom base URL the user provided.
                custom_base = os.environ[opt_env].rstrip("/")
                if not custom_base.endswith("/v1") and spec.wire_format == WireFormat.OPENAI:
                    custom_base = custom_base + "/v1"
                gateway.register_provider(
                    provider,
                    OpenAICompatibleClient(base_url=custom_base, api_key_env=spec.api_key_env or None),
                )
                registered.append(provider)
    return registered


def register_default_providers(gateway: AIGateway) -> list[Provider]:
    """Backwards-compatible alias for :func:`register_providers_from_env`.

    Older call sites used this name; it now delegates to the
    environment-driven version so the gateway auto-wires whatever's
    available (cloud keys + local servers).
    """
    return register_providers_from_env(gateway)
