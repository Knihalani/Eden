"""Tests for the ModelAdvisor SDK wrapper.

We don't hit the live API - we mock httpx.Client and verify that
the SDK's request shape + response parsing match what the
backend's /orgs/{org_id}/models/{compare,recommend,project}
endpoints accept and return.
"""

from __future__ import annotations

from unittest.mock import MagicMock

import httpx
import pytest

from eden_sdk.model_advisor import (
    ModelAdvisor,
    ModelAdvisorError,
    ModelComparison,
    Recommendation,
    SwitchProjection,
)


@pytest.fixture
def mock_transport():
    """A fake httpx transport that returns canned JSON responses."""
    return MagicMock()


@pytest.fixture
def advisor(mock_transport) -> ModelAdvisor:
    """Build a ModelAdvisor with a mocked transport."""
    adv = ModelAdvisor(
        base_url="https://test.eden.local",
        timeout=5.0,
    )
    # Replace the internal httpx.Client with our fake. We
    # bypass the constructor's lazy build by patching _post to
    # use the transport.
    adv._client = mock_transport
    adv._owns_client = True
    return adv


def _mock_response(status: int, payload: dict) -> httpx.Response:
    """Build an httpx.Response with the given status + JSON body."""
    request = httpx.Request("POST", "https://test.eden.local/")
    return httpx.Response(status, json=payload, request=request)


# ─────────────────────────────────────────────────────────────────────
# compare
# ─────────────────────────────────────────────────────────────────────


def test_compare_returns_modelcomparison(advisor):
    fake = _mock_response(200, {
        "current": {
            "provider": "openai", "model_id": "gpt-4o",
            "quality": 0.93, "latency_p95_ms": 700, "reliability": 0.999,
            "context_window": 128000,
            "cost_per_1k_input": 0.0025, "cost_per_1k_output": 0.010,
            "cost_per_1k_cache_read": 0.00125,
            "cost_per_1k_cache_write": None,
            "source": "static",
        },
        "candidate": {
            "provider": "openai", "model_id": "gpt-4o-mini",
            "quality": 0.85, "latency_p95_ms": 350, "reliability": 0.999,
            "context_window": 128000,
            "cost_per_1k_input": 0.00015, "cost_per_1k_output": 0.0006,
            "cost_per_1k_cache_read": 0.000075,
            "cost_per_1k_cache_write": None,
            "source": "static",
        },
        "delta_cost_per_1k_input": -0.00235,
        "delta_cost_per_1k_output": -0.0094,
        "delta_quality": -0.08,
        "delta_latency_p95_ms": -350,
        "delta_reliability": 0.0,
        "cost_ratio": 0.06,
    })
    advisor._client.post.return_value = fake
    cmp = advisor.compare(
        org_id="org_123",
        current=("openai", "gpt-4o"),
        candidate=("openai", "gpt-4o-mini"),
    )
    assert isinstance(cmp, ModelComparison)
    assert cmp.current.model_id == "gpt-4o"
    assert cmp.candidate.model_id == "gpt-4o-mini"
    assert cmp.candidate.cost_per_1k_cache_read == pytest.approx(0.000075)
    assert cmp.cost_ratio == pytest.approx(0.06)
    # URL + method + body shape:
    call = advisor._client.post.call_args
    assert call.args[0] == "https://test.eden.local/orgs/org_123/models/compare"
    body = call.kwargs["json"]
    assert body["current"]["model_id"] == "gpt-4o"
    assert body["candidate"]["provider"] == "openai"


def test_compare_4xx_raises_advisor_error(advisor):
    fake = _mock_response(404, {"detail": "Unknown model: gpt-99"})
    advisor._client.post.return_value = fake
    with pytest.raises(ModelAdvisorError) as exc_info:
        advisor.compare(
            org_id="org_123",
            current=("openai", "gpt-4o"),
            candidate=("openai", "gpt-99"),
        )
    assert exc_info.value.status_code == 404
    assert "gpt-99" in exc_info.value.reason


def test_compare_transport_error_raises(advisor):
    advisor._client.post.side_effect = httpx.ConnectError("dns down")
    with pytest.raises(ModelAdvisorError) as exc_info:
        advisor.compare(
            org_id="org_123",
            current=("openai", "gpt-4o"),
            candidate=("openai", "gpt-4o-mini"),
        )
    assert exc_info.value.status_code == 0
    assert "dns" in exc_info.value.reason.lower()


# ─────────────────────────────────────────────────────────────────────
# recommend
# ─────────────────────────────────────────────────────────────────────


def test_recommend_pick_mode_omits_current(advisor):
    fake = _mock_response(200, {
        "recommended_provider": "anthropic",
        "recommended_model_id": "claude-sonnet-4-6",
        "score": 0.82,
        "rationale": "frontier-tier quality; fast",
        "monthly_savings_usd": None,
        "current_provider": None,
        "current_model_id": None,
        "runners_up": [
            {
                "provider": "openai", "model_id": "gpt-4o",
                "score": 0.79, "rationale": "balanced",
            },
        ],
        "empty_history": False,
    })
    advisor._client.post.return_value = fake
    rec = advisor.recommend(
        org_id="org_123",
        candidates=[
            ("openai", "gpt-4o"),
            ("anthropic", "claude-sonnet-4-6"),
        ],
    )
    assert isinstance(rec, Recommendation)
    assert rec.recommended_model == ("anthropic", "claude-sonnet-4-6")
    assert rec.monthly_savings_usd is None
    assert rec.current_model_id is None
    # No "current" key in the request body.
    body = advisor._client.post.call_args.kwargs["json"]
    assert body["mode"] == "pick"
    assert "current" not in body


def test_recommend_switch_mode_includes_current(advisor):
    fake = _mock_response(200, {
        "recommended_provider": "openai",
        "recommended_model_id": "gpt-4o-mini",
        "score": 0.74,
        "rationale": "saves 65% vs current",
        "monthly_savings_usd": 195.0,
        "current_provider": "openai",
        "current_model_id": "gpt-4o",
        "runners_up": [],
        "empty_history": False,
    })
    advisor._client.post.return_value = fake
    rec = advisor.recommend(
        org_id="org_123",
        candidates=[("openai", "gpt-4o"), ("openai", "gpt-4o-mini")],
        current=("openai", "gpt-4o"),
        window_days=14,
    )
    assert rec.recommended_model_id == "gpt-4o-mini"
    assert rec.monthly_savings_usd == pytest.approx(195.0)
    body = advisor._client.post.call_args.kwargs["json"]
    assert body["mode"] == "switch"
    assert body["current"]["model_id"] == "gpt-4o"
    assert body["window_days"] == 14


def test_recommend_empty_candidates_raises(advisor):
    with pytest.raises(ValueError, match="at least one"):
        advisor.recommend(org_id="org_123", candidates=[])


# ─────────────────────────────────────────────────────────────────────
# project
# ─────────────────────────────────────────────────────────────────────


def test_project_returns_switchprojection(advisor):
    fake = _mock_response(200, {
        "current_provider": "openai",
        "current_model_id": "gpt-4o",
        "candidate_provider": "openai",
        "candidate_model_id": "gpt-4o-mini",
        "current_total_usd": 300.0,
        "projected_total_usd": 35.0,
        "savings_usd": 265.0,
        "savings_pct": 88.3,
        "per_request_savings_usd": 0.0088,
        "cache_savings_usd": 5.0,
        "window_days": 30,
        "requests_in_window": 30000,
    })
    advisor._client.post.return_value = fake
    proj = advisor.project(
        org_id="org_123",
        current=("openai", "gpt-4o"),
        candidate=("openai", "gpt-4o-mini"),
    )
    assert isinstance(proj, SwitchProjection)
    assert proj.savings_pct == pytest.approx(88.3)
    assert proj.requests_in_window == 30000
    # Body shape
    body = advisor._client.post.call_args.kwargs["json"]
    assert body["scale_factor"] == 1.0
    assert body["window_days"] == 30


def test_project_with_scale_factor(advisor):
    fake = _mock_response(200, {
        "current_provider": "openai", "current_model_id": "gpt-4o",
        "candidate_provider": "openai", "candidate_model_id": "gpt-4o-mini",
        "current_total_usd": 600.0, "projected_total_usd": 70.0,
        "savings_usd": 530.0, "savings_pct": 88.3,
        "per_request_savings_usd": 0.0088, "cache_savings_usd": 10.0,
        "window_days": 30, "requests_in_window": 60000,
    })
    advisor._client.post.return_value = fake
    proj = advisor.project(
        org_id="org_123",
        current=("openai", "gpt-4o"),
        candidate=("openai", "gpt-4o-mini"),
        scale_factor=2.0,
    )
    body = advisor._client.post.call_args.kwargs["json"]
    assert body["scale_factor"] == 2.0
    assert proj.requests_in_window == 60000


# ─────────────────────────────────────────────────────────────────────
# Configuration
# ─────────────────────────────────────────────────────────────────────


def test_advisor_uses_explicit_base_url():
    """base_url override wins over the SDK config default."""
    adv = ModelAdvisor(base_url="https://my-private-eden.example.com")
    assert adv.base_url == "https://my-private-eden.example.com"


def test_advisor_strips_trailing_slash():
    adv = ModelAdvisor(base_url="https://test.example.com/")
    assert adv.base_url == "https://test.example.com"


def test_advisor_close_releases_owned_client():
    """close() is idempotent and only closes the client we own."""
    import httpx as _httpx

    adv = ModelAdvisor(base_url="https://test.example.com")
    # Build a real httpx client so close() has something to act on.
    real = _httpx.Client(timeout=1.0)
    adv._client = real
    adv._owns_client = True
    adv.close()
    # Second close is a no-op.
    adv.close()
    assert adv._client is None
