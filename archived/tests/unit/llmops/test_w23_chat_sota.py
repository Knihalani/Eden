"""Wave 23 — ChatSidebar SOTA pure helpers (T2-only)."""

from __future__ import annotations

from eden.llmops.chat_sota import (
    cite_before_claim,
    classify_chat_tier,
    estimate_turn_cost_usd,
    model_for_tier,
    resolve_picker_model,
    ttft_budget_ms,
    ttft_warning,
)
from eden.optimization.model_router import ModelTier


def test_classify_always_t2() -> None:
    assert classify_chat_tier("what is p95?") == ModelTier.T2
    assert classify_chat_tier("export slow traces as csv") == ModelTier.T2
    assert classify_chat_tier("/filter latency > 2s", preferred_tier="t1") == ModelTier.T2


def test_resolve_picker_always_t2() -> None:
    model, tier = resolve_picker_model(preferred_tier="t1")
    assert model is None
    assert tier == "t2"
    model2, tier2 = resolve_picker_model(preferred_tier="t3", preferred_model="auto")
    assert model2 is None
    assert tier2 == "t2"
    assert model_for_tier(ModelTier.T2)


def test_cite_before_claim_flags_uncited_ids() -> None:
    out = cite_before_claim(
        "Trace trc_abc12345 failed on tool call.",
        citations=[],
    )
    assert out["ok"] is False
    assert out["warning"]


def test_cite_before_claim_ok_when_cited() -> None:
    out = cite_before_claim(
        "Trace trc_abc12345 failed.",
        citations=[{"kind": "trace", "id": "trc_abc12345", "label": "t"}],
    )
    assert out["ok"] is True


def test_ttft_budget_and_warning() -> None:
    assert ttft_budget_ms("t2") == 3000
    assert ttft_warning(4000, "t2")
    assert ttft_warning(500, "t2") is None


def test_estimate_turn_cost_shape() -> None:
    est = estimate_turn_cost_usd("x-ai/grok-4.5", prompt_tokens=1000, completion_tokens=200)
    assert "estimated_usd" in est
    assert est["estimated_usd"] >= 0
