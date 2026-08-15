"""Budget gates for the online SLM judge and the rules-engine rewind.

The SLM hook had no per-org ceiling and booked a hardcoded cost AFTER
spending; rules defaulted to sampling 100% of matching traces; and the
rewind loop replayed 100 traces x N rules with no budget check at all.
"""

from __future__ import annotations

import inspect
from unittest.mock import AsyncMock, MagicMock, patch

from eden.evaluation.online import rules_engine as re_mod
from eden.evaluation.online import slm_hook

ORG = "org-slm-1"


# ── slm_hook.budget_allows ──────────────────────────────────────────


async def test_budget_allows_false_when_feature_killed() -> None:
    with patch(
        "eden.llmops.feature_kills.is_feature_enabled",
        new=AsyncMock(return_value=False),
    ):
        assert await slm_hook.budget_allows(ORG) is False


async def test_budget_allows_false_when_budget_exhausted() -> None:
    with (
        patch("eden.llmops.feature_kills.is_feature_enabled",
              new=AsyncMock(return_value=True)),
        patch("eden.closed_loop.autonomy_policy.check_budget",
              new=AsyncMock(return_value=(False, 30.0, 25.0))),
    ):
        assert await slm_hook.budget_allows(ORG) is False


async def test_budget_allows_fails_closed_on_backend_error() -> None:
    with patch(
        "eden.llmops.feature_kills.is_feature_enabled",
        new=AsyncMock(side_effect=RuntimeError("pg down")),
    ):
        assert await slm_hook.budget_allows(ORG) is False


async def test_budget_allows_true_when_both_allow() -> None:
    with (
        patch("eden.llmops.feature_kills.is_feature_enabled",
              new=AsyncMock(return_value=True)),
        patch("eden.closed_loop.autonomy_policy.check_budget",
              new=AsyncMock(return_value=(True, 0.5, 25.0))),
    ):
        assert await slm_hook.budget_allows(ORG) is True


# ── the gate runs BEFORE the LLM call ───────────────────────────────


async def test_exhausted_budget_skips_the_llm_entirely() -> None:
    call_llm = AsyncMock()
    with (
        patch.object(slm_hook, "budget_allows", new=AsyncMock(return_value=False)),
        patch("eden.autonomous._common._call_llm", new=call_llm),
    ):
        result = await slm_hook.score_with_slm(
            ORG, trace_id="t1", payload={"text": "hi"}
        )
    assert result is None
    call_llm.assert_not_awaited()


async def test_allowed_budget_reaches_the_llm() -> None:
    raw = '{"score": 0.8, "passed": true, "confidence": 0.9, "rationale": "ok"}'
    with (
        patch.object(slm_hook, "budget_allows", new=AsyncMock(return_value=True)),
        patch("eden.autonomous._common._call_llm", new=AsyncMock(return_value=raw)),
        patch("eden.closed_loop.autonomy_policy.record_spend", new=AsyncMock()),
    ):
        result = await slm_hook.score_with_slm(
            ORG, trace_id="t1", payload={"text": "hi"}
        )
    assert result is not None
    assert result["judge_tier"] == "slm"
    assert result["cost_usd"] == slm_hook._EST_COST_USD


# ── new-rule sample rate ────────────────────────────────────────────


def test_new_rules_default_to_a_sampled_rate() -> None:
    default = inspect.signature(
        re_mod.OnlineScoringRulesEngine.create_rule
    ).parameters["sample_rate"].default
    assert default == re_mod.DEFAULT_NEW_RULE_SAMPLE_RATE
    assert 0.0 < default < 1.0, "new rules must not default to 100% sampling"


def test_existing_persisted_rules_are_not_retuned() -> None:
    """``_row_to_rule`` must keep hydrating stored values as-is."""
    rule = re_mod._row_to_rule(
        {
            "id": "r1",
            "org_id": ORG,
            "name": "n",
            "sample_rate": 1.0,
            "scorer_type": "slm",
        }
    )
    assert rule.sample_rate == 1.0


# ── rewind stops when the budget runs out ───────────────────────────


def _fake_client(trace_ids: list[str]) -> MagicMock:
    client = MagicMock()
    client.execute = AsyncMock()
    client.fetch = AsyncMock(return_value=[{"trace_id": t} for t in trace_ids])
    return client


async def test_rewind_stops_immediately_when_budget_is_exhausted() -> None:
    engine = re_mod.OnlineScoringRulesEngine()
    client = _fake_client([f"t{i}" for i in range(100)])
    apply_rules = AsyncMock()
    with (
        patch.object(engine, "_client", new=AsyncMock(return_value=client)),
        patch.object(engine, "apply_rules_for_trace", new=apply_rules),
        patch.object(re_mod, "budget_allows", new=AsyncMock(return_value=False)),
    ):
        job_id = await engine.rewind(ORG, "rule-1")

    assert job_id is not None
    apply_rules.assert_not_awaited(), "rewind spent with no budget"
    status = client.execute.await_args.args[-1]
    assert status == "budget_exhausted"


async def test_rewind_stops_partway_when_budget_runs_out() -> None:
    engine = re_mod.OnlineScoringRulesEngine()
    client = _fake_client([f"t{i}" for i in range(100)])
    apply_rules = AsyncMock()
    # Allow the first 3 traces, then the org runs dry.
    allowed = iter([True, True, True] + [False] * 200)
    with (
        patch.object(engine, "_client", new=AsyncMock(return_value=client)),
        patch.object(engine, "apply_rules_for_trace", new=apply_rules),
        patch.object(re_mod, "budget_allows",
                     new=AsyncMock(side_effect=lambda _org: next(allowed))),
    ):
        await engine.rewind(ORG, "rule-1")

    assert apply_rules.await_count == 3, "rewind ignored the budget mid-loop"
    processed = client.execute.await_args.args[-2]
    assert processed == 3


async def test_rewind_completes_when_budget_holds() -> None:
    engine = re_mod.OnlineScoringRulesEngine()
    client = _fake_client([f"t{i}" for i in range(5)])
    apply_rules = AsyncMock()
    with (
        patch.object(engine, "_client", new=AsyncMock(return_value=client)),
        patch.object(engine, "apply_rules_for_trace", new=apply_rules),
        patch.object(re_mod, "budget_allows", new=AsyncMock(return_value=True)),
    ):
        await engine.rewind(ORG, "rule-1")

    assert apply_rules.await_count == 5
    assert client.execute.await_args.args[-1] == "completed"
