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
from enum import Enum
from typing import Any

from eden.llmops.filters import (
    FilterRegistry,
    GatewayFilter,
    PIIFilter,
    PIIFilterConfig,
)

logger = logging.getLogger(__name__)


class Provider(str, Enum):
    OPENROUTER = "openrouter"
    MINIMAX = "minimax"
    SELF_HOSTED = "self_hosted"


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
        if self._state == "open":
            if self._last_failure_time and (time.time() - self._last_failure_time) > self.recovery_timeout_sec:
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
            raise ProviderUnavailable("Circuit breaker OPEN for provider")
        try:
            result = await fn(*args, **kwargs)
            self.record_success()
            return result
        except Exception:
            self.record_failure()
            raise


class ProviderUnavailable(Exception):
    pass


class BudgetExceededError(Exception):
    pass


class AIGateway:
    """AI Gateway with auth, routing, caching, cost tracking, and failover."""

    # Static performance matrix: model -> (quality, latency_p95, cost_per_1k, reliability)
    MODEL_PERFORMANCE: dict[str, tuple[float, int, float, float]] = {
        "claude-sonnet-4": (0.94, 800, 0.0030, 0.999),
        "gpt-4o": (0.92, 600, 0.0025, 0.998),
        "claude-haiku": (0.87, 200, 0.00025, 0.999),
        "minimax-m2.7": (0.85, 400, 0.00015, 0.995),
        # Local-model entries. Cost is genuinely 0.0 — running on the
        # user's own GPU has no per-token price, just amortised hardware.
        # Quality + latency are conservative estimates for a typical
        # 8B-class model on a modern consumer GPU; the v1.4 SLM plan
        # replaces these with measured numbers per tenant.
        "llama3.1:8b": (0.78, 400, 0.0, 0.99),
        "qwen2.5:32b": (0.86, 1200, 0.0, 0.99),
        "mistral-nemo": (0.82, 700, 0.0, 0.99),
        "deepseek-r1:8b": (0.84, 1500, 0.0, 0.99),
    }

    def __init__(
        self,
        semantic_cache: Any | None = None,
        exact_cache: Any | None = None,
    ):
        self.semantic_cache = semantic_cache
        self.exact_cache = exact_cache
        self._providers: dict[Provider, Any] = {}
        self._circuit_breakers: dict[Provider, CircuitBreaker] = {}
        self._metrics: list[dict[str, Any]] = []
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

    async def complete(self, request: ModelRequest) -> ModelResponse:
        # 0. Filter chain — PII by default, plus any registered custom
        # filters. Fail-open by default (see FilterRegistry).
        request, _filter_findings = self._filters.run(request)

        # 1. Check exact cache
        if self.exact_cache:
            cached = await self._check_exact_cache(request)
            if cached:
                return cached

        # 2. Check semantic cache
        if self.semantic_cache:
            cached = await self._check_semantic_cache(request)
            if cached:
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
            raise ProviderUnavailable("No healthy provider available for request")

        # 5. Execute with circuit breaker
        start_ms = int(time.time() * 1000)
        try:
            cb = self._circuit_breakers[provider]
            response = await cb.call(self._execute_provider, provider, request)
        except ProviderUnavailable:
            # Fallback to next-best provider
            provider = self._select_fallback(provider, request)
            if not provider:
                raise ProviderUnavailable("All providers unavailable")
            response = await self._execute_provider(provider, request)

        latency_ms = int(time.time() * 1000) - start_ms

        # 6. Record metrics
        self._record_metrics(request, provider, response, latency_ms)

        # 7. Update budget
        if budget:
            budget["remaining"] -= response.input_tokens + response.output_tokens

        # 8. Cache response
        await self._cache_response(request, response)

        return response

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
        """Return (quality, latency, cost, reliability) for a provider.

        For ``SELF_HOSTED``, looks up ``model_version`` first so a tenant
        running ``qwen2.5:32b`` gets its own quality/latency profile;
        falls back to a generic local-model estimate when unknown.
        """
        if provider == Provider.OPENROUTER:
            return self.MODEL_PERFORMANCE.get("claude-sonnet-4", (0.9, 800, 0.003, 0.999))
        if provider == Provider.MINIMAX:
            return self.MODEL_PERFORMANCE.get("minimax-m2.7", (0.85, 400, 0.00015, 0.995))
        if provider == Provider.SELF_HOSTED:
            if model_version and model_version in self.MODEL_PERFORMANCE:
                return self.MODEL_PERFORMANCE[model_version]
            return (0.80, 600, 0.0, 0.99)
        return (0.8, 1000, 0.001, 0.99)

    async def _execute_provider(self, provider: Provider, request: ModelRequest) -> ModelResponse:
        client = self._providers.get(provider)
        if not client:
            raise ProviderUnavailable(f"Provider {provider.value} not registered")

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
        cost = self._estimate_cost(
            provider,
            raw.get("input_tokens", 0),
            raw.get("output_tokens", 0),
            model_version=request.model_version,
        )

        return ModelResponse(
            text=raw.get("text", ""),
            input_tokens=raw.get("input_tokens", 0),
            output_tokens=raw.get("output_tokens", 0),
            latency_ms=latency_ms,
            cost_usd=cost,
            provider=provider.value,
            model=request.model_version,
        )

    def _estimate_cost(
        self, provider: Provider, input_tokens: int, output_tokens: int, model_version: str = ""
    ) -> float:
        perf = self._estimate_provider_performance(provider, model_version)
        cost_per_1k = perf[2]
        total_tokens = input_tokens + output_tokens
        return (total_tokens / 1000) * cost_per_1k

    def _record_metrics(
        self,
        request: ModelRequest,
        provider: Provider,
        response: ModelResponse,
        latency_ms: int,
    ) -> None:
        self._metrics.append({
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
        metrics = self._metrics
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
        import httpx

        url = f"{self._base_url}/chat/completions"
        payload: dict[str, Any] = {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "temperature": temperature,
            "max_tokens": max_tokens,
            "stream": False,
        }
        async with httpx.AsyncClient(timeout=self._timeout_s) as http:
            resp = await http.post(url, json=payload)
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


def register_default_providers(gateway: AIGateway) -> None:
    """Wire :class:`OllamaClient` into the gateway as ``SELF_HOSTED``.

    Idempotent — safe to call on every gateway construction; the
    gateway's ``register_provider`` overwrites in place.

    Callers (test fixtures, app startup) invoke this after building the
    gateway so the SELF_HOSTED provider is reachable without any
    extra config.  An Ollama server running on ``$OLLAMA_HOST`` (or
    ``localhost:11434``) is the common case; if the server is not
    reachable the circuit breaker will trip and ``complete()`` will
    surface :class:`ProviderUnavailable` — exactly the behaviour we
    want for graceful failover to a cloud provider.
    """
    if Provider.SELF_HOSTED not in gateway._providers:
        gateway.register_provider(Provider.SELF_HOSTED, OllamaClient())
