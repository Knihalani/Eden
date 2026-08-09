"""Runaway-cost gates on the T1 trace annotator.

The annotator used to fire one LLM call per finalized trace at 100%
coverage with no budget, amplified 3x by the consumer's retry ladder.
These tests pin the sampling, the budget gate, and the no-retry rule.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

from eden.evaluation import annotator as ann

ORG = "org-cost-1"


# ── deterministic sampling ──────────────────────────────────────────


def test_sampled_in_is_stable_for_the_same_trace() -> None:
    """A retry must never re-roll the sample decision."""
    trace_id = "trace-abc-123"
    first = ann.sampled_in(trace_id, 0.5)
    assert all(ann.sampled_in(trace_id, 0.5) is first for _ in range(100))


def test_sampled_in_respects_the_rate() -> None:
    ids = [f"trace-{i}" for i in range(4000)]
    frac = sum(1 for t in ids if ann.sampled_in(t, 0.1)) / len(ids)
    assert 0.07 < frac < 0.13, f"10% sample produced {frac:.3f}"


def test_sampled_in_is_monotonic_in_the_rate() -> None:
    """Raising the rate can only add traces, never swap the set."""
    ids = [f"trace-{i}" for i in range(500)]
    low = {t for t in ids if ann.sampled_in(t, 0.1)}
    high = {t for t in ids if ann.sampled_in(t, 0.5)}
    assert low <= high


def test_sampled_in_edges() -> None:
    assert ann.sampled_in("x", 1.0) is True
    assert ann.sampled_in("x", 0.0) is False
    # Out-of-range values are clamped, not trusted.
    assert ann.sampled_in("x", 5.0) is True
    assert ann.sampled_in("x", -1.0) is False


def test_default_sample_rate_is_not_full_coverage() -> None:
    from eden.config import get_settings

    rate = get_settings().trace_annotator_sample_rate
    assert 0.0 < rate < 1.0, "annotator must not default to 100% coverage"


# ── budget gate ─────────────────────────────────────────────────────


async def test_budget_ok_false_when_feature_killed() -> None:
    with patch(
        "eden.llmops.feature_kills.is_feature_enabled",
        new=AsyncMock(return_value=False),
    ):
        assert await ann._budget_ok(ORG) is False


async def test_budget_ok_false_when_budget_exhausted() -> None:
    with (
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.check_budget",
            new=AsyncMock(return_value=(False, 25.0, 25.0)),
        ),
    ):
        assert await ann._budget_ok(ORG) is False


async def test_budget_ok_true_when_both_allow() -> None:
    with (
        patch(
            "eden.llmops.feature_kills.is_feature_enabled",
            new=AsyncMock(return_value=True),
        ),
        patch(
            "eden.closed_loop.autonomy_policy.check_budget",
            new=AsyncMock(return_value=(True, 1.0, 25.0)),
        ),
    ):
        assert await ann._budget_ok(ORG) is True


async def test_budget_ok_fails_closed_when_backend_raises() -> None:
    with patch(
        "eden.llmops.feature_kills.is_feature_enabled",
        new=AsyncMock(side_effect=RuntimeError("pg down")),
    ):
        assert await ann._budget_ok(ORG) is False


# ── the gates actually prevent the LLM call ─────────────────────────

_EVENTS = [{"event_type": "llm.call", "name": "step", "payload": {"x": 1}}]


async def test_unsampled_trace_never_calls_the_llm() -> None:
    route = AsyncMock()
    with (
        patch.object(ann, "sampled_in", return_value=False),
        patch("eden.llm.internal_router.route_async", new=route),
    ):
        result = await ann.annotate_trace(ORG, "trace-x", _EVENTS)
    assert result.skipped_reason == "not_sampled"
    route.assert_not_awaited()


async def test_exhausted_budget_never_calls_the_llm() -> None:
    route = AsyncMock()
    with (
        patch.object(ann, "sampled_in", return_value=True),
        patch.object(ann, "_budget_ok", new=AsyncMock(return_value=False)),
        patch("eden.llm.internal_router.route_async", new=route),
    ):
        result = await ann.annotate_trace(ORG, "trace-x", _EVENTS)
    assert result.skipped_reason == "budget_exhausted"
    route.assert_not_awaited()


async def test_sampled_and_budgeted_trace_does_call_the_llm() -> None:
    resp = type(
        "R", (), {"content": '{"tags": ["success"], "confidence": 0.9}',
                  "cost_usd": 0.0, "model": "fast"}
    )()
    route = AsyncMock(return_value=resp)
    with (
        patch.object(ann, "sampled_in", return_value=True),
        patch.object(ann, "_budget_ok", new=AsyncMock(return_value=True)),
        patch("eden.llm.internal_router.route_async", new=route),
    ):
        result = await ann.annotate_trace(ORG, "trace-x", _EVENTS)
    route.assert_awaited_once()
    assert result.skipped_reason is None
    assert result.tags == ["success"]
    # Spend must be attributed, or the budget gate can never trip.
    kwargs = route.await_args.kwargs
    assert kwargs["org_id"] == ORG
    assert kwargs["feature"] == "trace_annotator"


async def test_annotator_records_spend_against_the_budget() -> None:
    resp = type(
        "R", (), {"content": '{"tags": [], "confidence": 0.1}',
                  "cost_usd": 0.004, "model": "fast"}
    )()
    record = AsyncMock()
    with (
        patch.object(ann, "sampled_in", return_value=True),
        patch.object(ann, "_budget_ok", new=AsyncMock(return_value=True)),
        patch("eden.llm.internal_router.route_async", new=AsyncMock(return_value=resp)),
        patch("eden.closed_loop.autonomy_policy.record_spend", new=record),
    ):
        await ann.annotate_trace(ORG, "trace-x", _EVENTS)
    record.assert_awaited_once()
    assert record.await_args.args[1] == 0.004


async def test_records_spend_from_the_real_llm_response_shape() -> None:
    """The regression this file missed.

    ``test_annotator_records_spend_against_the_budget`` above passes a
    duck-typed stub carrying ``cost_usd``, so it passed while production
    was broken: the real ``LLMResponse`` is
    ``(content, usage, model, finish_reason, raw_response)`` and has no
    ``cost_usd`` field at all. Cost lives on ``UsageStats.cost``.

    Reading ``getattr(resp, "cost_usd", 0.0)`` therefore always yielded
    0.0, so ``record_spend`` was never called and the daily maintenance
    budget checked by ``_budget_ok`` could never accumulate — the cap
    could not trip no matter how much the annotator spent. This is the
    only LLM feature enabled by default, so it was the gate that most
    needed to work.

    Build the response from the real classes so a future refactor of
    either type breaks this test rather than production.
    """
    from eden.llm.client import LLMResponse, UsageStats

    resp = LLMResponse(
        content='{"tags": ["success"], "confidence": 0.9}',
        usage=UsageStats(
            prompt_tokens=100, completion_tokens=20, total_tokens=120,
            cost=0.0042,
        ),
        model="tencent/hy3",
        finish_reason="stop",
    )
    record = AsyncMock()
    with (
        patch.object(ann, "sampled_in", return_value=True),
        patch.object(ann, "_budget_ok", new=AsyncMock(return_value=True)),
        patch("eden.llm.internal_router.route_async", new=AsyncMock(return_value=resp)),
        patch("eden.closed_loop.autonomy_policy.record_spend", new=record),
    ):
        result = await ann.annotate_trace(ORG, "trace-real", _EVENTS)

    record.assert_awaited_once(), "spend from usage.cost must reach the ledger"
    assert record.await_args.args[1] == 0.0042
    assert result.cost_usd == 0.0042


async def test_zero_cost_response_does_not_record_spend() -> None:
    """A genuinely free call must not write a ledger row."""
    from eden.llm.client import LLMResponse, UsageStats

    resp = LLMResponse(
        content='{"tags": [], "confidence": 0.1}',
        usage=UsageStats(total_tokens=5, cost=None),
        model="tencent/hy3",
        finish_reason="stop",
    )
    record = AsyncMock()
    with (
        patch.object(ann, "sampled_in", return_value=True),
        patch.object(ann, "_budget_ok", new=AsyncMock(return_value=True)),
        patch("eden.llm.internal_router.route_async", new=AsyncMock(return_value=resp)),
        patch("eden.closed_loop.autonomy_policy.record_spend", new=record),
    ):
        await ann.annotate_trace(ORG, "trace-free", _EVENTS)

    record.assert_not_awaited()
