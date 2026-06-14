"""OpenRouter LLM client with retry logic, circuit breaker, and cost tracking."""

import asyncio
import logging
import random
import time
from collections import defaultdict, deque
from dataclasses import dataclass, field
from enum import Enum
from functools import lru_cache
from typing import Any

from openai import APIError, APITimeoutError, AsyncOpenAI, OpenAI, RateLimitError

from eden.config import get_settings

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
    ) -> None:
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
        if self.state[agent] == CircuitState.OPEN:
            lock_until = self.half_open_lock_until.get(agent, 0)
            if time.time() < lock_until:
                # Hard lockout from repeated half-open failures.
                return True
            # Promote to HALF_OPEN only once the recovery_timeout has
            # elapsed since the last failure — otherwise we'd flip
            # to HALF_OPEN instantly and effectively never block
            # traffic, which defeats the purpose of a circuit breaker.
            last = self.last_failure_time.get(agent, 0)
            if time.time() - last < self.recovery_timeout:
                return True
            self.state[agent] = CircuitState.HALF_OPEN
            return False
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
        request_timeout: float = 60.0,
        usage_log_maxlen: int = 10_000,
    ) -> None:
        self.settings = get_settings()
        # Sync client — kept for the sync ``call`` path (e.g. Celery
        # workers, scripts) and for any downstream code that still
        # imports ``OpenRouterClient.client`` directly.
        self.client = OpenAI(
            api_key=api_key or self.settings.openrouter_api_key,
            base_url=base_url,
            timeout=request_timeout,
        )
        # Async client — the only path the FastAPI event loop uses
        # now (see :meth:`acall`). Owns its own ``httpx.AsyncClient``
        # connection pool; explicitly close it in lifespan shutdown
        # via :meth:`close_async` to avoid leaking sockets.
        self.async_client = AsyncOpenAI(
            api_key=api_key or self.settings.openrouter_api_key,
            base_url=base_url,
            timeout=request_timeout,
        )
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=circuit_breaker_threshold,
            recovery_timeout=circuit_breaker_timeout,
        )
        self.max_retries = max_retries
        # Bounded usage log so a long-lived client can't OOM. 10k
        # entries is ~1h of headroom at 3 RPS before the oldest
        # entries start to age out.
        self._usage_log: deque[UsageStats] = deque(maxlen=usage_log_maxlen)
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
                primary=self.settings.model_reasoning,
                fallback=[self.settings.model_fallback],
                max_tokens=self.settings.max_tokens_fact_checker,
            ),
        }

    @staticmethod
    def _is_anthropic_model(model: str) -> bool:
        """Classify a model as Anthropic (Claude family) for provider-routing."""
        m = (model or "").lower()
        return m.startswith("anthropic/") or m.startswith("claude-")

    def _record_provider_error(self, provider: str, error: bool) -> None:
        """Bump the per-provider error/ok counter."""
        key = f"{provider}.{'error' if error else 'ok'}"
        self._provider_errors[key] = self._provider_errors.get(key, 0) + 1
        self._provider_calls[provider] = self._provider_calls.get(provider, 0) + 1

    def get_model_for_slot(self, slot: str) -> str:
        """Get the primary model for a slot from config."""
        config = self.MODEL_SLOTS.get(slot, self.MODEL_SLOTS["reasoning"])
        return config.primary

    async def acall(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: str | None = None,
        **kwargs,
    ) -> LLMResponse:
        """Fully async LLM call with retry and circuit breaker.

        Unlike the previous implementation (which dispatched the
        sync :meth:`call` into a thread pool executor), this path
        never blocks the event loop. It uses ``AsyncOpenAI`` +
        ``asyncio.sleep`` + ``asyncio.timeout`` so a hung downstream
        request cannot exhaust the executor's threads.

        Forwards ``**kwargs`` (e.g. ``stream``, ``temperature``,
        ``tools``) to the underlying request — earlier revisions
        dropped them silently, which meant streaming callers got
        non-streaming behaviour with no warning.
        """
        if self.circuit_breaker.is_open(agent):
            raise CircuitOpenError(f"Circuit breaker open for agent: {agent}")

        model_config = self.MODEL_SLOTS.get(slot, self.MODEL_SLOTS["reasoning"])
        all_models = [model_config.primary] + model_config.fallback

        last_error = None
        for model in all_models:
            for attempt in range(self.max_retries):
                try:
                    # ``asyncio.timeout`` cancels the request if the
                    # provider hangs past the deadline (the default
                    # is also configured on the AsyncOpenAI client
                    # itself, but this guard makes the deadline
                    # explicit at the call site).
                    async with asyncio.timeout(60.0):
                        response = await self._make_request_async(
                            model=model,
                            prompt=prompt,
                            system_prompt=system_prompt,
                            max_tokens=kwargs.get("max_tokens", model_config.max_tokens),
                            **kwargs,
                        )
                    self.circuit_breaker.record_success(agent)
                    self._log_usage(response)
                    self._record_provider_error(
                        "anthropic" if self._is_anthropic_model(model) else "openai",
                        error=False,
                    )
                    return response
                except (TimeoutError, RateLimitError, APITimeoutError) as e:
                    last_error = e
                    self._record_provider_error(
                        "anthropic" if self._is_anthropic_model(model) else "openai",
                        error=True,
                    )
                    if attempt < self.max_retries - 1:
                        await self._sleep_with_jitter_async(2 ** attempt)
                    continue
                except APIError as e:
                    last_error = e
                    # ``APIError`` subclasses include ``APIConnectionError``
                    # and ``APITimeoutError`` which may not carry
                    # ``status_code`` — guard with ``getattr`` so a
                    # network blip doesn't ``AttributeError``-out
                    # before we record the failure or retry.
                    status_code = getattr(e, "status_code", None)
                    if status_code in (401, 400):
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
                        await self._sleep_with_jitter_async(2 ** attempt)
                    continue

        self.circuit_breaker.record_failure(agent)
        raise MaxRetriesExceededError(
            f"All models failed for agent {agent} after {self.max_retries} attempts: {last_error}"
        )

    def call(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: str | None = None,
        **kwargs,
    ) -> LLMResponse:
        """Make an LLM call with retry and circuit breaker."""
        if self.circuit_breaker.is_open(agent):
            raise CircuitOpenError(f"Circuit breaker open for agent: {agent}")

        model_config = self.MODEL_SLOTS.get(slot, self.MODEL_SLOTS["reasoning"])
        all_models = [model_config.primary] + model_config.fallback

        last_error = None
        for model in all_models:
            for attempt in range(self.max_retries):
                try:
                    response = self._make_request(
                        model=model,
                        prompt=prompt,
                        system_prompt=system_prompt,
                        max_tokens=kwargs.get("max_tokens", model_config.max_tokens),
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
                        self._sleep_with_jitter(2 ** attempt)
                    continue
                except APIError as e:
                    last_error = e
                    # ``APIError`` subclasses include ``APIConnectionError``
                    # which has no ``status_code`` — guard with
                    # ``getattr`` so we don't ``AttributeError`` before
                    # recording the failure or deciding to retry.
                    status_code = getattr(e, "status_code", None)
                    if status_code in (401, 400):
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
                        self._sleep_with_jitter(2 ** attempt)
                    continue

        self.circuit_breaker.record_failure(agent)
        raise MaxRetriesExceededError(
            f"All models failed for agent {agent} after {self.max_retries} attempts: {last_error}"
        )

    def _make_request(
        self,
        model: str,
        prompt: str,
        system_prompt: str | None = None,
        max_tokens: int = 4096,
        **kwargs,
    ) -> LLMResponse:
        """Make a single sync request to OpenRouter.

        Kept for callers that still need a blocking LLM call (CLI
        scripts, Celery workers, tests). The async event loop
        should use :meth:`acall` + :meth:`_make_request_async`.
        """
        messages = self._build_messages(prompt, system_prompt)
        extra_headers = self._build_extra_headers(kwargs)
        response = self.client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            extra_headers=extra_headers if extra_headers else None,
            **kwargs,
        )
        return self._response_to_llm_response(response, model)

    async def _make_request_async(
        self,
        model: str,
        prompt: str,
        system_prompt: str | None = None,
        max_tokens: int = 4096,
        **kwargs,
    ) -> LLMResponse:
        """Make a single async request to OpenRouter via AsyncOpenAI.

        The async path never touches the event loop's thread pool
        — a hung downstream request will be cancelled by the
        enclosing :meth:`acall` ``asyncio.timeout`` guard rather
        than blocking a worker thread.
        """
        messages = self._build_messages(prompt, system_prompt)
        extra_headers = self._build_extra_headers(kwargs)
        response = await self.async_client.chat.completions.create(
            model=model,
            messages=messages,
            max_tokens=max_tokens,
            extra_headers=extra_headers if extra_headers else None,
            **kwargs,
        )
        return self._response_to_llm_response(response, model)

    @staticmethod
    def _build_messages(prompt: str, system_prompt: str | None) -> list[dict]:
        messages: list[dict] = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
        messages.append({"role": "user", "content": prompt})
        return messages

    @staticmethod
    def _build_extra_headers(kwargs: dict) -> dict:
        extra_headers: dict = {}
        if "structured-outputs" in kwargs:
            extra_headers["x-open-router-beta"] = "structured-outputs-2025-11-13"
        return extra_headers

    @staticmethod
    def _response_to_llm_response(response: Any, model: str) -> LLMResponse:
        usage = UsageStats(
            prompt_tokens=response.usage.prompt_tokens if response.usage else 0,
            completion_tokens=response.usage.completion_tokens if response.usage else 0,
            total_tokens=response.usage.total_tokens if response.usage else 0,
            cost=getattr(response.usage, "cost", None),
            cache_reads=getattr(response.usage, "cache_reads", 0) or 0,
            cache_writes=getattr(response.usage, "cache_writes", 0) or 0,
        )
        return LLMResponse(
            content=response.choices[0].message.content or "",
            usage=usage,
            model=model,
            finish_reason=response.choices[0].finish_reason or "unknown",
            raw_response=response,
        )

    def _log_usage(self, response: LLMResponse) -> None:
        """Log usage for cost tracking."""
        self._usage_log.append(response.usage)
        logger.debug(
            f"LLM call: model={response.model}, "
            f"tokens={response.usage.total_tokens}, "
            f"cost={response.usage.cost}"
        )

    @staticmethod
    def _sleep_with_jitter(base_seconds: float) -> None:
        """Exponential backoff with ±25% jitter to avoid thundering-herd
        retries when many clients recover from a shared downstream
        blip simultaneously."""
        jitter = base_seconds * 0.25
        time.sleep(base_seconds + random.uniform(-jitter, jitter))

    @staticmethod
    async def _sleep_with_jitter_async(base_seconds: float) -> None:
        """Async sibling of :meth:`_sleep_with_jitter` — uses
        ``asyncio.sleep`` so the event loop is free to schedule
        other coroutines during the backoff."""
        jitter = base_seconds * 0.25
        await asyncio.sleep(base_seconds + random.uniform(-jitter, jitter))

    async def close_async(self) -> None:
        """Close the async client's underlying ``httpx.AsyncClient``.

        Call from FastAPI ``lifespan`` shutdown to release sockets
        cleanly. Sync callers can ignore this — the sync ``OpenAI``
        client manages its own connection pool and the GC will
        reclaim it on process exit.
        """
        await self.async_client.close()

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


# Backward-compat alias: tests + downstream callers that pre-dated
# the public rename use the underscore-prefixed name.
_get_llm_client = get_llm_client


def get_provider_error_counts() -> dict:
    """§11.4 — per-provider error rate snapshot from the singleton client.

    Returns ``{provider: {"calls": int, "errors": int, "error_rate": float}}``.
    """
    # Use the underscore-prefixed name so tests that patch
    # ``eden.llm.client._get_llm_client`` correctly intercept.
    client = _get_llm_client()
    out: dict = {}
    for provider, calls in client._provider_calls.items():
        errors = client._provider_errors.get(f"{provider}.error", 0)
        rate = (errors / calls) if calls else 0.0
        out[provider] = {"calls": calls, "errors": errors, "error_rate": rate}
    return out
