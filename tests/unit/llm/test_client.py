"""Unit tests for the OpenRouter LLM client.

Covers: circuit breaker, retry logic, usage tracking, model fallback,
        and error handling.
"""

import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from openai import APIError, APITimeoutError, RateLimitError

from eden.llm.client import (
    CircuitBreaker,
    CircuitOpenError,
    CircuitState,
    LLMResponse,
    MaxRetriesExceededError,
    OpenRouterClient,
    UsageStats,
)

# ─────────────────────────────────────────────────────────────────────────────
# Circuit Breaker
# ─────────────────────────────────────────────────────────────────────────────

class TestCircuitBreaker:
    def test_initial_state_is_closed(self):
        """A fresh circuit breaker is closed."""
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=1)
        assert cb.is_open("agent_1") is False
        assert cb.state["agent_1"] == CircuitState.CLOSED

    def test_opens_after_threshold_failures(self):
        """Circuit opens after N consecutive failures."""
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=10)

        cb.record_failure("agent_1")
        cb.record_failure("agent_1")
        assert cb.is_open("agent_1") is False

        cb.record_failure("agent_1")
        assert cb.is_open("agent_1") is True
        assert cb.state["agent_1"] == CircuitState.OPEN

    def test_success_resets_failures(self):
        """A single success resets the failure counter."""
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=10)
        cb.record_failure("agent_1")
        cb.record_failure("agent_1")
        cb.record_success("agent_1")
        assert cb.failures["agent_1"] == 0
        assert cb.is_open("agent_1") is False

    def test_half_open_allows_one_probe(self):
        """After recovery timeout, circuit enters half-open."""
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=0.1)
        cb.record_failure("agent_1")
        cb.record_failure("agent_1")
        assert cb.is_open("agent_1") is True

        # Wait for recovery timeout
        time.sleep(0.15)
        assert cb.is_open("agent_1") is False
        assert cb.state["agent_1"] == CircuitState.HALF_OPEN

    def test_half_open_reopens_on_failure(self):
        """Half-open circuit re-opens if a probe fails."""
        cb = CircuitBreaker(
            failure_threshold=2,
            recovery_timeout=0.1,
            half_open_max_failures=1,
        )
        cb.record_failure("agent_1")
        cb.record_failure("agent_1")
        assert cb.is_open("agent_1") is True

        time.sleep(0.15)
        cb.is_open("agent_1")  # triggers half-open
        cb.record_failure("agent_1")
        assert cb.is_open("agent_1") is True

    def test_get_status(self):
        """Status report includes state, failures, and timestamps."""
        cb = CircuitBreaker(failure_threshold=3, recovery_timeout=10)
        cb.record_failure("agent_1")
        status = cb.get_status("agent_1")
        assert status["state"] == "closed"
        assert status["failures"] == 1
        assert status["last_failure"] is not None

    def test_per_agent_isolation(self):
        """Failures in one agent do not affect another."""
        cb = CircuitBreaker(failure_threshold=2, recovery_timeout=10)
        cb.record_failure("agent_1")
        cb.record_failure("agent_1")
        assert cb.is_open("agent_1") is True
        assert cb.is_open("agent_2") is False


# ─────────────────────────────────────────────────────────────────────────────
# OpenRouterClient Retry & Fallback
# ─────────────────────────────────────────────────────────────────────────────

class TestOpenRouterClientRetry:
    @pytest.fixture
    def client(self):
        """Return a client instance with mocked OpenAI + AsyncOpenAI clients.

        ``_openai_mock`` and ``async_client`` are SEPARATE MagicMock
        objects because the sync ``call`` path needs a regular
        ``.create`` (returns the response) while the async
        ``acall`` path needs an ``AsyncMock.create`` (awaitable).
        Use :func:`set_response` in each test to set the same
        behaviour on both mocks in one line.
        """
        with patch("eden.llm.client.OpenAI") as mock_openai, \
             patch("eden.llm.client.AsyncOpenAI") as mock_async_openai:
            mock_sync = MagicMock()
            mock_async = MagicMock()
            mock_async.chat.completions.create = AsyncMock()
            mock_openai.return_value = mock_sync
            mock_async_openai.return_value = mock_async
            client = OpenRouterClient(
                api_key="test-key",
                base_url="https://test.example.com",
                max_retries=3,
            )
            client._openai_mock = mock_sync
            client._openai_async_mock = mock_async

            def set_response(*, return_value=None, side_effect=None):
                """Set the same response on sync + async mock.

                Both paths read from their respective ``.create``
                attribute — this helper keeps them in lockstep so
                tests don't have to repeat the assignment twice.
                """
                if return_value is not None:
                    mock_sync.chat.completions.create.return_value = return_value
                    mock_async.chat.completions.create.return_value = return_value
                if side_effect is not None:
                    mock_sync.chat.completions.create.side_effect = side_effect
                    mock_async.chat.completions.create.side_effect = side_effect

            client.set_response = set_response
            return client

    @pytest.mark.asyncio
    async def test_acall_success(self, client):
        """Async acall returns an LLMResponse."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content="Async Hello"))]
        mock_response.usage = MagicMock(
            prompt_tokens=5, completion_tokens=3, total_tokens=8
        )
        # The async path reads from a separate ``AsyncOpenAI``
        # instance — drive both mocks via the ``set_response``
        # helper.
        client.set_response(return_value=mock_response)

        resp = await client.acall(agent="test", prompt="Say hello", slot="reasoning")
        assert isinstance(resp, LLMResponse)
        assert resp.content == "Async Hello"
        assert resp.usage.total_tokens == 8

    @pytest.mark.asyncio
    async def test_acall_timeout_retry(self, client):
        """APITimeoutError triggers retry on async calls.

        v1.7.4 polish: ``acall`` now routes through ``call`` in
        an executor so it shares the in-process cache + Claude
        prompt caching + retry logic. The mock is therefore the
        SYNC ``client._openai_mock`` (which ``call`` invokes),
        not the async one. Verifying the sync call count
        proves the routing refactor.
        """
        client.set_response(side_effect=[
            APITimeoutError("timeout"),
            MagicMock(
                choices=[MagicMock(message=MagicMock(content="Recovered"))],
                usage=MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            ),
        ])

        resp = await client.acall(agent="test", prompt="test", slot="reasoning")
        assert resp.content == "Recovered"
        # ``acall`` now dispatches to ``call`` (via executor) so
        # the SYNC mock saw the retry.
        assert client._openai_mock.chat.completions.create.call_count == 2

    def test_successful_call(self, client):
        """A successful call returns an LLMResponse."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content="Hello"))]
        mock_response.usage = MagicMock(
            prompt_tokens=10, completion_tokens=5, total_tokens=15
        )
        client._openai_mock.chat.completions.create.return_value = mock_response

        resp = client.call(agent="test", prompt="Say hello", slot="reasoning")
        assert isinstance(resp, LLMResponse)
        assert resp.content == "Hello"
        assert resp.usage.total_tokens == 15
        # Model comes from settings; verify it's a non-empty string
        assert isinstance(resp.model, str)
        assert len(resp.model) > 0

    def test_retries_on_rate_limit(self, client):
        """RateLimitError triggers retries with exponential backoff."""
        client._openai_mock.chat.completions.create.side_effect = [
            RateLimitError("rate limited", response=MagicMock(), body=None),
            RateLimitError("rate limited", response=MagicMock(), body=None),
            MagicMock(
                choices=[MagicMock(message=MagicMock(content="OK"))],
                usage=MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            ),
        ]

        resp = client.call(agent="test", prompt="test", slot="reasoning")
        assert resp.content == "OK"
        assert client._openai_mock.chat.completions.create.call_count == 3

    def test_fallback_model_on_failure(self, client):
        """If primary model fails, fallback models are tried."""
        err = APIError(
            message="model error",
            request=MagicMock(),
            body=None,
        )
        err.status_code = 500
        client._openai_mock.chat.completions.create.side_effect = [
            err,
            MagicMock(
                choices=[MagicMock(message=MagicMock(content="Fallback OK"))],
                usage=MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            ),
        ]

        resp = client.call(agent="test", prompt="test", slot="reasoning")
        assert resp.content == "Fallback OK"
        assert client._openai_mock.chat.completions.create.call_count == 2

    def test_max_retries_exceeded(self, client):
        """All models failing raises MaxRetriesExceededError."""
        err = APIError(
            message="persistent error",
            request=MagicMock(),
            body=None,
        )
        err.status_code = 500
        client._openai_mock.chat.completions.create.side_effect = err

        with pytest.raises(MaxRetriesExceededError):
            client.call(agent="test", prompt="test", slot="reasoning")

    def test_bad_request_not_retried(self, client):
        """400/401 errors are not retried."""
        err = APIError(
            message="bad request",
            request=MagicMock(),
            body=None,
        )
        err.status_code = 400
        client._openai_mock.chat.completions.create.side_effect = err

        with pytest.raises(APIError):
            client.call(agent="test", prompt="test", slot="reasoning")
        assert client._openai_mock.chat.completions.create.call_count == 1

    def test_circuit_breaker_blocks_when_open(self, client):
        """Calls are blocked when the circuit breaker is driven open by failures."""
        # Drive the circuit open via repeated failures.
        # Each client.call() retries internally and records ONE failure
        # to the circuit breaker, so we loop failure_threshold times.
        err = APIError(
            message="fail", request=MagicMock(), body=None
        )
        err.status_code = 500
        client._openai_mock.chat.completions.create.side_effect = err
        for _ in range(client.circuit_breaker.failure_threshold):
            with pytest.raises(MaxRetriesExceededError):
                client.call(agent="test_agent", prompt="test", slot="reasoning")

        # After failure_threshold failures, the circuit should be open
        with pytest.raises(CircuitOpenError):
            client.call(agent="test_agent", prompt="test", slot="reasoning")


# ─────────────────────────────────────────────────────────────────────────────
# Usage Tracking
# ─────────────────────────────────────────────────────────────────────────────

class TestUsageTracking:
    def test_usage_stats_defaults(self):
        """UsageStats has sensible zero defaults."""
        u = UsageStats()
        assert u.prompt_tokens == 0
        assert u.completion_tokens == 0
        assert u.total_tokens == 0
        assert u.cost is None
        assert u.cache_reads == 0
        assert u.cache_writes == 0

    def test_get_total_usage(self):
        """Total usage aggregates multiple calls."""
        client = OpenRouterClient(api_key="test")
        resp1 = LLMResponse(
            content="a",
            usage=UsageStats(prompt_tokens=10, completion_tokens=5, total_tokens=15, cost=0.01),
            model="m1",
            finish_reason="stop",
        )
        resp2 = LLMResponse(
            content="b",
            usage=UsageStats(prompt_tokens=20, completion_tokens=10, total_tokens=30, cost=0.02),
            model="m2",
            finish_reason="stop",
        )
        client._log_usage(resp1)
        client._log_usage(resp2)

        total = client.get_total_usage()
        assert total.prompt_tokens == 30
        assert total.completion_tokens == 15
        assert total.total_tokens == 45
        assert total.cost == pytest.approx(0.03)

    def test_usage_log_is_private(self):
        """The usage log is an internal implementation detail."""
        client = OpenRouterClient(api_key="test")
        assert hasattr(client, "_usage_log")


# ─────────────────────────────────────────────────────────────────────────────
# Model Slots
# ─────────────────────────────────────────────────────────────────────────────

class TestModelSlots:
    def test_get_model_for_slot(self):
        """Model slots map task types to configured models."""
        with patch("eden.llm.client.OpenAI"):
            client = OpenRouterClient(api_key="test")
            # The primary model comes from settings, but we can verify
            # the slot structure exists
            assert "reasoning" in client.MODEL_SLOTS
            assert "code" in client.MODEL_SLOTS
            assert "fast" in client.MODEL_SLOTS
            assert "extraction" in client.MODEL_SLOTS

    def test_slot_has_max_tokens(self):
        """Each slot configures max_tokens."""
        with patch("eden.llm.client.OpenAI"):
            client = OpenRouterClient(api_key="test")
            slot = client.MODEL_SLOTS["reasoning"]
            assert slot.max_tokens > 0


class TestAcallUsesInProcessCache:
    """v1.7.4 polish: ``acall`` now routes through ``call`` so
    it shares the in-process LRU cache. The previous
    implementation had a parallel retry loop that bypassed the
    cache, so async callers in production (the discipline
    layer, the trajectory guard, the model router) never
    benefited from a hit.
    """

    def test_acall_hits_in_process_cache(self, monkeypatch):
        """An ``acall`` on a prompt that was already ``call``-ed
        should return the cached response without hitting the
        network — same behavior as the sync path."""
        from eden.llm import client as client_module
        # Enable the in-process cache.
        monkeypatch.setenv("EDEN_LLM_INPROCESS_CACHE", "1")
        c = client_module.OpenRouterClient(api_key="test")
        c._in_process_cache_enabled = True
        c._in_process_cache.clear()
        c._cache_hits = 0
        c._cache_misses = 0
        from eden.llm.client import LLMResponse, UsageStats
        cached_resp = LLMResponse(
            content="from-sync-call",
            usage=UsageStats(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            model="anthropic/claude-3-5-sonnet-20241022",
            finish_reason="stop",
        )
        # Manually populate the cache using the same max_tokens
        # the slot's reasoning config carries — ``acall`` resolves
        # ``max_tokens`` from the slot when the caller doesn't pass
        # it, so the cache key must match that resolved value or
        # we'd be testing a key that never gets used in production.
        slot_cfg = c.MODEL_SLOTS["reasoning"]
        mt = slot_cfg.max_tokens
        key = c._cache_key(
            "anthropic/claude-3-5-sonnet-20241022",
            "hello", None, mt, temperature=0,
        )
        c._cache_put(key, cached_resp)
        # Now call acall. It should hit the cache and return
        # the same response — not hit the network.
        import asyncio
        got = asyncio.run(c.acall(
            agent="t", prompt="hello", slot="reasoning",
            model="anthropic/claude-3-5-sonnet-20241022",
        ))
        assert got.content == "from-sync-call"
        assert c._cache_hits == 1
        assert c._cache_misses == 0


class TestInProcessCache:
    """Tests for the in-process LLM cache (L0, opt-in)."""

    def _client(self, monkeypatch):
        """Build a client with the in-process cache enabled."""
        monkeypatch.setenv("EDEN_LLM_INPROCESS_CACHE", "1")
        # Reset module-level state so each test gets a fresh client
        from eden.llm import client as client_module
        # Clear any previously-cached enabled state in instance defaults
        c = client_module.OpenRouterClient(api_key="test")
        c._in_process_cache_enabled = True
        c._in_process_cache.clear()
        c._cache_hits = 0
        c._cache_misses = 0
        return c

    def test_disabled_by_default(self, monkeypatch):
        """Cache disabled when env var is not set."""
        monkeypatch.delenv("EDEN_LLM_INPROCESS_CACHE", raising=False)
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        # Default disabled regardless of env
        assert c._in_process_cache_enabled is False

    def test_key_is_deterministic(self):
        """Same inputs → same key."""
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        k1 = c._cache_key("m", "p", "s", 100, temperature=0)
        k2 = c._cache_key("m", "p", "s", 100, temperature=0)
        assert k1 == k2

    def test_key_differs_on_prompt(self):
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        k1 = c._cache_key("m", "p1", None, 100)
        k2 = c._cache_key("m", "p2", None, 100)
        assert k1 != k2

    def test_key_differs_on_model(self):
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        k1 = c._cache_key("m1", "p", None, 100)
        k2 = c._cache_key("m2", "p", None, 100)
        assert k1 != k2

    def test_key_differs_on_temperature(self):
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        k0 = c._cache_key("m", "p", None, 100, temperature=0)
        k1 = c._cache_key("m", "p", None, 100, temperature=1)
        assert k0 != k1

    def test_cache_get_put(self, monkeypatch):
        from eden.llm import client as client_module
        from eden.llm.client import LLMResponse, UsageStats
        c = self._client(monkeypatch)
        resp = LLMResponse(
            content="cached", usage=UsageStats(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            model="m", finish_reason="stop"
        )
        c._cache_put("k1", resp)
        got = c._cache_get("k1")
        assert got is resp
        assert c._cache_hits == 1

    def test_cache_miss_when_empty(self, monkeypatch):
        from eden.llm import client as client_module
        c = self._client(monkeypatch)
        got = c._cache_get("nonexistent")
        assert got is None
        assert c._cache_misses == 1

    def test_cache_lru_eviction(self, monkeypatch):
        from eden.llm import client as client_module
        from eden.llm.client import LLMResponse, UsageStats
        c = self._client(monkeypatch)
        c._in_process_cache_max = 3
        resp = LLMResponse(
            content="x", usage=UsageStats(0, 0, 0), model="m", finish_reason="stop"
        )
        c._cache_put("a", resp)
        c._cache_put("b", resp)
        c._cache_put("c", resp)
        assert len(c._in_process_cache) == 3
        c._cache_put("d", resp)  # evicts "a"
        assert len(c._in_process_cache) == 3
        assert c._cache_get("a") is None  # evicted
        assert c._cache_get("d") is resp  # newest still present

    def test_anthropic_system_prompt_has_cache_control(self, monkeypatch):
        """Anthropic model + system prompt should mark the
        system prompt as cacheable so the second+ call within
        the cache TTL gets a 90% discount on prompt tokens.

        OpenRouter forwards ``cache_control`` to the Anthropic
        backend. The field is Anthropic-specific and should
        NOT be added to OpenAI model requests.
        """
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        from unittest.mock import MagicMock, patch
        captured: dict = {}
        def capture_create(**kwargs):
            captured.update(kwargs)
            m = MagicMock()
            m.choices = [MagicMock()]
            m.choices[0].message.content = "ok"
            m.choices[0].finish_reason = "stop"
            m.usage.prompt_tokens = 10
            m.usage.completion_tokens = 5
            m.usage.total_tokens = 15
            m.usage.cost = None
            m.usage.cache_reads = 0
            m.usage.cache_writes = 0
            return m
        with patch.object(c.client.chat.completions, "create",
                          side_effect=capture_create):
            # Claude model: system prompt must be wrapped in
            # a list with cache_control.
            c._make_request(
                "anthropic/claude-3-5-sonnet-20241022",
                "hi", "you are a helpful assistant", 100,
            )
        messages = captured["messages"]
        sys_msg = next(m for m in messages if m["role"] == "system")
        assert isinstance(sys_msg["content"], list), (
            f"Claude system prompt should be a list with cache_control, "
            f"got {type(sys_msg['content']).__name__}"
        )
        assert sys_msg["content"][0]["cache_control"] == {
            "type": "ephemeral",
        }, f"missing cache_control on Claude system prompt: {sys_msg}"
        assert sys_msg["content"][0]["text"] == "you are a helpful assistant"

    def test_openai_system_prompt_does_not_have_cache_control(self, monkeypatch):
        """GPT models must NOT receive the Anthropic-specific
        ``cache_control`` field — OpenAI doesn't recognize it
        and it would either be ignored or trigger a 400.
        """
        from eden.llm import client as client_module
        c = client_module.OpenRouterClient(api_key="test")
        from unittest.mock import MagicMock, patch
        captured: dict = {}
        def capture_create(**kwargs):
            captured.update(kwargs)
            m = MagicMock()
            m.choices = [MagicMock()]
            m.choices[0].message.content = "ok"
            m.choices[0].finish_reason = "stop"
            m.usage.prompt_tokens = 10
            m.usage.completion_tokens = 5
            m.usage.total_tokens = 15
            m.usage.cost = None
            m.usage.cache_reads = 0
            m.usage.cache_writes = 0
            return m
        with patch.object(c.client.chat.completions, "create",
                          side_effect=capture_create):
            c._make_request(
                "openai/gpt-4o-mini",
                "hi", "you are a helpful assistant", 100,
            )
        messages = captured["messages"]
        sys_msg = next(m for m in messages if m["role"] == "system")
        # Must remain a plain string for OpenAI.
        assert isinstance(sys_msg["content"], str), (
            f"GPT system prompt should remain a plain string, "
            f"got {type(sys_msg['content']).__name__}"
        )
        assert sys_msg["content"] == "you are a helpful assistant"

    def test_non_zero_temperature_skips_cache(self, monkeypatch):
        """Stochastic calls (temperature > 0) must not be cached.

        Caching a temperature=0.7 call would either return stale
        output (on hit) or bloat the LRU with unreachable entries
        (on miss), since the next call with the same prompt would
        generate a different answer. The cache is only safe for
        temperature=0 / deterministic calls.
        """
        from eden.llm import client as client_module
        c = self._client(monkeypatch)
        # Inject a probe into _cache_key to count calls.
        key_calls = {"n": 0}
        original_key = c._cache_key
        def counting_key(*args, **kwargs):
            key_calls["n"] += 1
            return original_key(*args, **kwargs)
        c._cache_key = counting_key  # type: ignore[method-assign]
        # Build a stub response that satisfies the usage extraction.
        from unittest.mock import MagicMock, patch
        mock_response = MagicMock()
        mock_response.choices = [MagicMock()]
        mock_response.choices[0].message.content = "ok"
        mock_response.choices[0].finish_reason = "stop"
        mock_response.usage.prompt_tokens = 1
        mock_response.usage.completion_tokens = 1
        mock_response.usage.total_tokens = 2
        mock_response.usage.cost = None
        mock_response.usage.cache_reads = 0
        mock_response.usage.cache_writes = 0
        # _make_request is sync — no asyncio needed.
        with patch.object(c.client.chat.completions, "create",
                          return_value=mock_response):
            # Deterministic call (temp=0): should consult cache.
            c._make_request("m", "p", None, 100, temperature=0)
            # Stochastic call (temp=0.7): must NOT consult cache.
            c._make_request("m", "p", None, 100, temperature=0.7)
        # The deterministic call consulted the cache (1 key build).
        # The stochastic call must have skipped _cache_key entirely
        # → 1 call total, not 2.
        assert key_calls["n"] == 1, (
            f"non-zero temperature called _cache_key — cache is "
            f"being populated with non-deterministic results. "
            f"key_calls={key_calls['n']}"
        )

    def test_cache_ttl_expiry(self, monkeypatch):
        import time

        from eden.llm import client as client_module
        from eden.llm.client import LLMResponse, UsageStats
        c = self._client(monkeypatch)
        c._in_process_cache_ttl = 0.05  # 50ms
        resp = LLMResponse(
            content="x", usage=UsageStats(0, 0, 0), model="m", finish_reason="stop"
        )
        c._cache_put("k", resp)
        # Immediately present
        assert c._cache_get("k") is resp
        # After TTL — expired
        time.sleep(0.06)
        assert c._cache_get("k") is None
