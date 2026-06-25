"""Tests for the JudgeDetector + the LLM-judge toggle in
``ProductionMonitor.evaluate_hallucination``."""

from datetime import UTC
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.insights.detectors import JudgeDetector

# ── JudgeDetector ──────────────────────────────────────────────────


def _fake_row(**kwargs) -> dict:
    from datetime import datetime, timezone
    base = {
        "judge_run_id": "jr_1",
        "judge_name": "hallucination",
        "judge_version": "2026-06-03",
        "trace_id": "tr_1",
        "span_id": "sp_1",
        "score": 0.3,
        "rationale": "test rationale",
        "model": "claude-haiku",
        "scored_at": datetime(2026, 6, 3, 12, 0, 0, tzinfo=UTC),
        "latency_ms": 150.0,
    }
    base.update(kwargs)
    return base


def test_judge_detector_severity_buckets():
    j = JudgeDetector()
    # Low score → critical
    assert j._score_to_severity(0.1, "hallucination") == "critical"
    assert j._score_to_severity(0.4, "hallucination") == "high"
    assert j._score_to_severity(0.6, "hallucination") == "medium"
    assert j._score_to_severity(0.8, "hallucination") == "low"
    assert j._score_to_severity(0.95, "hallucination") == "info"


def test_judge_detector_is_in_default_registry():
    from eden.insights.detectors import DetectorRegistry
    r = DetectorRegistry()
    assert "judge_scores_bridge" in r._detectors


def test_judge_detector_analyze_empty_when_no_rows(monkeypatch):
    """When the DB is unreachable, ``analyze`` returns [] cleanly."""
    def _raise():
        raise OSError("DB unreachable")

    monkeypatch.setattr(
        "eden.storage.postgres.get_postgres_client", _raise
    )
    d = JudgeDetector()
    # analyze() catches the exception and returns [].
    assert d.analyze([]) == []


# ── ProductionMonitor LLM-judge toggle ────────────────────────────


@pytest.mark.asyncio
async def test_evaluate_hallucination_heuristic_only_when_toggle_off(monkeypatch):
    """Default (``production_monitor_use_llm_judge = False``) uses the
    heuristic and does not call the LLM."""
    # Ensure the toggle is off.
    from eden.config import get_settings
    from eden.llmops.production_monitor import ProductionMonitor
    settings = get_settings()
    monkeypatch.setattr(
        settings, "production_monitor_use_llm_judge", False
    )

    pm = ProductionMonitor()
    out = await pm.evaluate_hallucination(
        generated_code="import fake_module; print('hi')",
        spec="print hello",
    )
    # ``fake_module`` triggers the heuristic → hallucination_detected=True
    assert out["hallucination_detected"] is True
    assert "issues" in out
    assert any("fake_module" in i for i in out["issues"])
    # No judge_model field — confirms we did not hit the LLM path.
    assert "judge_model" not in out
    # Sample gate: only ~1.2% of inputs land in the judge bucket.
    # We don't assert on ``sampled_out`` (it's deterministic by
    # generated_code hash, so a different input would flip the flag).


@pytest.mark.asyncio
async def test_evaluate_hallucination_llm_judge_when_toggle_on(monkeypatch):
    """When the toggle is on, the LLM judge is called and its score
    is the primary confidence."""
    from eden.config import get_settings
    from eden.llmops.production_monitor import ProductionMonitor
    settings = get_settings()
    monkeypatch.setattr(
        settings, "production_monitor_use_llm_judge", True
    )

    # Stub the LLM client's call() to return a fixed response.
    class _FakeResp:
        content = '{"score": 0.42, "rationale": "looks decent"}'
        model = "claude-haiku"
    fake_client = MagicMock()
    fake_client.call = MagicMock(return_value=_FakeResp())

    with patch(
        "eden.llm.client.OpenRouterClient",
        return_value=fake_client,
    ):
        pm = ProductionMonitor()
        out = await pm.evaluate_hallucination(
            generated_code="import os; print('hi')",
            spec="print hello",
        )
    # The LLM score (0.42) becomes the primary confidence.
    assert abs(out["confidence"] - 0.42) < 0.01
    assert out["rationale"] == "looks decent"
    assert out["judge_model"] == "claude-haiku"
    # Heuristic score is preserved for transparency.
    assert "heuristic_score" in out


@pytest.mark.asyncio
async def test_evaluate_hallucination_llm_failure_falls_back(monkeypatch):
    """If the LLM judge throws, the heuristic result is returned with
    a ``judge_error`` field — the pipeline never blocks."""
    from eden.config import get_settings
    from eden.llmops.production_monitor import ProductionMonitor
    settings = get_settings()
    monkeypatch.setattr(
        settings, "production_monitor_use_llm_judge", True
    )

    # Force the LLM call to raise.
    fake_client = MagicMock()
    fake_client.call = MagicMock(side_effect=RuntimeError("LLM down"))

    with patch(
        "eden.llm.client.OpenRouterClient",
        return_value=fake_client,
    ):
        pm = ProductionMonitor()
        out = await pm.evaluate_hallucination(
            generated_code="import os",
            spec="print hi",
        )
    # Should still have a confidence (the heuristic value).
    assert 0.0 <= out["confidence"] <= 1.0
    # The judge catches the LLM error itself and returns a 0.5 with
    # a no_score rationale. Production monitor surfaces that as
    # ``rationale`` so the pipeline never blocks.
    assert "judge_error" in out.get("rationale", "") or "no_score" in out.get("rationale", "")
    # The judge model is still reported even when the call errored —
    # it's the LLM slot, not the call result.
    # (The test only asserts the failure path is graceful.)
