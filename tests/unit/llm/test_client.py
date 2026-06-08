"""Unit tests for the OpenRouter LLM client.

Covers: circuit breaker, retry logic, usage tracking, model fallback,
        and error handling.
"""

import time
from unittest.mock import MagicMock, patch

import pytest
from openai import RateLimitError, APIError, APITimeoutError

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
        """Return a client instance with mocked OpenAI client."""
        with patch("eden.llm.client.OpenAI") as mock_openai:
            mock_openai_instance = MagicMock()
            mock_openai.return_value = mock_openai_instance
            client = OpenRouterClient(
                api_key="test-key",
                base_url="https://test.example.com",
                max_retries=3,
            )
            client._openai_mock = mock_openai_instance
            return client

    @pytest.mark.asyncio
    async def test_acall_success(self, client):
        """Async acall returns an LLMResponse."""
        mock_response = MagicMock()
        mock_response.choices = [MagicMock(message=MagicMock(content="Async Hello"))]
        mock_response.usage = MagicMock(
            prompt_tokens=5, completion_tokens=3, total_tokens=8
        )
        client._openai_mock.chat.completions.create.return_value = mock_response

        resp = await client.acall(agent="test", prompt="Say hello", slot="reasoning")
        assert isinstance(resp, LLMResponse)
        assert resp.content == "Async Hello"
        assert resp.usage.total_tokens == 8

    @pytest.mark.asyncio
    async def test_acall_timeout_retry(self, client):
        """APITimeoutError triggers retry on async calls."""
        client._openai_mock.chat.completions.create.side_effect = [
            APITimeoutError("timeout"),
            MagicMock(
                choices=[MagicMock(message=MagicMock(content="Recovered"))],
                usage=MagicMock(prompt_tokens=1, completion_tokens=1, total_tokens=2),
            ),
        ]

        resp = await client.acall(agent="test", prompt="test", slot="reasoning")
        assert resp.content == "Recovered"
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
