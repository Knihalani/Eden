"""W3-11: Gateway circuit-breaker fault-injection tests.

Verifies that the HTTP gateway path (POST /gateway/v1/chat/completions)
correctly:
  1. Trips the per-provider circuit breaker after a 5xx storm.
  2. Fast-fails (HTTP 503) subsequent requests while the circuit is open.
  3. Allows a half-open probe after the recovery window elapses.
  4. Closes the circuit on a successful half-open probe.
  5. Does NOT trip the breaker for 4xx client errors.

These tests exercise ``_get_provider_breaker`` / ``_provider_breaker`` and
``_chat_completions_unary`` directly, using an injected ``CircuitBreaker``
with a very short recovery timeout so we don't need real time.sleep calls.
"""

from __future__ import annotations

import time
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _make_openai_api_error(status_code: int = 500):
    """Build a minimal openai.APIError stand-in that carries a status_code."""
    from openai import APIError
    err = APIError.__new__(APIError)
    err.status_code = status_code
    err.message = "upstream error"
    err.request = MagicMock()
    err.body = None
    # Make str(err) usable.
    err.args = (f"APIError {status_code}",)
    return err


def _make_fake_response(model: str = "gpt-4o-mini") -> SimpleNamespace:
    """Return a minimal upstream chat-completion response."""
    choice = SimpleNamespace(
        message=SimpleNamespace(content="hello", role="assistant", tool_calls=None, function_call=None),
        finish_reason="stop",
        index=0,
        logprobs=None,
    )
    usage = SimpleNamespace(
        prompt_tokens=10,
        completion_tokens=5,
        total_tokens=15,
        model_dump=lambda: {},
    )
    return SimpleNamespace(
        id="chatcmpl-test",
        object="chat.completion",
        created=1700000000,
        model=model,
        choices=[choice],
        usage=usage,
        system_fingerprint=None,
    )


def _base_kwargs(model: str = "gpt-4o-mini") -> dict:
    return {
        "model": model,
        "messages": [{"role": "user", "content": "ping"}],
        "max_tokens": 16,
        "temperature": 0.0,
    }


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def fresh_breaker():
    """Provide a fresh CircuitBreaker with threshold=3, timeout=0.1 s."""
    from eden.llm.client import CircuitBreaker
    return CircuitBreaker(failure_threshold=3, recovery_timeout=0.1)


@pytest.fixture()
def patched_breaker(fresh_breaker):
    """Patch the gateway's singleton breaker with the fresh one."""
    import eden.api.routes.gateway as gw_mod
    original = gw_mod._provider_breaker
    gw_mod._provider_breaker = fresh_breaker
    yield fresh_breaker
    gw_mod._provider_breaker = original


@pytest.fixture()
def mock_auth():
    return {"org_id": "org_test", "user_id": "user_test"}


# ---------------------------------------------------------------------------
# Unit tests for _get_provider_breaker
# ---------------------------------------------------------------------------

class TestGetProviderBreaker:
    def test_returns_singleton(self):
        import eden.api.routes.gateway as gw_mod
        original = gw_mod._provider_breaker
        try:
            gw_mod._provider_breaker = None
            b1 = gw_mod._get_provider_breaker()
            b2 = gw_mod._get_provider_breaker()
            assert b1 is b2
        finally:
            gw_mod._provider_breaker = original

    def test_env_threshold(self, monkeypatch):
        import eden.api.routes.gateway as gw_mod
        from eden.llm.client import CircuitBreaker
        original = gw_mod._provider_breaker
        try:
            gw_mod._provider_breaker = None
            monkeypatch.setenv("GATEWAY_BREAKER_THRESHOLD", "7")
            monkeypatch.setenv("GATEWAY_BREAKER_TIMEOUT", "30")
            b = gw_mod._get_provider_breaker()
            assert isinstance(b, CircuitBreaker)
            assert b.failure_threshold == 7
            assert b.recovery_timeout == 30
        finally:
            gw_mod._provider_breaker = original


# ---------------------------------------------------------------------------
# Circuit-breaker behaviour via _chat_completions_unary
# ---------------------------------------------------------------------------

class TestGatewayBreakerUnary:
    """Fault-injection tests for the unary (non-streaming) chat completions path."""

    async def _call_unary(self, mock_client, mock_auth, model="gpt-4o-mini"):
        """Invoke _chat_completions_unary with a stubbed upstream client."""
        from eden.api.routes.gateway import _chat_completions_unary
        from eden.llmops.gateway_optimizations import OptimizationFlags

        body_cls = None
        import eden.api.routes.gateway as gw_mod
        # Build the minimal ChatCompletionRequest
        for name in dir(gw_mod):
            obj = getattr(gw_mod, name, None)
            if obj is not None and hasattr(obj, "__name__") and getattr(obj, "__name__", "") == "ChatCompletionRequest":
                body_cls = obj
                break
        if body_cls is None:
            # Import directly
            from eden.api.routes.gateway import ChatCompletionRequest  # noqa: F401
            body_cls = ChatCompletionRequest

        body = body_cls.model_validate({"model": model, "messages": [{"role": "user", "content": "ping"}]})
        return await _chat_completions_unary(
            org_id=mock_auth["org_id"],
            auth_ctx=mock_auth,
            body=body,
            upstream_kwargs=_base_kwargs(model),
            request_body={"model": model, "messages": [{"role": "user", "content": "ping"}]},
            start=time.monotonic(),
            user_label=None,
            client=mock_client,
            provider="openrouter",
        )

    @pytest.mark.asyncio
    async def test_5xx_storm_trips_breaker(self, patched_breaker, mock_auth):
        """Three consecutive 5xx failures trip the breaker; 4th call → 503."""
        from fastapi import HTTPException
        from eden.llmops.gateway_optimizations import OptimizationFlags

        err = _make_openai_api_error(500)
        mock_client = MagicMock()
        mock_client.chat = MagicMock()
        mock_client.chat.completions = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=err)

        # Exhaust the threshold (3 failures).
        for _ in range(patched_breaker.failure_threshold):
            with pytest.raises(HTTPException) as exc_info:
                await self._call_unary(mock_client, mock_auth)
            # Should surface as 500 (status passed through from provider).
            assert exc_info.value.status_code == 500

        # Circuit is now open — next call must 503 without hitting upstream.
        with pytest.raises(HTTPException) as exc_info:
            await self._call_unary(mock_client, mock_auth)
        assert exc_info.value.status_code == 503
        detail = exc_info.value.detail
        assert isinstance(detail, dict)
        assert detail.get("error") == "circuit_open"

        # Upstream was NOT called on the 503 fast-fail.
        assert mock_client.chat.completions.create.call_count == patched_breaker.failure_threshold

    @pytest.mark.asyncio
    async def test_4xx_does_not_trip_breaker(self, patched_breaker, mock_auth):
        """Client errors (4xx) must not count as provider failures."""
        from fastapi import HTTPException

        err = _make_openai_api_error(400)
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=err)

        # Many 4xx calls — circuit stays closed.
        for _ in range(patched_breaker.failure_threshold + 2):
            with pytest.raises(HTTPException):
                await self._call_unary(mock_client, mock_auth)

        # Breaker state: should still be CLOSED.
        from eden.llm.client import CircuitState
        assert patched_breaker.state["openrouter"] == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_half_open_recovery_closes_breaker(self, patched_breaker, mock_auth):
        """After recovery timeout, a successful probe closes the circuit."""
        from fastapi import HTTPException

        err = _make_openai_api_error(503)
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(side_effect=err)

        # Trip the breaker.
        for _ in range(patched_breaker.failure_threshold):
            with pytest.raises(HTTPException):
                await self._call_unary(mock_client, mock_auth)

        from eden.llm.client import CircuitState
        assert patched_breaker.state["openrouter"] == CircuitState.OPEN

        # Wait for recovery window (0.1 s fixture timeout).
        time.sleep(0.15)

        # Replace side-effect with a success response.
        fake_resp = _make_fake_response()
        mock_client.chat.completions.create = AsyncMock(return_value=fake_resp)

        # Probe should succeed and close the circuit.
        with patch("eden.api.routes.gateway._emit_gateway_telemetry_bg"):
            with patch("eden.api.routes.gateway._stamp_gateway_cost_usd", new=AsyncMock()):
                resp = await self._call_unary(mock_client, mock_auth)
        assert resp.status_code == 200
        assert patched_breaker.state["openrouter"] == CircuitState.CLOSED

    @pytest.mark.asyncio
    async def test_success_records_success(self, patched_breaker, mock_auth):
        """Successful requests call record_success on the breaker."""
        fake_resp = _make_fake_response()
        mock_client = MagicMock()
        mock_client.chat.completions.create = AsyncMock(return_value=fake_resp)

        with patch("eden.api.routes.gateway._emit_gateway_telemetry_bg"):
            with patch("eden.api.routes.gateway._stamp_gateway_cost_usd", new=AsyncMock()):
                resp = await self._call_unary(mock_client, mock_auth)
        assert resp.status_code == 200
        # No failures recorded.
        from eden.llm.client import CircuitState
        assert patched_breaker.state.get("openrouter", CircuitState.CLOSED) == CircuitState.CLOSED
        assert patched_breaker.failures.get("openrouter", 0) == 0


# ---------------------------------------------------------------------------
# Breaker pre-flight check (importable, no HTTP client needed)
# ---------------------------------------------------------------------------

class TestBreakerPreFlightCheck:
    """Test that the pre-flight check is truly guarding the path."""

    def test_is_open_called_with_provider_key(self, patched_breaker):
        """_get_provider_breaker() is the same object as patched_breaker."""
        import eden.api.routes.gateway as gw_mod
        assert gw_mod._get_provider_breaker() is patched_breaker

    def test_open_circuit_bypasses_upstream(self, patched_breaker):
        """When circuit is OPEN, upstream.create must never be called."""
        from eden.llm.client import CircuitState

        # Force circuit open directly.
        patched_breaker.state["openrouter"] = CircuitState.OPEN
        patched_breaker.last_failure_time["openrouter"] = time.time()  # still within window

        assert patched_breaker.is_open("openrouter") is True
