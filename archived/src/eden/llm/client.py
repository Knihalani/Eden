"""OpenRouter LLM client with retry logic, circuit breaker, and cost tracking."""

import logging
import os
import time
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass
from enum import Enum
from functools import lru_cache
from typing import Any

# Audit 2026-07-06 - lazy-import the openai SDK. Pulls in the
# full openai.types tree (~200ms cold). We use PEP 562 module
# __getattr__ to keep the ``from eden.llm.client import OpenAI``
# import surface working (tests patch
# ``eden.llm.client.OpenAI``) while only paying the import cost
# on the first lookup.
_OPENAI_ATTRS: dict | None = None


def _ensure_openai() -> dict[str, Any]:
    """Resolve all five openai symbols we use. Cached at the
    module level so we only pay the import cost once per process."""
    global _OPENAI_ATTRS
    if _OPENAI_ATTRS is None:
        from openai import (
            APIError,
            APITimeoutError,
            AsyncOpenAI,
            OpenAI,
            RateLimitError,
        )
        _OPENAI_ATTRS = {
            "OpenAI": OpenAI,
            "AsyncOpenAI": AsyncOpenAI,
            "APIError": APIError,
            "APITimeoutError": APITimeoutError,
            "RateLimitError": RateLimitError,
        }
    return _OPENAI_ATTRS


def __getattr__(name: str) -> Any:
    """PEP 562 module-level __getattr__ — resolve the openai
    symbols lazily on first attribute access. ``patch(
    "eden.llm.client.OpenAI")`` still works because unittest.mock
    uses __getattr__ under the hood."""
    if name in ("OpenAI", "AsyncOpenAI", "APIError", "APITimeoutError", "RateLimitError"):
        return _ensure_openai()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

from eden.config import get_settings  # noqa: E402

logger = logging.getLogger(__name__)

# OPT-36 — prompt-cache observability via ``simple_metrics`` (exposed on ``/metrics``).
try:
    from eden.observability.simple_metrics import Counter as _MetricsCounter
except Exception:  # noqa: BLE001 — metrics are best-effort on the LLM hot path
    _MetricsCounter = None  # type: ignore[misc, assignment]

if _MetricsCounter is not None:
    _PROMPT_CACHE_READS_TOKENS = _MetricsCounter(
        "eden_llm_prompt_cache_reads_tokens_total",
        "Upstream prompt-cache tokens read (OpenRouter cached_tokens / cache_reads).",
    )
    _PROMPT_CACHE_WRITES_TOKENS = _MetricsCounter(
        "eden_llm_prompt_cache_writes_tokens_total",
        "Upstream prompt-cache tokens written (cache_write_tokens / cache_writes).",
    )
    _PROMPT_CACHE_HITS = _MetricsCounter(
        "eden_llm_prompt_cache_hits_total",
        "LLM requests where upstream prompt-cache reads > 0.",
    )
    _PROMPT_CACHE_DISCOUNT_USD = _MetricsCounter(
        "eden_llm_prompt_cache_discount_usd_total",
        "Cumulative upstream prompt-cache discount in USD when reported.",
    )
    _INPROCESS_CACHE_HITS = _MetricsCounter(
        "eden_llm_inprocess_cache_hits_total",
        "In-process LRU cache hits (L0, EDEN_LLM_INPROCESS_CACHE).",
    )
    _INPROCESS_CACHE_MISSES = _MetricsCounter(
        "eden_llm_inprocess_cache_misses_total",
        "In-process LRU cache misses (L0, EDEN_LLM_INPROCESS_CACHE).",
    )
else:
    _PROMPT_CACHE_READS_TOKENS = None  # type: ignore[assignment]
    _PROMPT_CACHE_WRITES_TOKENS = None  # type: ignore[assignment]
    _PROMPT_CACHE_HITS = None  # type: ignore[assignment]
    _PROMPT_CACHE_DISCOUNT_USD = None  # type: ignore[assignment]
    _INPROCESS_CACHE_HITS = None  # type: ignore[assignment]
    _INPROCESS_CACHE_MISSES = None  # type: ignore[assignment]

#: Per-request ceiling for a single upstream LLM HTTP request, seconds.
#:
#: The openai SDK's default is 600s. Eden wraps every call in its own
#: retry + tier-fallback loops, so a 600s ceiling on each leg meant a
#: single logical call could occupy a worker for the better part of an
#: hour. 60s is generous for the T1/T2 models actually routed to (p95
#: latencies in the seed table are 650-1200ms) while still bounding the
#: pathological case. Override with ``EDEN_LLM_REQUEST_TIMEOUT_S``.
_LLM_REQUEST_TIMEOUT_S: float = float(
    os.getenv("EDEN_LLM_REQUEST_TIMEOUT_S", "60") or 60
)


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class UsageStats:
    """Token usage statistics for a request."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float | None = None
    cache_discount: float | None = None
    cache_reads: int = 0
    cache_writes: int = 0


def _cache_tokens_from_usage(usage: Any) -> tuple[int, int]:
    """Extract cache hit/write tokens from OpenRouter usage (OPT-35).

    OPT-36 hit-rate interpretation (upstream Anthropic/OpenRouter prompt cache):
    - ``token_hit_rate = reads / (reads + writes)`` when writes are reported;
    - ``request_hit_rate = hits / upstream_requests`` where a hit is any
      request with ``reads > 0``. In-process LRU hits are tracked separately
      via ``eden_llm_inprocess_cache_hits_total``.
    """
    if usage is None:
        return 0, 0
    ptd = getattr(usage, "prompt_tokens_details", None)
    if ptd is not None:
        reads = getattr(ptd, "cached_tokens", None)
        writes = getattr(ptd, "cache_write_tokens", None)
        if reads is not None or writes is not None:
            return int(reads or 0), int(writes or 0)
    return (
        int(getattr(usage, "cache_reads", 0) or 0),
        int(getattr(usage, "cache_writes", 0) or 0),
    )


@dataclass
class LLMResponse:
    """Standardized LLM response."""

    content: str
    usage: UsageStats
    model: str
    finish_reason: str
    raw_response: Any = None


class CircuitBreaker:
    """Circuit breaker for LLM calls per agent."""

    def __init__(
        self,
        failure_threshold: int = 5,
        recovery_timeout: int = 60,
        half_open_max_failures: int = 3,
        half_open_lockout_seconds: int = 300,
    ):
        self.failures: dict[str, int] = defaultdict(int)
        self.state: dict[str, CircuitState] = defaultdict(lambda: CircuitState.CLOSED)
        self.last_failure_time: dict[str, float] = {}
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.half_open_failures: dict[str, int] = defaultdict(int)
        self.half_open_lock_until: dict[str, float] = {}
        self.half_open_max_failures = half_open_max_failures
        self.half_open_lockout_seconds = half_open_lockout_seconds

    def is_open(self, agent: str) -> bool:
        """True when the circuit is OPEN and still within the
        recovery_timeout window. Transitions to HALF_OPEN once the
        timeout has elapsed (allowing a single probe call).
        """
        if self.state[agent] != CircuitState.OPEN:
            return False
        # If no lock has been set, the circuit was just opened and we
        # haven't yet hit recovery_timeout (the lock is set on
        # half-open max_failures escalation).  Treat that as still-open.
        if self.last_failure_time.get(agent) is None:
            return True
        elapsed = time.time() - self.last_failure_time[agent]
        if elapsed < self.recovery_timeout:
            return True
        # Recovery window elapsed — transition to HALF_OPEN to allow a
        # single probe call.
        self.state[agent] = CircuitState.HALF_OPEN
        return False

    def record_success(self, agent: str) -> None:
        self.failures[agent] = 0
        self.half_open_failures[agent] = 0
        self.state[agent] = CircuitState.CLOSED

    def record_failure(self, agent: str) -> None:
        self.failures[agent] += 1
        self.last_failure_time[agent] = time.time()
        if self.state[agent] == CircuitState.HALF_OPEN:
            self.half_open_failures[agent] += 1
            if self.half_open_failures[agent] >= self.half_open_max_failures:
                self.half_open_lock_until[agent] = time.time() + self.half_open_lockout_seconds
                self.state[agent] = CircuitState.OPEN
                return
        if self.failures[agent] >= self.failure_threshold:
            self.state[agent] = CircuitState.OPEN

    def get_status(self, agent: str) -> dict:
        return {
            "state": self.state[agent].value,
            "failures": self.failures[agent],
            "last_failure": self.last_failure_time.get(agent),
            "half_open_failures": self.half_open_failures.get(agent, 0),
            "half_open_lock_until": self.half_open_lock_until.get(agent),
        }


class OpenRouterClient:
    """OpenRouter API client with retry, circuit breaker, and cost tracking."""

    def __init__(
        self,
        api_key: str | None = None,
        base_url: str = "https://openrouter.ai/api/v1",
        max_retries: int = 3,
        circuit_breaker_threshold: int = 5,
        circuit_breaker_timeout: int = 60,
    ):
        # Resolve the openai client classes via the module's
        # normal attribute lookup (audit 2026-07-06). The PEP 562
        # __getattr__ on this module makes ``OpenAI`` and
        # ``AsyncOpenAI`` lazy-evaluated on first access, so the
        # SDK import only happens on the first client construction.
        # ``patch("eden.llm.client.OpenAI")`` still works because
        # unittest.mock writes to the module's __dict__ before
        # PEP 562 __getattr__ is consulted. We use ``getattr`` on
        # the module itself to be explicit (and to avoid shadowing
        # the builtin ``OpenAI`` if one were ever introduced).
        # Lazy-resolve the openai SDK (audit 2026-07-06). The
        # bare-name lookup would force the SDK to load at module
        # import; getattr() on the module goes through the PEP
        # 562 ``__getattr__`` first so unittest.mock patches
        # (``patch("eden.llm.client.OpenAI")``) still work.
        import sys as _sys
        _this_mod = _sys.modules[__name__]
        OpenAI = getattr(_this_mod, "OpenAI")  # noqa: B009, N806
        AsyncOpenAI = getattr(_this_mod, "AsyncOpenAI")  # noqa: B009, N806

        self.settings = get_settings()

        # Bound every upstream request, and let Eden own retries.
        #
        # Neither client passed ``timeout`` or ``max_retries``, so the
        # openai SDK defaults applied: 600s per request and 2 internal
        # retries, i.e. 3 HTTP requests per Eden attempt. That multiplies
        # against Eden's own nested loops —
        # ``for tier`` x ``for model`` x ``for attempt in max_retries``
        # in model_router — so one logical call could reach 9 model slots
        # x 3 Eden attempts x 3 SDK attempts = 81 upstream requests, each
        # able to hang for ten minutes. It also meant the circuit breaker
        # counted logical calls, not requests: at threshold 5 it took
        # ~405 upstream requests to open.
        #
        # ``max_retries=0`` because Eden already retries and escalates
        # tiers; the SDK's copy is pure multiplication with no added
        # signal. ``_LLM_REQUEST_TIMEOUT_S`` is the per-request ceiling,
        # well inside the 300s PIPELINE_TIMEOUT_SECONDS the API allows a
        # whole pipeline.
        _client_kwargs = {
            "api_key": api_key or self.settings.openrouter_api_key,
            "base_url": base_url,
            "timeout": _LLM_REQUEST_TIMEOUT_S,
            "max_retries": 0,
        }
        self.client = OpenAI(**_client_kwargs)
        # Async client for the ``acall`` path. Kept as a separate
        # attribute so tests can mock sync + async independently
        # (the async mock needs ``create`` to be an ``AsyncMock``).
        self.async_client = AsyncOpenAI(**_client_kwargs)
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=circuit_breaker_threshold,
            recovery_timeout=circuit_breaker_timeout,
        )
        self.max_retries = max_retries
        # Bounded ring buffer — was an unbounded ``list`` that grew
        # for the process lifetime, every LLM call forever adding
        # memory pressure. 10k entries is ~6h at the v1 steady-state
        # call rate and is plenty for cost dashboards.
        self._usage_log: deque[UsageStats] = deque(maxlen=10_000)
        # Process-local LRU cache for LLM responses. The Redis
        # cache in eden.optimization.cache is the cross-process
        # L1 store; this is the L0 (in-memory) — saves the
        # network round-trip on hot retry loops, repeated calls
        # within one patch-generation pipeline, and identical
        # re-runs of the same prompt. Bounded at 256 entries
        # (~few MB) so a runaway loop can't blow up memory.
        # Disabled by default — opt in via
        # ``EDEN_LLM_INPROCESS_CACHE=1`` because cached
        # responses can become stale (model upgrades, prompt
        # refactors, etc.).
        self._in_process_cache: "OrderedDict[str, tuple[float, LLMResponse]]" = OrderedDict()  # noqa: UP037
        self._in_process_cache_max = int(
            os.getenv("EDEN_LLM_INPROCESS_CACHE_MAX", "256")
        )
        self._in_process_cache_ttl = float(
            os.getenv("EDEN_LLM_INPROCESS_CACHE_TTL", "300")
        )  # 5 min default TTL
        self._in_process_cache_enabled = (
            os.getenv("EDEN_LLM_INPROCESS_CACHE", "0") == "1"
        )
        self._cache_hits = 0
        self._cache_misses = 0
        # OPT-36 — upstream prompt-cache tallies (network responses only).
        self._prompt_cache_reads_tokens = 0
        self._prompt_cache_writes_tokens = 0
        self._prompt_cache_hits = 0
        self._upstream_llm_requests = 0
        self._prompt_cache_discount_usd = 0.0
        # §11.4 — per-provider error counters split by openai vs anthropic
        # so the observability dashboard can break them out by provider.
        self._provider_errors: dict[str, int] = {}
        self._provider_calls: dict[str, int] = {}

    # Slot → tier mapping mirrors TaskClassifier heuristics in
    # ``eden.optimization.model_router`` so direct ``call``/``acall``
    # paths pick the same model chains as ModelRouter.
    _SLOT_TO_TIER: dict[str, str] = {
        "fast": "t1",
        "extraction": "t1",
        "code": "t2",
        "reasoning": "t2",
    }

    _SLOT_MAX_TOKENS_ATTR: dict[str, str] = {
        "reasoning": "max_tokens_planner",
        "code": "max_tokens_executor",
        "fast": "max_tokens_critic",
        "extraction": "max_tokens_fact_checker",
    }

    def _models_and_tokens_for_slot(self, slot: str) -> tuple[list[str], int]:
        """Resolve model chain and max_tokens for a slot via ModelRouter tiers.

        W4-1: reads from the module-level TIER_MODELS (defined below) so this
        no longer cross-imports eden.optimization.model_router at call time.
        """
        tier_key = self._SLOT_TO_TIER.get(slot, "t2")
        tier = ModelTier(tier_key)
        models = list(TIER_MODELS.get(tier, TIER_MODELS[ModelTier.T2]))
        attr = self._SLOT_MAX_TOKENS_ATTR.get(slot, "max_tokens_planner")
        max_tokens = getattr(self.settings, attr, 4096)
        return models, max_tokens

    def get_model_for_slot(self, slot: str) -> str:
        """Get the primary model for a slot from the tier router."""
        models, _ = self._models_and_tokens_for_slot(slot)
        return models[0]

    @staticmethod
    def _clamp_max_tokens(max_tokens: int | None) -> int:
        """Clamp max_tokens to GATEWAY_MAX_TOKENS_CAP (default 4096).

        Set ``GATEWAY_MAX_TOKENS_CAP=0`` to disable the cap.
        """
        cap = int(os.getenv("GATEWAY_MAX_TOKENS_CAP", "4096"))
        resolved = max_tokens if max_tokens is not None else 4096
        if cap <= 0:
            return resolved
        return min(resolved, cap)

    @staticmethod
    def _is_anthropic_model(model: str) -> bool:
        """Classify a model as Anthropic (Claude family) for provider-routing.

        OpenRouter prefixes Anthropic models with ``anthropic/``; native
        Anthropic SDK model IDs start with ``claude-``.  We treat both as
        the Anthropic provider.
        """
        m = (model or "").lower()
        return m.startswith("anthropic/") or m.startswith("claude-")

    def _record_provider_error(self, provider: str, error: bool) -> None:
        """Bump the per-provider error/ok counter.

        Args:
            provider: ``"openai"`` or ``"anthropic"`` (or any provider
                label the caller wants to track).
            error: True for a failed call, False for a successful one.
        """
        key = f"{provider}.{'error' if error else 'ok'}"
        self._provider_errors[key] = self._provider_errors.get(key, 0) + 1
        self._provider_calls[provider] = self._provider_calls.get(provider, 0) + 1

    def _record_prompt_cache_metrics(self, usage: UsageStats) -> None:
        """Bump upstream prompt-cache counters after a real network response."""
        self._upstream_llm_requests += 1
        reads = int(usage.cache_reads or 0)
        writes = int(usage.cache_writes or 0)
        self._prompt_cache_reads_tokens += reads
        self._prompt_cache_writes_tokens += writes
        if reads > 0:
            self._prompt_cache_hits += 1
        discount = usage.cache_discount
        if discount:
            self._prompt_cache_discount_usd += float(discount)

        if _PROMPT_CACHE_READS_TOKENS is not None and reads:
            _PROMPT_CACHE_READS_TOKENS.inc(reads)
        if _PROMPT_CACHE_WRITES_TOKENS is not None and writes:
            _PROMPT_CACHE_WRITES_TOKENS.inc(writes)
        if _PROMPT_CACHE_HITS is not None and reads > 0:
            _PROMPT_CACHE_HITS.inc()
        if _PROMPT_CACHE_DISCOUNT_USD is not None and discount:
            _PROMPT_CACHE_DISCOUNT_USD.inc(float(discount))

    async def acall(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """Async LLM call with retry and circuit breaker.

        Routes through the same :meth:`call` path (which handles
        the in-process LRU cache, prompt caching for Claude, and
        the canonical retry loop) by dispatching to an executor.
        This is the simplest way to keep :meth:`acall` and
        :meth:`call` in lock-step on cache hits + cache_control
        behaviour — maintaining two parallel retry loops was
        the previous source of "the cache works in tests but not
        in production async" drift.
        """
        if self.circuit_breaker.is_open(agent):
            raise CircuitOpenError(f"Circuit breaker open for agent: {agent}")
        import asyncio

        # ``asyncio.to_thread``, NOT ``loop.run_in_executor``.
        #
        # run_in_executor does not propagate contextvars, so the
        # cost-attribution context set by ``cost_ledger.cost_context``
        # was empty inside the thread. ``_log_usage`` runs in there, and
        # ``schedule_record_from_usage`` returns early on
        # ``if not oid`` — so every async LLM call was booked against no
        # org, i.e. dropped. to_thread copies the context across.
        #
        # This alone is not sufficient: no worker thread has a running
        # loop, so the write still had nowhere to be scheduled. See
        # ``cost_ledger.bind_event_loop`` for that half.
        return await asyncio.to_thread(
            lambda: self.call(
                agent=agent, prompt=prompt, slot=slot,
                system_prompt=system_prompt, **kwargs,
            ),
        )

    def call(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: str | None = None,
        model: str | None = None,
        **kwargs: Any,
    ) -> LLMResponse:
        """Make an LLM call with retry and circuit breaker.

        **Internal transport only** — feature code should call
        :mod:`eden.llm.internal_router` (``route_sync`` / ``route_async``)
        so tier selection goes through :class:`ModelRouter`.

        ``model`` is an optional override — when provided, the
        client uses exactly that model (no slot fallback chain).
        The model_router passes ``model`` per tier to pick a
        specific model within a tier without losing the retry
        + circuit breaker wrapping.
        """
        # Lazy-resolve openai exception types (audit 2026-07-06).
        # The first call pays the import; subsequent calls reuse the
        # module-level cache. Avoids ~200ms on the import path.
        _ensure_openai()

        if self.circuit_breaker.is_open(agent):
            raise CircuitOpenError(f"Circuit breaker open for agent: {agent}")

        # ``_make_request`` already declares ``max_tokens`` in its
        # signature; pop it out of kwargs so the ``**kwargs`` spread
        # below doesn't pass it twice (TypeError at request time).
        max_tokens = kwargs.pop("max_tokens", None)
        # Same for ``model`` — the explicit parameter above takes
        # precedence; the kwargs spread below would double-pass it.
        kwargs.pop("model", None)

        if model is not None:
            all_models = [model]
            # Even when the caller pins a specific model, we
            # still want a sensible ``max_tokens`` default —
            # the cache key includes it (see ``_make_request``
            # → ``_cache_key``) so a ``None`` would hash
            # differently from a real number and silently
            # bypass every existing cache entry built before
            # the model override. Pick from the slot's tier
            # config so ``acall(slot="reasoning", model="anthropic/...")``
            # and ``call(slot="reasoning", max_tokens=4096)``
            # both hash to the same cache slot.
            if max_tokens is None:
                _, max_tokens = self._models_and_tokens_for_slot(slot)
        else:
            all_models, slot_max_tokens = self._models_and_tokens_for_slot(slot)
            if max_tokens is None:
                max_tokens = slot_max_tokens

        max_tokens = self._clamp_max_tokens(max_tokens)

        last_error = None
        # Lazy-resolve openai exception classes (audit 2026-07-06).
        # Bound as locals so the ``except`` clauses below can name
        # them. The first call pays the import; subsequent calls
        # hit the module-level cache. Uses ``getattr`` on the
        # module so PEP 562 __getattr__ is consulted and
        # ``patch("eden.llm.client.RateLimitError")`` is respected.
        import sys as _sys
        _this_mod = _sys.modules[__name__]
        RateLimitError = getattr(_this_mod, "RateLimitError")  # noqa: B009, N806
        APITimeoutError = getattr(_this_mod, "APITimeoutError")  # noqa: B009, N806
        APIError = getattr(_this_mod, "APIError")  # noqa: B009, N806

        for model in all_models:
            for attempt in range(self.max_retries):
                try:
                    response = self._make_request(
                        model=model,
                        prompt=prompt,
                        system_prompt=system_prompt,
                        max_tokens=max_tokens,
                        **kwargs,
                    )
                    self.circuit_breaker.record_success(agent)
                    self._log_usage(response)
                    self._record_provider_error(
                        "anthropic" if self._is_anthropic_model(model) else "openai",
                        error=False,
                    )
                    return response
                except (RateLimitError, APITimeoutError) as e:
                    last_error = e
                    self._record_provider_error(
                        "anthropic" if self._is_anthropic_model(model) else "openai",
                        error=True,
                    )
                    if attempt < self.max_retries - 1:
                        # Cap exponential backoff so a deeply broken
                        # provider can't stall a worker thread for
                        # 8-16s per retry (matches async path's
                        # ``min(2**attempt, 4)`` cap).
                        time.sleep(min(2**attempt, 4))
                    continue
                except APIError as e:
                    last_error = e
                    if e.status_code in (401, 400):
                        # 4xx errors propagate immediately and still
                        # bump the per-provider counter so the §11.4
                        # dashboard can see client-side bad-request rate.
                        self._record_provider_error(
                            "anthropic" if self._is_anthropic_model(model) else "openai",
                            error=True,
                        )
                        raise
                    self._record_provider_error(
                        "anthropic" if self._is_anthropic_model(model) else "openai",
                        error=True,
                    )
                    if attempt < self.max_retries - 1:
                        # Cap exponential backoff so a deeply broken
                        # provider can't stall a worker thread for
                        # 8-16s per retry (matches async path's
                        # ``min(2**attempt, 4)`` cap).
                        time.sleep(min(2**attempt, 4))
                    continue

        self.circuit_breaker.record_failure(agent)
        raise MaxRetriesExceededError(
            f"All models failed for agent {agent} after {self.max_retries} attempts: {last_error}"
        )

    def _cache_key(self, model: str, prompt: str,
                    system_prompt: str | None,
                    max_tokens: int,
                    **kwargs: Any) -> str:
        """Build a deterministic cache key for an LLM call.

        Hashes (model, prompt, system_prompt, max_tokens,
        temperature) into a SHA256 hex digest. ``temperature``
        is included so the same prompt at two different
        sampling temperatures gets different cache slots;
        however the caller (``_make_request``) short-circuits
        the cache entirely for non-zero temperatures — see
        the inline note there for the rationale.
        """
        import hashlib
        normalized_prompt = " ".join((prompt or "").split())
        normalized_system = (
            " ".join((system_prompt or "").split()) if system_prompt else ""
        )
        temp = kwargs.get("temperature", 0)
        content = (
            f"{model}|{normalized_prompt}|{normalized_system}|"
            f"{max_tokens}|{temp}"
        )
        return hashlib.sha256(content.encode("utf-8")).hexdigest()

    def _cache_get(self, key: str) -> "LLMResponse | None":
        """Return a cached response if present and fresh.

        Also handles LRU eviction: moves the accessed entry to
        the end so it's the least-recently-used on the next
        eviction pass.
        """
        if not self._in_process_cache_enabled:
            return None
        cached = self._in_process_cache.get(key)
        if cached is None:
            self._cache_misses += 1
            if _INPROCESS_CACHE_MISSES is not None:
                _INPROCESS_CACHE_MISSES.inc()
            return None
        expires_at, response = cached
        if time.monotonic() >= expires_at:
            # Expired — drop and treat as miss.
            self._in_process_cache.pop(key, None)
            self._cache_misses += 1
            if _INPROCESS_CACHE_MISSES is not None:
                _INPROCESS_CACHE_MISSES.inc()
            return None
        # Move to end (most-recently-used).
        self._in_process_cache.move_to_end(key)
        self._cache_hits += 1
        if _INPROCESS_CACHE_HITS is not None:
            _INPROCESS_CACHE_HITS.inc()
        return response

    def _cache_put(self, key: str, response: "LLMResponse") -> None:
        """Insert a response into the cache with TTL, evicting LRU."""
        if not self._in_process_cache_enabled:
            return
        expires_at = time.monotonic() + self._in_process_cache_ttl
        self._in_process_cache[key] = (expires_at, response)
        # Evict oldest entries until we're under the size cap.
        while len(self._in_process_cache) > self._in_process_cache_max:
            self._in_process_cache.popitem(last=False)

    def _make_request(
        self,
        model: str,
        prompt: str,
        system_prompt: str | None = None,
        max_tokens: int = 4096,
        **kwargs: Any,
    ) -> LLMResponse:
        """Make a single request to OpenRouter."""
        max_tokens = self._clamp_max_tokens(max_tokens)
        # In-process LRU cache: same (model, prompt, system,
        # max_tokens, temperature) within the TTL window
        # returns the cached response without hitting the
        # network. Disabled by default — opt in via
        # ``EDEN_LLM_INPROCESS_CACHE=1``.
        #
        # Skip caching for non-deterministic calls (temperature > 0):
        # every call would return a different answer, so caching
        # would just bloat the LRU with entries that can never
        # be served. Saves memory + the SHA256 + dict-lookup
        # cost on every stochastic call.
        _temp = float(kwargs.get("temperature", 0) or 0)
        _cache_eligible = self._in_process_cache_enabled and _temp == 0
        if _cache_eligible:
            cache_key = self._cache_key(
                model, prompt, system_prompt, max_tokens, **kwargs,
            )
            cached = self._cache_get(cache_key)
            if cached is not None:
                return cached

        messages = []
        if system_prompt:
            sys_content: Any = system_prompt
            # Anthropic prompt caching: mark the system prompt as
            # cacheable so the second+ call within the cache TTL
            # gets a 90% discount on prompt tokens. OpenRouter
            # forwards ``cache_control`` to the Anthropic backend
            # (see OpenRouter docs: prompt caching for Claude
            # models). We only do this for Claude models because
            # the field is a no-op on OpenAI and we don't want
            # to leak Anthropic-specific request shapes to GPT.
            if self._is_anthropic_model(model):
                sys_content = [
                    {
                        "type": "text",
                        "text": system_prompt,
                        "cache_control": {"type": "ephemeral"},
                    },
                ]
            messages.append({"role": "system", "content": sys_content})
        messages.append({"role": "user", "content": prompt})

        extra_headers = {}
        if "structured-outputs" in kwargs:
            extra_headers["x-open-router-beta"] = "structured-outputs-2025-11-13"

        response = self.client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            extra_headers=extra_headers if extra_headers else None,
            **kwargs,
        )

        cache_reads, cache_writes = _cache_tokens_from_usage(response.usage)
        usage = UsageStats(
            prompt_tokens=response.usage.prompt_tokens if response.usage else 0,
            completion_tokens=response.usage.completion_tokens if response.usage else 0,
            total_tokens=response.usage.total_tokens if response.usage else 0,
            cost=getattr(response.usage, "cost", None),
            cache_discount=getattr(response, "cache_discount", None),
            cache_reads=cache_reads,
            cache_writes=cache_writes,
        )

        result = LLMResponse(
            content=response.choices[0].message.content or "",
            usage=usage,
            model=model,
            finish_reason=response.choices[0].finish_reason or "unknown",
            raw_response=response,
        )
        self._record_prompt_cache_metrics(usage)
        # Stash in the in-process cache for the next identical
        # call within the TTL window. Skipped for non-deterministic
        # (temperature > 0) calls — see _make_request.
        if _cache_eligible:
            self._cache_put(cache_key, result)
        return result

    def _log_usage(self, response: LLMResponse) -> None:
        """Log usage for cost tracking + customer CostEvent write-through."""
        self._usage_log.append(response.usage)
        logger.debug(
            f"LLM call: model={response.model}, "
            f"tokens={response.usage.total_tokens}, "
            f"cost={response.usage.cost}"
        )
        try:
            from eden.llmops.cost_ledger import schedule_record_from_usage

            schedule_record_from_usage(
                model=response.model or "unknown",
                prompt_tokens=int(response.usage.prompt_tokens or 0),
                completion_tokens=int(response.usage.completion_tokens or 0),
                total_tokens=int(response.usage.total_tokens or 0),
                cost_usd=float(response.usage.cost)
                if response.usage.cost is not None
                else None,
                cache_reads=int(response.usage.cache_reads or 0),
                cache_writes=int(response.usage.cache_writes or 0),
                cache_discount_usd=(
                    float(response.usage.cache_discount)
                    if response.usage.cache_discount is not None
                    else None
                ),
            )
        except Exception as exc:
            logger.debug("OpenRouterClient cost ledger write-through failed: %s", exc)

    def get_total_usage(self) -> UsageStats:
        """Get aggregated usage statistics."""
        total = UsageStats()
        for usage in self._usage_log:
            total.prompt_tokens += usage.prompt_tokens
            total.completion_tokens += usage.completion_tokens
            total.total_tokens += usage.total_tokens
            if usage.cost:
                total.cost = (total.cost or 0) + usage.cost
            if usage.cache_discount:
                total.cache_discount = (total.cache_discount or 0) + usage.cache_discount
            total.cache_reads += usage.cache_reads
            total.cache_writes += usage.cache_writes
        return total

    def get_circuit_status(self, agent: str) -> dict:
        """Get circuit breaker status for an agent."""
        return self.circuit_breaker.get_status(agent)


class CircuitOpenError(Exception):
    """Raised when circuit breaker is open."""
    pass


class MaxRetriesExceededError(Exception):
    """Raised when all retry attempts are exhausted."""
    pass


@lru_cache
def get_llm_client() -> OpenRouterClient:
    """Get cached LLM client instance."""
    settings = get_settings()
    return OpenRouterClient(
        api_key=settings.openrouter_api_key,
        base_url=settings.openrouter_base_url,
        max_retries=settings.max_retries,
        circuit_breaker_threshold=settings.circuit_breaker_threshold,
        circuit_breaker_timeout=settings.circuit_breaker_timeout,
    )


# Backward-compat alias: some tests + downstream callers still reference
# the underscore-prefixed name that pre-dated the public rename.
_get_llm_client = get_llm_client


def get_provider_error_counts() -> dict[str, dict[str, float]]:
    """§11.4 — per-provider error rate snapshot from the singleton client.

    Returns ``{provider: {"calls": int, "errors": int, "error_rate": float}}``
    for every provider that has had at least one call. Returns an empty
    dict if no calls have been made (so the §11.4 dashboard can render
    a zero-state without a KeyError).
    """
    # Use the underscore-prefixed name so tests that patch
    # ``eden.llm.client._get_llm_client`` correctly intercept the call
    # (the public name is a separate attribute slot).
    client = _get_llm_client()
    out: dict[str, dict[str, float]] = {}
    for provider, calls in client._provider_calls.items():
        errors = client._provider_errors.get(f"{provider}.error", 0)
        rate = (errors / calls) if calls else 0.0
        out[provider] = {
            "calls": calls,
            "errors": errors,
            "error_rate": rate,
        }
    return out


def get_prompt_cache_stats() -> dict[str, float]:
    """OPT-36 — upstream + in-process prompt-cache snapshot from the singleton.

    Returns cumulative counters and derived hit rates so operators can verify
    cache effectiveness via ``/metrics`` or this helper without scraping.
    """
    client = _get_llm_client()
    reads = float(client._prompt_cache_reads_tokens)
    writes = float(client._prompt_cache_writes_tokens)
    hits = float(client._prompt_cache_hits)
    requests = float(client._upstream_llm_requests)
    token_den = reads + writes
    return {
        "prompt_cache_reads_tokens": reads,
        "prompt_cache_writes_tokens": writes,
        "prompt_cache_hits": hits,
        "upstream_llm_requests": requests,
        "prompt_cache_discount_usd": float(client._prompt_cache_discount_usd),
        "inprocess_cache_hits": float(client._cache_hits),
        "inprocess_cache_misses": float(client._cache_misses),
        "token_hit_rate": (reads / token_den) if token_den > 0 else 0.0,
        "request_hit_rate": (hits / requests) if requests > 0 else 0.0,
    }


# =============================================================================
# Routing layer — W4-1 consolidation from eden.optimization.model_router
#
# External callers import from eden.optimization.model_router (thin re-export
# shim).  Moving here eliminates the separate module and allows
# _models_and_tokens_for_slot to reference TIER_MODELS without a cross-package
# lazy import.
#
# Dead code stripped vs. the original model_router:
#   - TaskClassifier._llm_classify  (dead: T1/T2/T3 share one model since
#     the 2026-08 DeepSeek collapse → _chat_tiers_share_model() always True)
#   - TaskClassifier._record_routing  (dead: guard returns immediately)
#   - ModelRouter._get_fallback_chain (dead: tiers_to_try always len-1)
#   - Dead branch in classify() for non-shared tiers
# Preserved: OOM W4-3 model_override, W2-11 lazy OpenRouterClient import.
# =============================================================================

import ast as _ast  # noqa: E402 — added for routing layer

from eden.llm.models import internal_chat_chain as _internal_chat_chain  # noqa: E402


class ModelTier(Enum):
    """Model tier definitions with cost/quality tradeoffs."""

    T1 = "t1"  # Fast/cheap: classification, extraction, simple formatting
    T2 = "t2"  # Standard: code generation, test writing, reasoning
    T3 = "t3"  # Expert: complex architecture, novel patterns, adversarial design
    T4 = "t4"  # Custom/enterprise: proprietary, compliance, offline


# Tier-to-model mapping.  Soft Autonomy 2026-08-01: ALL Eden-owned chat tiers
# resolve to the single internal model SSOT (deepseek-v4-flash-0731).
# T4 stays a placeholder for customer fine-tunes and is never an Eden target.
_ROUTING_CHAIN = _internal_chat_chain()
TIER_MODELS: dict[ModelTier, list[str]] = {
    ModelTier.T1: list(_ROUTING_CHAIN),
    ModelTier.T2: list(_ROUTING_CHAIN),
    ModelTier.T3: list(_ROUTING_CHAIN),
    ModelTier.T4: ["custom/fine-tuned"],
}


def _chat_tiers_share_model() -> bool:
    """True when T1/T2/T3 primary models are identical.

    Soft Autonomy keeps all three on ``INTERNAL_CHAT_MODEL``.  If any tier
    primary ever diverges, full routing behaviour resumes automatically.
    """
    primaries: list[str | None] = []
    for t in (ModelTier.T1, ModelTier.T2, ModelTier.T3):
        models = TIER_MODELS.get(t)
        primaries.append(models[0] if models else None)
    return primaries[0] is not None and primaries[0] == primaries[1] == primaries[2]


@dataclass
class PipelineTask:
    """Description of a pipeline task for routing classification."""

    agent: str
    description: str
    slot: str = "reasoning"
    output_type: str = "text"  # text | code | json
    requires_novelty: bool = False
    expected_min_length: int = 50
    required_format: str | None = None
    requires_quality_check: bool = True
    system_prompt: str | None = None
    org_id: str | None = None
    job_id: str | None = None
    user_id: str | None = None
    # OOM W4-3: when non-empty, bypass tier selection and force this model.
    model_override: str = ""


@dataclass
class ClassificationResult:
    """Result of task classification."""

    tier: ModelTier
    complexity: float = 0.0
    novelty: float = 0.0
    reasoning_depth: float = 0.0
    domain_expertise: float = 0.0
    confidence: float = 0.0
    heuristic_used: bool = False


@dataclass
class ValidationResult:
    """Result of quality validation."""

    passed: bool
    reason: str = ""
    quality_score: float | None = None
    tier_used: ModelTier | None = None


class TaskClassifier:
    """Classifies pipeline tasks to the optimal model tier via heuristics.

    W4-1: LLM-based classify path removed — T1/T2/T3 share one model since
    the DeepSeek collapse (``_chat_tiers_share_model()`` always True), so LLM
    classification burns tokens without changing routing outcomes.
    """

    # Agents that are always simple / extraction-oriented
    SIMPLE_AGENTS: set[str] = {"format", "extract", "classify", "summarize"}

    # M14 (§8.2): agents whose callers MUST pass ``slot="fast"`` so the
    # heuristic below short-circuits to T1.  Routing assertion tests lock
    # these — a classifier change must not silently upgrade critic/triage.
    PINNED_FAST_AGENTS: set[str] = {
        "patch_critic",
        "autonomous_investigation",
    }

    # Agents that are always complex / reasoning-heavy
    COMPLEX_AGENTS: set[str] = {
        "planner",
        "critic",
        "archivist",
        "adversarial_tester",
    }

    # Code agents that may vary in complexity
    CODE_AGENTS: set[str] = {
        "executor", "refiner", "verifier", "tester", "code_quality",
    }

    def __init__(self, llm_client: "OpenRouterClient | None" = None):
        self.llm_client = llm_client
        self._heuristic_hits = 0
        self._llm_classifications = 0  # always 0 post-W4-1; kept for compat

    async def classify(self, task: PipelineTask) -> ClassificationResult:
        """Classify a task; always uses heuristic path (tiers share model)."""
        heuristic_tier = self._heuristic_classify(task) or ModelTier.T2
        self._heuristic_hits += 1
        return ClassificationResult(
            tier=heuristic_tier,
            complexity=0.3 if heuristic_tier == ModelTier.T1 else 0.6,
            novelty=0.2,
            reasoning_depth=0.3 if heuristic_tier == ModelTier.T1 else 0.7,
            domain_expertise=0.2,
            confidence=0.9,
            heuristic_used=True,
        )

    def _heuristic_classify(self, task: PipelineTask) -> ModelTier | None:
        """Fast heuristic classification without any LLM call."""
        agent = task.agent.lower()
        slot = task.slot.lower()

        # Slot-based shortcuts
        if slot in ("fast", "extraction"):
            return ModelTier.T1
        if slot == "reasoning" and agent in self.SIMPLE_AGENTS:
            return ModelTier.T1

        # Agent-based shortcuts
        if agent in self.SIMPLE_AGENTS:
            return ModelTier.T1
        if agent in self.COMPLEX_AGENTS:
            return ModelTier.T3 if task.requires_novelty else ModelTier.T2
        if agent in self.CODE_AGENTS:
            if len(task.description) < 200 and not task.requires_novelty:
                return ModelTier.T1
            return ModelTier.T2

        # Output-type shortcuts
        if task.output_type == "code" and len(task.description) < 150:
            return ModelTier.T1
        if task.output_type in ("json", "format"):
            return ModelTier.T1

        return None  # ambiguous — caller defaults to T2

    def get_stats(self) -> dict:
        """Return classification statistics."""
        total = self._heuristic_hits + self._llm_classifications
        return {
            "heuristic_hits": self._heuristic_hits,
            "llm_classifications": self._llm_classifications,
            "heuristic_rate": round(self._heuristic_hits / total, 4) if total else 0.0,
        }


class QualityValidator:
    """Validates LLM responses for quality before acceptance."""

    def __init__(self, llm_client: "OpenRouterClient | None" = None):
        self.llm_client = llm_client

    def validate_sync(
        self,
        response: "LLMResponse",
        task: PipelineTask,
        tier: ModelTier | None = None,
    ) -> ValidationResult:
        """Synchronous validation (no LLM judge)."""
        content = response.content
        if task.output_type == "code":
            try:
                _ast.parse(content)
            except SyntaxError as e:
                return ValidationResult(
                    passed=False, reason=f"syntax_error: {e.msg}", tier_used=tier,
                )
        if len(content) < task.expected_min_length:
            return ValidationResult(passed=False, reason="incomplete", tier_used=tier)
        if task.required_format and not self._check_format(content, task.required_format):
            return ValidationResult(passed=False, reason="format_mismatch", tier_used=tier)
        return ValidationResult(passed=True, tier_used=tier)

    async def validate(
        self,
        response: "LLMResponse",
        task: PipelineTask,
        tier: ModelTier | None = None,
    ) -> ValidationResult:
        """Async validation (may call LLM judge when tiers differ in model)."""
        content = response.content
        if task.output_type == "code":
            try:
                _ast.parse(content)
            except SyntaxError as e:
                return ValidationResult(
                    passed=False, reason=f"syntax_error: {e.msg}", tier_used=tier,
                )
        if len(content) < task.expected_min_length:
            return ValidationResult(passed=False, reason="incomplete", tier_used=tier)
        if task.required_format and not self._check_format(content, task.required_format):
            return ValidationResult(passed=False, reason="format_mismatch", tier_used=tier)
        # LLM quality judge — skipped when T1=T2=T3 share a model because
        # escalation cannot improve quality by switching to a different model.
        if (
            task.requires_quality_check
            and len(content) > 100
            and not _chat_tiers_share_model()
        ):
            quality_score = await self._judge_quality(content, task)
            if quality_score is not None and quality_score < 0.7:
                return ValidationResult(
                    passed=False,
                    reason=f"quality_score_{quality_score:.2f}",
                    quality_score=quality_score,
                    tier_used=tier,
                )
            return ValidationResult(passed=True, quality_score=quality_score, tier_used=tier)
        return ValidationResult(passed=True, tier_used=tier)

    def _check_format(self, content: str, required_format: str) -> bool:
        import json as _json
        rf = required_format.lower()
        if rf == "json":
            try:
                _json.loads(content)
                return True
            except _json.JSONDecodeError:
                return False
        if rf == "python":
            try:
                _ast.parse(content)
                return True
            except SyntaxError:
                return False
        if rf == "markdown":
            return "#" in content or "```" in content
        return True

    async def _judge_quality(self, content: str, task: PipelineTask) -> float | None:
        """Lightweight LLM quality judge (only called when tiers use different models)."""
        if self.llm_client is None:
            return None
        judge_prompt = (
            "Rate the quality of this AI-generated output on a scale of 0.0 to 1.0.\n\n"
            f"Task: {task.description[:300]}\n\nOutput:\n{content[:800]}\n\n"
            "Respond with ONLY a number between 0.0 and 1.0."
        )
        try:
            resp = self.llm_client.call(
                agent="quality_judge", prompt=judge_prompt, slot="fast", max_tokens=10,
            )
            return max(0.0, min(1.0, float(resp.content.strip().split()[0])))
        except Exception:
            return None


def _resolve_cost_attribution(
    task: PipelineTask,
    *,
    org_id: str | None,
    user_id: str | None,
    feature: str | None,
    kwargs: dict,
) -> tuple[str | None, str | None, str]:
    """Resolve org/user/feature for ``cost_context`` (OPT-18)."""
    oid = org_id if org_id is not None else task.org_id
    uid = user_id if user_id is not None else task.user_id
    feat = feature if feature is not None else kwargs.pop("feature", None)
    return oid, uid, (feat or "unknown").lower()


_TIER_ORDER: dict[ModelTier, int] = {
    ModelTier.T1: 1,
    ModelTier.T2: 2,
    ModelTier.T3: 3,
    ModelTier.T4: 4,
}


class ModelRouter:
    """Routes LLM requests through tiered fallback with quality validation.

    W4-1: ``_get_fallback_chain`` removed (dead since T1=T2=T3 share model;
    ``tiers_to_try`` is always length-1).
    OOM W4-3: ``task.model_override`` bypasses tier selection entirely.
    """

    def __init__(
        self,
        llm_client: "OpenRouterClient | None" = None,
        classifier: TaskClassifier | None = None,
        validator: QualityValidator | None = None,
    ):
        self.settings = get_settings()
        self.llm_client = llm_client or OpenRouterClient()
        self.classifier = classifier or TaskClassifier(llm_client=self.llm_client)
        self.validator = validator or QualityValidator(llm_client=self.llm_client)
        self._calls_by_tier: dict[ModelTier, int] = {t: 0 for t in ModelTier}
        self._fallbacks = 0
        self._validation_failures = 0
        self._tokens_saved = 0  # always 0 when tiers share model; kept for compat

    def route(
        self,
        task: PipelineTask,
        prompt: str,
        system_prompt: str | None = None,
        org_id: str | None = None,
        user_id: str | None = None,
        feature: str | None = None,
        **kwargs: Any,
    ) -> "LLMResponse":
        """Route an LLM request synchronously through the tiered fallback chain."""
        from eden.llmops.cost_ledger import cost_context

        oid, uid, feat = _resolve_cost_attribution(
            task, org_id=org_id, user_id=user_id, feature=feature, kwargs=kwargs,
        )
        # OOM W4-3: model_override skips tier selection.
        if task.model_override:
            with cost_context(oid, feat, agent_id=task.agent, user_id=uid):
                return self.llm_client.call(
                    agent=task.agent, prompt=prompt, slot="reasoning",
                    system_prompt=system_prompt, model=task.model_override, **kwargs,
                )

        classification = self.classifier._heuristic_classify(task)
        start_tier = ModelTier.T2 if classification is None else classification
        # T1/T2/T3 share one model → no escalation value; try single tier.
        tiers_to_try = [start_tier]
        last_error: str | None = None

        for tier in tiers_to_try:
            self._calls_by_tier[tier] += 1
            for model in self._get_models_for_tier(tier):
                try:
                    with cost_context(oid, feat, agent_id=task.agent, user_id=uid):
                        response = self.llm_client.call(
                            agent=task.agent, prompt=prompt, slot="reasoning",
                            system_prompt=system_prompt, model=model, **kwargs,
                        )
                    validation = self.validator.validate_sync(response, task, tier)
                    if validation.passed:
                        return response
                    self._validation_failures += 1
                    last_error = validation.reason
                    logger.info(
                        "Validation failed for %s at %s: %s",
                        task.agent, tier.value, validation.reason,
                    )
                except Exception as e:
                    last_error = str(e)
                    logger.warning("Model %s failed for %s: %s", model, task.agent, e)
                    continue
            self._fallbacks += 1
            logger.info("Falling back from %s for %s", tier.value, task.agent)

        raise MaxRetriesExceededError(
            f"All model tiers failed for {task.agent}: {last_error}"
        )

    async def aroute(
        self,
        task: PipelineTask,
        prompt: str,
        system_prompt: str | None = None,
        org_id: str | None = None,
        user_id: str | None = None,
        feature: str | None = None,
        **kwargs: Any,
    ) -> "LLMResponse":
        """Async route with full classification and validation."""
        import asyncio

        from eden.llmops.cost_ledger import cost_context

        oid, uid, feat = _resolve_cost_attribution(
            task, org_id=org_id, user_id=user_id, feature=feature, kwargs=kwargs,
        )
        # OOM W4-3: model_override skips tier selection.
        if task.model_override:
            def _call_override() -> "LLMResponse":
                with cost_context(oid, feat, agent_id=task.agent, user_id=uid):
                    return self.llm_client.call(
                        agent=task.agent, prompt=prompt, slot="reasoning",
                        system_prompt=system_prompt, model=task.model_override, **kwargs,
                    )
            return await asyncio.to_thread(_call_override)

        classification = await self.classifier.classify(task)
        start_tier = classification.tier
        # T1/T2/T3 share one model → no escalation value; try single tier.
        # ``to_thread`` (not ``run_in_executor``) preserves contextvars so
        # cost attribution survives into the worker thread (S-21 / OPT-18).
        tiers_to_try = [start_tier]
        last_error: str | None = None

        for tier in tiers_to_try:
            self._calls_by_tier[tier] += 1
            for model in self._get_models_for_tier(tier):
                try:
                    def _call_routed(m: str = model) -> "LLMResponse":
                        with cost_context(oid, feat, agent_id=task.agent, user_id=uid):
                            return self.llm_client.call(
                                agent=task.agent, prompt=prompt, slot="reasoning",
                                system_prompt=system_prompt, model=m, **kwargs,
                            )
                    response = await asyncio.to_thread(_call_routed)
                    validation = await self.validator.validate(response, task, tier)
                    if validation.passed:
                        return response
                    self._validation_failures += 1
                    last_error = validation.reason
                    logger.info(
                        "Validation failed for %s at %s: %s",
                        task.agent, tier.value, validation.reason,
                    )
                except Exception as e:
                    last_error = str(e)
                    logger.warning("Model %s failed for %s: %s", model, task.agent, e)
                    continue
            self._fallbacks += 1
            logger.info("Falling back from %s for %s", tier.value, task.agent)

        raise MaxRetriesExceededError(
            f"All tiers exhausted for {task.agent}. Error: {last_error}"
        )

    def _get_models_for_tier(self, tier: ModelTier) -> list[str]:
        """Return the model chain for a tier (single SSOT: TIER_MODELS)."""
        return list(TIER_MODELS.get(tier, TIER_MODELS[ModelTier.T2]))

    def get_stats(self) -> dict:
        """Return routing statistics."""
        total_calls = sum(self._calls_by_tier.values())
        return {
            "calls_by_tier": {t.value: c for t, c in self._calls_by_tier.items()},
            "total_calls": total_calls,
            "fallbacks": self._fallbacks,
            "validation_failures": self._validation_failures,
            "tokens_saved": self._tokens_saved,
            "fallback_rate": round(self._fallbacks / total_calls, 4) if total_calls else 0.0,
            "classifier_stats": self.classifier.get_stats(),
        }
