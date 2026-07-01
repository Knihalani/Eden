"""Tests for PlanningFramework hook integration."""
from __future__ import annotations

import pytest

from eden.multi_agent.planning import (
    PlanStep,
    EpisodeResult,
    PlanningFramework,
)
from supplementaries.phase_4_guardrails.hook import (
    GuardrailedEpisodeResult,
    GuardrailedFramework,
    _dict_to_plan_step,
    _plan_step_to_event,
    step_post_hook,
    step_pre_hook,
)
from supplementaries.phase_4_guardrails.trajectory import GuardrailState


# ── Mock PlanningFramework for tests ───────────────────────────


class MockReActEnvironment(PlanningFramework):
    """Minimal ReAct-style framework for testing."""

    def __init__(self, max_steps: int = 5):
        super().__init__(max_steps=max_steps)
        self._framework_name = "react"

    def run_episode(self, agents, env_state):
        trajectory = [
            {
                "step_id": f"s{i}",
                "step_number": i,
                "description": f"Step {i} description",
                "tool_name": "crm.lookup",
                "completed": True,
                "actual_output": "OK",
            }
            for i in range(3)
        ]
        return EpisodeResult(
            trajectory=trajectory,
            total_reward=3.0,
            success=True,
            winner="agent_a",
            scores={"quality": 0.85},
            episode_id="ep_mock",
            environment_id="env_test",
            duration_ms=1500.0,
            steps_taken=3,
        )


class MockAbortingEnvironment(PlanningFramework):
    """Framework that raises an exception during run_episode."""

    def __init__(self):
        super().__init__(max_steps=5)
        self._framework_name = "aborting"

    def run_episode(self, agents, env_state):
        raise RuntimeError("agent crashed")


# ── _plan_step_to_event ────────────────────────────────────────


def test_plan_step_to_event_tool_call():
    step = PlanStep(
        step_id="s1",
        description="Look up order",
        tool_name="crm.lookup",
        expected_output="order_id",
        completed=True,
        actual_output="4471",
        step_number=1,
    )
    event = _plan_step_to_event(step)
    assert event.event_type == "tool.call"
    assert event.name == "crm.lookup"
    assert event.outcome == "success"


def test_plan_step_to_event_llm_completion():
    step = PlanStep(
        step_id="s2",
        description="Summarise the result",
        tool_name=None,
        expected_output="summary",
        completed=True,
        actual_output="",
        step_number=2,
    )
    event = _plan_step_to_event(step)
    assert event.event_type == "llm.completion"
    assert event.finish_reason == "stop"


def test_plan_step_to_event_failure():
    step = PlanStep(
        step_id="s3",
        description="Failing tool",
        tool_name="bank.transfer",
        expected_output="ok",
        completed=False,
        actual_output="",
        step_number=3,
    )
    event = _plan_step_to_event(step)
    assert event.outcome == "failure"


# ── _dict_to_plan_step ─────────────────────────────────────────


def test_dict_to_plan_step_valid():
    d = {
        "step_id": "s1",
        "step_number": 1,
        "description": "do thing",
        "tool_name": "crm.x",
        "completed": True,
        "actual_output": "ok",
    }
    step = _dict_to_plan_step(d)
    assert step is not None
    assert step.tool_name == "crm.x"
    assert step.step_number == 1


def test_dict_to_plan_step_empty_dict():
    assert _dict_to_plan_step({}) is not None  # returns PlanStep with defaults


def test_dict_to_plan_step_invalid():
    assert _dict_to_plan_step(None) is None
    assert _dict_to_plan_step("not a dict") is None


# ── step_pre_hook / step_post_hook ──────────────────────────────


def test_step_pre_hook_clean_step():
    state = GuardrailState()
    step = PlanStep(
        step_id="s1",
        description="normal step",
        tool_name="crm.lookup",
        completed=True,
        actual_output="ok",
        step_number=1,
    )
    verdict = step_pre_hook(state, step, [])
    assert verdict.step_action in {"allow", "warn"}


def test_step_post_hook_records_actions():
    state = GuardrailState()
    step = PlanStep(
        step_id="s1",
        description="expensive step",
        tool_name="crm.lookup",
        completed=True,
        actual_output="ok",
        step_number=1,
    )
    verdict = step_post_hook(state, step, "ok", [])
    assert verdict.step_action is not None


# ── GuardrailedFramework ───────────────────────────────────────


def test_guardrailed_framework_runs_cleanly():
    base = MockReActEnvironment(max_steps=10)
    framework = GuardrailedFramework(base)
    result = framework.run_episode(agents={}, env_state=None)
    assert isinstance(result, GuardrailedEpisodeResult)
    assert not result.aborted
    assert result.steps_taken == 3
    # Most actions should be allow on clean traces
    assert "allow" in result.guardrail_actions or "warn" in result.guardrail_actions


def test_guardrailed_framework_aborts_on_exception():
    framework = GuardrailedFramework(MockAbortingEnvironment())
    result = framework.run_episode(agents={}, env_state=None)
    assert result.aborted
    assert result.final_action == "block"
    assert any("error" in a for a in result.guardrail_actions)


def test_guardrailed_framework_preserves_base_results():
    base = MockReActEnvironment()
    framework = GuardrailedFramework(base)
    result = framework.run_episode(agents={}, env_state=None)
    assert result.success
    assert result.total_reward == 3.0
    assert result.episode_id == "ep_mock"
    assert result.winner == "agent_a"


def test_guardrailed_framework_no_double_counting():
    """The framework should evaluate each step exactly once."""
    base = MockReActEnvironment()
    framework = GuardrailedFramework(base)
    result = framework.run_episode(agents={}, env_state=None)
    # 3 steps in trajectory → 3 guardrail actions
    assert len(result.guardrail_actions) == 3


# ── Spec integration ──────────────────────────────────────────


def test_guardrailed_framework_subclass_agnostic():
    """The wrapper works with any PlanningFramework subclass."""
    for sub in [MockReActEnvironment(), MockAbortingEnvironment()]:
        framework = GuardrailedFramework(sub)
        result = framework.run_episode(agents={}, env_state=None)
        assert result is not None


def test_guardrailed_framework_state_persists():
    """GuardrailState persists across steps (cumulative cost etc.)."""
    base = MockReActEnvironment()
    framework = GuardrailedFramework(base)
    initial_cost = framework.state.cumulative_cost_usd
    framework.run_episode(agents={}, env_state=None)
    final_cost = framework.state.cumulative_cost_usd
    # Cost should have grown (each step has cost_usd in metrics)
    assert final_cost > initial_cost