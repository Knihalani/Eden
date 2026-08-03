"""The auto-patch LLM budget must not be a no-op off the sweep path.

``try_consume_llm_call`` returned True whenever no budget had been armed,
and only ``ImprovementAgent._sweep_body`` ever armed one — so the
closed-loop ``propose_patch`` route spent without any ceiling.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from eden.improvement import sweep_budget as sb


@pytest.fixture(autouse=True)
def _clean_budget():
    sb.clear_sweep_llm_budget()
    yield
    sb.clear_sweep_llm_budget()


# ── existing sweep behaviour is preserved ───────────────────────────


def test_sweep_budget_still_consumes_and_exhausts() -> None:
    sb.begin_sweep_llm_budget(2)
    assert sb.try_consume_llm_call() is True
    assert sb.try_consume_llm_call() is True
    assert sb.try_consume_llm_call() is False


def test_llm_calls_remaining_tracks_consumption() -> None:
    sb.begin_sweep_llm_budget(3)
    sb.try_consume_llm_call()
    assert sb.llm_calls_remaining() == 2


def test_unbudgeted_context_stays_permissive_by_default() -> None:
    """Callers legitimately outside any budgeted scope are unaffected."""
    assert sb.llm_calls_remaining() is None
    assert sb.try_consume_llm_call() is True


# ── the new fail-closed behaviour ───────────────────────────────────


def test_fails_closed_when_a_required_budget_is_missing() -> None:
    with sb.llm_budget_scope(4):
        # Simulate the budget going missing inside a scope that requires one.
        sb._llm_calls_remaining.set(None)
        assert sb.llm_budget_required() is True
        assert sb.try_consume_llm_call() is False


# ── llm_budget_scope ────────────────────────────────────────────────


def test_scope_arms_a_budget_and_exhausts_it() -> None:
    with sb.llm_budget_scope(2):
        assert sb.llm_calls_remaining() == 2
        assert sb.try_consume_llm_call() is True
        assert sb.try_consume_llm_call() is True
        assert sb.try_consume_llm_call() is False


def test_scope_restores_the_previous_state_on_exit() -> None:
    assert sb.llm_calls_remaining() is None
    with sb.llm_budget_scope(4):
        sb.try_consume_llm_call()
    assert sb.llm_calls_remaining() is None
    assert sb.llm_budget_required() is False


def test_scope_never_widens_an_outer_sweep_budget() -> None:
    """An inner per-run scope must not hand the sweep extra calls."""
    sb.begin_sweep_llm_budget(1)
    with sb.llm_budget_scope(50):
        assert sb.llm_calls_remaining() == 1
        assert sb.try_consume_llm_call() is True
        assert sb.try_consume_llm_call() is False
    # The sweep's (now exhausted) budget survives the inner scope.
    assert sb.llm_calls_remaining() == 0


def test_scope_restores_an_outer_budget_exactly() -> None:
    sb.begin_sweep_llm_budget(5)
    with sb.llm_budget_scope(2):
        sb.try_consume_llm_call()
    assert sb.llm_calls_remaining() == 4


# ── the closed-loop entry path arms it ──────────────────────────────


async def test_propose_patch_for_action_arms_a_budget() -> None:
    from eden.improvement import issue_patch_trigger as ipt

    seen: list[int | None] = []

    async def _capture(org_id, issue_id):
        seen.append(sb.llm_calls_remaining())
        return {"status": "ok"}

    with patch.object(ipt, "propose_plan_for_issue", new=_capture):
        await ipt.propose_patch_for_action("org", {"target": "issue-1"})

    assert seen and seen[0] is not None, "closed-loop path spent with no LLM budget"
    assert seen[0] > 0
    # And it does not leak out of the call.
    assert sb.llm_calls_remaining() is None


async def test_propose_patch_for_issue_arms_a_budget() -> None:
    from eden.improvement import issue_patch_trigger as ipt

    seen: list[int | None] = []

    async def _capture(org_id, issue_id):
        seen.append(sb.llm_calls_remaining())
        return {}

    with patch.object(ipt, "propose_plan_for_issue", new=_capture):
        await ipt.propose_patch_for_issue("org", "issue-1")

    assert seen and seen[0] is not None


async def test_closed_loop_budget_defaults_to_the_setting() -> None:
    from eden.config import get_settings
    from eden.improvement import issue_patch_trigger as ipt

    expected = get_settings().patch_max_llm_calls_per_run
    assert expected > 0
    seen: list[int | None] = []

    async def _capture(org_id, issue_id):
        seen.append(sb.llm_calls_remaining())
        return {}

    with patch.object(ipt, "propose_plan_for_issue", new=_capture):
        await ipt.propose_patch_for_action("org", {"target": "i1"})

    assert seen[0] == expected


async def test_a_sweep_budget_is_not_replaced_by_the_closed_loop_scope() -> None:
    from eden.improvement import issue_patch_trigger as ipt

    seen: list[int | None] = []

    async def _capture(org_id, issue_id):
        seen.append(sb.llm_calls_remaining())
        return {}

    sb.begin_sweep_llm_budget(7)
    with patch.object(ipt, "propose_plan_for_issue", new=_capture):
        await ipt.propose_patch_for_action("org", {"target": "i1"})
    assert seen[0] == 7


# ── the consumer honours it ─────────────────────────────────────────


async def test_patch_generator_critic_skips_when_budget_exhausted() -> None:
    # M4 (D13): the critic is fail-closed on EVERY path — the
    # ``fail_closed`` kwarg is gone, exhaustion always means passed=False.
    from eden.patches.patch_generator import _critic_review

    with sb.llm_budget_scope(0):
        verdict = await _critic_review(AsyncMock(), "diff", rca_summary="s")
    assert verdict["reason"] == "llm_budget_exhausted"
    assert verdict["passed"] is False
