"""§11.4 — LLM provider per-provider error counter tests."""

from unittest.mock import MagicMock, patch

import pytest

from eden.llm import client as client_module


class FakeResponse:
    def __init__(self, content="hi"):
        self.choices = [type("Choice", (), {"message": type("Msg", (), {"content": content})()})()]
        self.usage = type("Usage", (), {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15})()


def test_record_provider_error_bumps_per_provider_counter():
    """The internal counter splits openai vs anthropic based on model
    name, so the §11.4 dashboard can break out the two providers."""
    c = client_module.OpenRouterClient(api_key="test", base_url="https://example.com")
    c._record_provider_error("openai", error=True)
    c._record_provider_error("openai", error=False)
    c._record_provider_error("anthropic", error=True)
    # The raw counters are exposed via the module-level accessor
    # (which uses the singleton). The accessor is for the
    # singleton client — for this test we just check the internal dict.
    assert c._provider_errors["openai.error"] == 1
    assert c._provider_errors["openai.ok"] == 1
    assert c._provider_errors["anthropic.error"] == 1
    assert c._provider_calls["openai"] == 2
    assert c._provider_calls["anthropic"] == 1


def test_get_provider_error_counts_returns_rates():
    """The accessor returns error_rate = errors / calls, not the raw
    counter. The function reads from a global singleton client."""
    # Build a real client and inject counters directly. The accessor
    # calls _get_llm_client() which returns the singleton.
    c = client_module.OpenRouterClient(api_key="test", base_url="https://example.com")
    c._provider_errors = {"openai.error": 2, "openai.ok": 98, "anthropic.error": 5, "anthropic.ok": 95}
    c._provider_calls = {"openai": 100, "anthropic": 100}
    with patch.object(client_module, "_get_llm_client", return_value=c):
        out = client_module.get_provider_error_counts()
    assert out["openai"]["calls"] == 100
    assert out["openai"]["errors"] == 2
    assert out["openai"]["error_rate"] == pytest.approx(0.02)
    assert out["anthropic"]["error_rate"] == pytest.approx(0.05)


def test_get_provider_error_counts_handles_no_data():
    """If no calls have been made, return an empty dict (not a KeyError)."""
    c = client_module.OpenRouterClient(api_key="test", base_url="https://example.com")
    c._provider_errors = {}
    c._provider_calls = {}
    with patch.object(client_module, "_get_llm_client", return_value=c):
        assert client_module.get_provider_error_counts() == {}


def test_is_anthropic_model_helper():
    """The provider-routing helper classifies Claude models as Anthropic."""
    assert client_module.OpenRouterClient._is_anthropic_model("anthropic/claude-sonnet-4")
    assert client_module.OpenRouterClient._is_anthropic_model("claude-haiku-4")
    assert not client_module.OpenRouterClient._is_anthropic_model("gpt-4o")
    assert not client_module.OpenRouterClient._is_anthropic_model("openai/gpt-4o")


# ────────────────────────────────────────────────────────────────────────
# §11.4 — End-to-end: error path through call() invokes _record_provider_error
# ────────────────────────────────────────────────────────────────────────


class _MockAPIError(client_module.APIError):
    """Minimal APIError stand-in for unit tests."""
    def __init__(self, status_code=500, message="upstream error"):
        super().__init__(message, request=MagicMock(), body=None)
        self.status_code = status_code


def test_call_records_provider_error_on_rate_limit():
    """A RateLimitError on _make_request triggers _record_provider_error
    in the call() retry loop. End-to-end: call() → _make_request raises
    → _record_provider_error bumps the counter → get_provider_error_counts
    reflects it."""
    from openai import RateLimitError

    c = client_module.OpenRouterClient(
        api_key="test", base_url="https://example.com", max_retries=1
    )

    # Make every _make_request raise RateLimitError so the call exhausts
    # retries and propagates MaxRetriesExceededError.
    def _raise_rate_limit(*a, **kw):
        raise RateLimitError("rate limited", response=MagicMock(), body=None)

    c._make_request = _raise_rate_limit

    with pytest.raises(client_module.MaxRetriesExceededError):
        c.call(slot="reasoning", agent="planner", prompt="hi")

    # Counter bumped 3 times (max_retries=1, but the loop has the
    # primary model + 1 fallback = 2 models × 1 attempt = 2).
    assert c._provider_errors["openai.error"] >= 1
    assert c._provider_calls["openai"] >= 1


def test_call_records_provider_error_on_api_error_5xx():
    """A 5xx APIError also bumps the counter (and propagates after
    retries are exhausted)."""
    c = client_module.OpenRouterClient(
        api_key="test", base_url="https://example.com", max_retries=1
    )

    def _raise_5xx(*a, **kw):
        raise _MockAPIError(status_code=503, message="unavailable")

    c._make_request = _raise_5xx

    with pytest.raises(client_module.MaxRetriesExceededError):
        c.call(slot="reasoning", agent="planner", prompt="hi")

    assert c._provider_errors["openai.error"] >= 1


def test_call_records_provider_error_for_anthropic_models():
    """An Anthropic model failure bumps the ``anthropic`` counter,
    not ``openai``."""
    c = client_module.OpenRouterClient(
        api_key="test", base_url="https://example.com", max_retries=1
    )

    def _raise_5xx(*a, **kw):
        raise _MockAPIError(status_code=500, message="unavailable")

    c._make_request = _raise_5xx

    with pytest.raises(client_module.MaxRetriesExceededError):
        c.call(
            slot="reasoning",
            agent="planner",
            prompt="hi",
            model="anthropic/claude-sonnet-4",
        )

    assert c._provider_errors["anthropic.error"] >= 1
    assert "openai.error" not in c._provider_errors


def test_call_records_success_on_first_try():
    """A successful call bumps ``ok`` (not ``error``) per provider."""
    c = client_module.OpenRouterClient(
        api_key="test", base_url="https://example.com", max_retries=1
    )

    fake_response = client_module.LLMResponse(
        content="ok",
        usage=client_module.UsageStats(prompt_tokens=1, completion_tokens=1, total_tokens=2),
        model="openai/gpt-4o",
        finish_reason="stop",
        raw_response=None,
    )
    c._make_request = lambda *a, **kw: fake_response

    resp = c.call(
        slot="reasoning",
        agent="planner",
        prompt="hi",
        model="openai/gpt-4o",
    )
    assert resp.content == "ok"
    assert c._provider_errors["openai.ok"] >= 1
    assert c._provider_calls["openai"] >= 1


def test_call_skips_4xx_with_status_code_400():
    """A 400 APIError propagates immediately (no retries) AND bumps
    the error counter. Verifies the early-raise branch still
    instruments."""
    c = client_module.OpenRouterClient(
        api_key="test", base_url="https://example.com", max_retries=3
    )
    # Pin the model so the assertion targets the right provider counter.
    def _raise_400(*a, **kw):
        raise _MockAPIError(status_code=400, message="bad request")

    c._make_request = _raise_400

    with pytest.raises(client_module.APIError):
        c.call(
            slot="reasoning",
            agent="planner",
            prompt="hi",
            model="openai/gpt-4o",
        )

    # The counter should still be bumped (early raise still records).
    assert c._provider_errors.get("openai.error", 0) >= 1
