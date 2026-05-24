"""OpenRouter LLM client with retry logic, circuit breaker, and cost tracking."""

import time
import logging
from enum import Enum
from dataclasses import dataclass, field
from typing import Optional, Any
from collections import defaultdict
from functools import lru_cache

from openai import OpenAI, RateLimitError, APITimeoutError, APIError
import tenacity

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
    cost: Optional[float] = None
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
        if self.state[agent] == CircuitState.OPEN:
            lock_until = self.half_open_lock_until.get(agent, 0)
            if time.time() < lock_until:
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
        api_key: Optional[str] = None,
        base_url: str = "https://openrouter.ai/api/v1",
        max_retries: int = 3,
        circuit_breaker_threshold: int = 5,
        circuit_breaker_timeout: int = 60,
    ):
        self.settings = get_settings()
        self.client = OpenAI(
            api_key=api_key or self.settings.openrouter_api_key,
            base_url=base_url,
        )
        self.circuit_breaker = CircuitBreaker(
            failure_threshold=circuit_breaker_threshold,
            recovery_timeout=circuit_breaker_timeout,
        )
        self.max_retries = max_retries
        self._usage_log: list[UsageStats] = []
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

    def get_model_for_slot(self, slot: str) -> str:
        """Get the primary model for a slot from config."""
        config = self.MODEL_SLOTS.get(slot, self.MODEL_SLOTS["reasoning"])
        return config.primary

    async def acall(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: Optional[str] = None,
        **kwargs,
    ) -> LLMResponse:
        """Async wrapper using thread pool executor."""
        import asyncio
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(
            None, self.call, agent, prompt, slot, system_prompt
        )

    def call(
        self,
        agent: str,
        prompt: str,
        slot: str = "reasoning",
        system_prompt: Optional[str] = None,
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
                    return response
                except (RateLimitError, APITimeoutError) as e:
                    last_error = e
                    if attempt < self.max_retries - 1:
                        time.sleep(2**attempt)
                    continue
                except APIError as e:
                    last_error = e
                    if e.status_code in (401, 400):
                        raise
                    if attempt < self.max_retries - 1:
                        time.sleep(2**attempt)
                    continue

        self.circuit_breaker.record_failure(agent)
        raise MaxRetriesExceededError(
            f"All models failed for agent {agent} after {self.max_retries} attempts: {last_error}"
        )

    def _make_request(
        self,
        model: str,
        prompt: str,
        system_prompt: Optional[str] = None,
        max_tokens: int = 4096,
        **kwargs,
    ) -> LLMResponse:
        """Make a single request to OpenRouter."""
        messages = []
        if system_prompt:
            messages.append({"role": "system", "content": system_prompt})
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