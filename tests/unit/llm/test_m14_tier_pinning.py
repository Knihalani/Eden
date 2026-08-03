"""M14 (§8.2) — routing assertion tests: critic + triage stay on T1/SLM.

Pinning is via ``slot="fast"`` (correction #8 / §8.2). A TaskClassifier
heuristic change must not silently upgrade these agents to T2/T3.
"""

from __future__ import annotations

import inspect

import pytest

from eden.llm.internal_router import build_task
from eden.optimization.model_router import ModelTier, PipelineTask, TaskClassifier
from eden.patches.patch_generator import _critic_review


def test_critic_slot_fast_pins_t1() -> None:
    task = PipelineTask(
        agent="patch_critic",
        description="Critic review of generated patch",
        slot="fast",
        output_type="json",
        expected_min_length=4,
    )
    assert TaskClassifier()._heuristic_classify(task) is ModelTier.T1
    assert "patch_critic" in TaskClassifier.PINNED_FAST_AGENTS


def test_triage_investigation_slot_fast_pins_t1() -> None:
    task = build_task(
        "autonomous_investigation",
        slot="fast",
        description="Investigate issue root cause",
        output_type="json",
    )
    assert task.slot == "fast"
    assert TaskClassifier()._heuristic_classify(task) is ModelTier.T1
    assert "autonomous_investigation" in TaskClassifier.PINNED_FAST_AGENTS


def test_slot_reasoning_without_pin_is_not_guaranteed_t1() -> None:
    """Lock that the pin matters: without slot=fast, triage is not T1-forced."""
    # Use output_type=text + requires_novelty so the only T1 short-circuit
    # would have been slot=fast (which we deliberately omit).
    task = PipelineTask(
        agent="autonomous_investigation",
        description="Investigate a complex multi-hop root cause across services",
        slot="reasoning",
        output_type="text",
        requires_novelty=True,
        expected_min_length=200,
    )
    # Ambiguous / non-fast → heuristic may return None (LLM classify) or
    # a higher tier — must NOT be the deterministic T1 short-circuit.
    assert TaskClassifier()._heuristic_classify(task) is not ModelTier.T1


def test_triage_agent_source_passes_slot_fast() -> None:
    """``TriageAgent`` must explicitly pass ``slot=\"fast\"`` to investigate."""
    from eden.issues import triage_agent as mod

    src = inspect.getsource(mod.TriageAgent.triage)
    assert 'slot="fast"' in src or "slot='fast'" in src


@pytest.mark.asyncio
async def test_critic_review_builds_fast_slot_task(monkeypatch: pytest.MonkeyPatch) -> None:
    from types import SimpleNamespace
    from unittest.mock import AsyncMock, MagicMock

    monkeypatch.setattr(
        "eden.improvement.sweep_budget.try_consume_llm_call",
        lambda: True,
    )
    router = MagicMock()
    router.aroute = AsyncMock(
        return_value=SimpleNamespace(
            content='{"verdict":"PASS","root_cause_addressed":true,'
            '"blast_radius":"low","untested_paths":[],'
            '"risk_note":"ok","injection_suspected":false}',
            usage=SimpleNamespace(cost=0.0),
        )
    )
    await _critic_review(router, "--- a/x\n+++ b/x\n", rca_summary="rca")
    task = router.aroute.await_args.args[0]
    assert task.slot == "fast"
    assert task.agent == "patch_critic"
    assert TaskClassifier()._heuristic_classify(task) is ModelTier.T1
