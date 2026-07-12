"""OpenRouter LLM client with retry logic, circuit breaker, and cost tracking."""

import logging
import os
import time
from collections import OrderedDict, defaultdict, deque
from dataclasses import dataclass, field
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


def _ensure_openai():
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


def __getattr__(name: str):
    """PEP 562 module-level __getattr__ — resolve the openai
    symbols lazily on first attribute access. ``patch(
    "eden.llm.client.OpenAI")`` still works because unittest.mock
    uses __getattr__ under the hood."""
    if name in ("OpenAI", "AsyncOpenAI", "APIError", "APITimeoutError", "RateLimitError"):
        return _ensure_openai()[name]
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")

from eden.config import get_settings  # noqa: E402

logger = logging.getLogger(__name__)


class CircuitState(Enum):
    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half_open"


@dataclass
class ModelSlot:
    """Model configuration for a task type."""

    primary: str
    fallback: list[str] = field(default_factory=list)
    max_tokens: int = 4096
    supports_caching: bool = True


@dataclass
class UsageStats:
    """Token usage statistics for a request."""

    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    cost: float | None = None
    cache_reads: int = 0
    cache_writes: int = 0


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
        self.client = OpenAI(
            api_key=api_key or self.settings.openrouter_api_key,
            base_url=base_url,
        )
        # Async client for the ``acall`` path. Kept as a separate
        # attribute so tests can mock sync + async independently
        # (the async mock needs ``create`` to be an ``AsyncMock``).
        self.async_client = AsyncOpenAI(
            api_key=api_key or self.settings.openrouter_api_key,
            base_url=base_url,
        )
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
        # §11.4 — per-provider error counters split by openai vs anthropic
        # so the observability dashboard can break them out by provider.
        self._provider_errors: dict[str, int] = {}
        self._provider_calls: dict[str, int] = {}
        self.MODEL_SLOTS: dict[str, ModelSlot] = {
            "reasoning": ModelSlot(
                primary=self.settings.model_reasoning,
                fallback=[self.settings.model_fallback],
                max_tokens=self.settings.max_tokens_planner,
            ),
            "code": ModelSlot(
                primary=self.settings.model_code,
                fallback=[self.settings.model_fallback],
                max_tokens=self.settings.max_tokens_executor,
            ),
            "fast": ModelSlot(
                primary=self.settings.model_fast,
                fallback=[self.settings.model_fallback],
                max_tokens=self.settings.max_tokens_critic,
            ),
            "extraction": ModelSlot(
                # ``extraction`` runs fact-checking + structured output
                # over already-fetched content — the cheap, fast model
                # is sufficient and 10× cheaper than Sonnet.
                primary=self.settings.model_fast,
                fallback=[self.settings.model_fallback],
                max_tokens=self.settings.max_tokens_fact_checker,
            ),
        }

    def get_model_for_slot(self, slot: str) -> str:
        """Get the primary model for a slot from config."""
        config = self.MODEL_SLOTS.get(slot, self.MODEL_SLOTS["reasoning"])
        return config.primary

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

    async def acall(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: str | None = None,
        **kwargs,
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
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None,
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
        **kwargs,
    ) -> LLMResponse:
        """Make an LLM call with retry and circuit breaker.

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
            # the model override. Pick from the slot's config
            # so ``acall(slot="reasoning", model="anthropic/...")``
            # and ``call(slot="reasoning", max_tokens=4096)``
            # both hash to the same cache slot.
            if max_tokens is None:
                slot_config = self.MODEL_SLOTS.get(
                    slot, self.MODEL_SLOTS["reasoning"],
                )
                max_tokens = slot_config.max_tokens
        else:
            model_config = self.MODEL_SLOTS.get(
                slot, self.MODEL_SLOTS["reasoning"]
            )
            all_models = [model_config.primary] + model_config.fallback
            if max_tokens is None:
                max_tokens = model_config.max_tokens

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
            return None
        expires_at, response = cached
        if time.monotonic() >= expires_at:
            # Expired — drop and treat as miss.
            self._in_process_cache.pop(key, None)
            self._cache_misses += 1
            return None
        # Move to end (most-recently-used).
        self._in_process_cache.move_to_end(key)
        self._cache_hits += 1
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
        **kwargs,
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

        usage = UsageStats(
            prompt_tokens=response.usage.prompt_tokens if response.usage else 0,
            completion_tokens=response.usage.completion_tokens if response.usage else 0,
            total_tokens=response.usage.total_tokens if response.usage else 0,
            cost=getattr(response.usage, "cost", None),
            cache_reads=getattr(response.usage, "cache_reads", 0) or 0,
            cache_writes=getattr(response.usage, "cache_writes", 0) or 0,
        )

        result = LLMResponse(
            content=response.choices[0].message.content or "",
            usage=usage,
            model=model,
            finish_reason=response.choices[0].finish_reason or "unknown",
            raw_response=response,
        )
        # Stash in the in-process cache for the next identical
        # call within the TTL window. Skipped for non-deterministic
        # (temperature > 0) calls — see _make_request.
        if _cache_eligible:
            self._cache_put(cache_key, result)
        return result

    def _log_usage(self, response: LLMResponse) -> None:
        """Log usage for cost tracking."""
        self._usage_log.append(response.usage)
        logger.debug(
            f"LLM call: model={response.model}, "
            f"tokens={response.usage.total_tokens}, "
            f"cost={response.usage.cost}"
        )

    def get_total_usage(self) -> UsageStats:
        """Get aggregated usage statistics."""
        total = UsageStats()
        for usage in self._usage_log:
            total.prompt_tokens += usage.prompt_tokens
            total.completion_tokens += usage.completion_tokens
            total.total_tokens += usage.total_tokens
            if usage.cost:
                total.cost = (total.cost or 0) + usage.cost
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
