"""FEAT-131 — playground llm_judge adapter tests."""

from __future__ import annotations

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from eden.llmops.judges.base import JudgeScore
from eden.llmops.judges.unified import UnifiedJudge
from eden.playground.llm_judge_adapter import (
    dataset_row_to_telemetry_event,
    llm_client_available,
    score_llm_judge_async,
    score_llm_judge_sync,
)
from eden.playground.scorers import SCORERS, run_scorers


def _fake_judge_scores(*, axis: str = "correctness", score: float = 0.82) -> list[JudgeScore]:
    return [
        JudgeScore(
            judge_name=axis,
            judge_version="test",
            trace_id="tr_test",
            span_id=None,
            score=score,
            rationale=f"ok {axis}",
            model="test-model",
            latency_ms=12.0,
            cost_usd=0.001,
        )
    ]


def test_dataset_row_to_telemetry_event_shapes_openai_payload() -> None:
    event = dataset_row_to_telemetry_event(
        output="Paris is the capital.",
        input_text="What is the capital of France?",
        expected="Paris",
    )
    assert event.event_type == "openai.chat.completion"
    assert event.payload["openai"]["response_text"] == "Paris is the capital."
    assert "Expected reference" in event.payload["task"]
    assert "playground" in event.tags


@pytest.mark.asyncio
async def test_score_llm_judge_async_uses_mocked_unified_judge() -> None:
    judge = UnifiedJudge()
    judge.score = AsyncMock(return_value=_fake_judge_scores(score=0.91))  # type: ignore[method-assign]

    score, detail, rows = await score_llm_judge_async(
        "Paris is the capital.",
        "Paris",
        {"axis": "correctness"},
        input_text="Capital of France?",
        judge=judge,
        llm_client=MagicMock(),
    )

    assert score == pytest.approx(0.91)
    assert detail is not None
    assert "correctness" in detail
    assert len(rows) == 1
    judge.score.assert_awaited_once()
    event = judge.score.await_args.args[0]
    assert event.payload["openai"]["response_text"] == "Paris is the capital."


@pytest.mark.asyncio
async def test_score_llm_judge_async_unknown_axis_fails_clearly() -> None:
    score, detail, rows = await score_llm_judge_async(
        "hello",
        None,
        {"axis": "tone"},
        llm_client=MagicMock(),
    )
    assert score is None
    assert detail is not None
    assert "unknown judge axis" in detail
    assert rows == []


@pytest.mark.asyncio
async def test_score_llm_judge_async_without_llm_fails_clearly() -> None:
    with patch(
        "eden.playground.llm_judge_adapter.try_get_llm_client",
        return_value=None,
    ):
        score, detail, rows = await score_llm_judge_async(
            "hello",
            None,
            {"axis": "correctness"},
        )
    assert score is None
    assert detail is not None
    assert "llm unavailable" in detail
    assert rows == []


def test_score_llm_judge_sync_maps_unified_judge_response() -> None:
    judge = UnifiedJudge()
    judge.score = AsyncMock(return_value=_fake_judge_scores(axis="safety", score=0.75))  # type: ignore[method-assign]

    score, detail = score_llm_judge_sync(
        "safe answer",
        None,
        {"axis": "safety"},
        judge=judge,
        llm_client=MagicMock(),
    )
    assert score == pytest.approx(0.75)
    assert detail is not None
    assert "safety" in detail


def test_run_scorers_registers_llm_judge() -> None:
    assert "llm_judge" in SCORERS


def test_run_scorers_llm_judge_via_registry() -> None:
    judge = UnifiedJudge()
    judge.score = AsyncMock(return_value=_fake_judge_scores(score=0.88))  # type: ignore[method-assign]

    with patch(
        "eden.playground.llm_judge_adapter.try_get_llm_client",
        return_value=MagicMock(),
    ), patch(
        "eden.playground.llm_judge_adapter.UnifiedJudge",
        return_value=judge,
    ):
        [result] = run_scorers(
            [{"type": "llm_judge", "axis": "correctness"}],
            output="good answer",
            expected="good answer",
            input_text="prompt",
        )

    assert result["name"] == "llm_judge"
    assert result["score"] == pytest.approx(0.88)


def test_run_scorers_llm_judge_without_llm_returns_none_not_fake_score() -> None:
    with patch(
        "eden.playground.llm_judge_adapter.try_get_llm_client",
        return_value=None,
    ):
        [result] = run_scorers(
            [{"type": "llm_judge"}],
            output="answer",
            expected=None,
        )

    assert result["score"] is None
    assert result["detail"] is not None
    assert "llm unavailable" in result["detail"]


def test_llm_client_available_reflects_api_key() -> None:
    with patch("eden.config.get_settings") as mock_settings:
        mock_settings.return_value = SimpleNamespace(openrouter_api_key="sk-test")
        assert llm_client_available() is True
        mock_settings.return_value = SimpleNamespace(openrouter_api_key="")
        assert llm_client_available() is False


@pytest.mark.asyncio
async def test_score_llm_judge_async_surfaces_judge_error_not_fake_score() -> None:
    judge = UnifiedJudge()
    judge.score = AsyncMock(  # type: ignore[method-assign]
        return_value=[
            JudgeScore(
                judge_name="correctness",
                judge_version="test",
                trace_id="tr",
                span_id=None,
                score=0.5,
                rationale="no_score:judge_error:Timeout",
                model="n/a",
            )
        ]
    )

    score, detail, _ = await score_llm_judge_async(
        "answer",
        None,
        {"axis": "correctness"},
        judge=judge,
        llm_client=MagicMock(),
    )
    assert score is None
    assert detail is not None
    assert "judge error" in detail
