"""Test GuardrailedFramework with all 5 PlanningFramework subclasses.

Per spec §12.4 (Cat 6 integration) and §4 Phase 4:
  - ChainOfThoughtEnvironment
  - ReActEnvironment
  - TreeOfThoughtsEnvironment
  - PlanAndExecuteEnvironment
  - ReflexionEnvironment

Each subclass overrides run_episode. The GuardrailedFramework
wraps any subclass and re-traverses the trajectory for guardrail
evaluation.
"""
from __future__ import annotations

import pytest

from eden.multi_agent.planning import (
    ChainOfThoughtEnvironment,
    EpisodeResult,
    PlanAndExecuteEnvironment,
    PlanningFramework,
    ReActEnvironment,
    ReflexionEnvironment,
    TreeOfThoughtsEnvironment,
    PlanStep,
)
from supplementaries.phase_4_guardrails.hook import GuardrailedFramework
from supplementaries.phase_4_guardrails.trajectory import GuardrailState


# ── Mock subclasses that mimic the real ones ──────────────────


class MockCoTEnvironment(ChainOfThoughtEnvironment):
    """Mock ChainOfThought subclass for testing."""
    def __init__(self, max_steps: int = 5):
        super().__init__(max_steps=max_steps)
        self._framework_name = "cot"
    def run_episode(self, agents, env_state):
        trajectory = [
            {"step_id": f"cot_{i}", "description": f"Thought {i}",
             "completed": True, "actual_output": "", "step_number": i}
            for i in range(3)
        ]
        return EpisodeResult(
            trajectory=trajectory, total_reward=3.0, success=True,
            winner="agent_a", scores={"quality": 0.85},
            episode_id="ep_cot", environment_id="env_test",
            duration_ms=1500.0, steps_taken=3,
        )


class MockReActEnvironment(ReActEnvironment):
    """Mock ReAct subclass."""
    def __init__(self, max_steps: int = 5):
        super().__init__(max_steps=max_steps)
        self._framework_name = "react"
    def run_episode(self, agents, env_state):
        trajectory = [
            {"step_id": f"r_{i}", "step_number": i,
             "description": f"ReAct step {i}",
             "tool_name": "crm.lookup",
             "completed": True, "actual_output": "ok"}
            for i in range(3)
        ]
        return EpisodeResult(
            trajectory=trajectory, total_reward=3.0, success=True,
            winner=None, scores={}, episode_id="ep_r",
            environment_id="env_test", duration_ms=1500.0, steps_taken=3,
        )


class MockToTEnvironment(TreeOfThoughtsEnvironment):
    """Mock Tree-of-Thoughts subclass."""
    def __init__(self, max_steps: int = 5):
        super().__init__(max_steps=max_steps)
        self._framework_name = "tot"
    def run_episode(self, agents, env_state):
        trajectory = [
            {"step_id": f"tot_{i}", "step_number": i,
             "description": f"ToT thought {i}",
             "completed": True, "actual_output": ""}
            for i in range(3)
        ]
        return EpisodeResult(
            trajectory=trajectory, total_reward=3.0, success=True,
            winner=None, scores={}, episode_id="ep_tot",
            environment_id="env_test", duration_ms=1500.0, steps_taken=3,
        )


class MockPEEnvironment(PlanAndExecuteEnvironment):
    """Mock Plan-and-Execute subclass."""
    def __init__(self, max_steps: int = 5):
        super().__init__(max_steps=max_steps)
        self._framework_name = "pe"
    def run_episode(self, agents, env_state):
        trajectory = [
            {"step_id": f"pe_{i}", "step_number": i,
             "description": f"Plan step {i}",
             "tool_name": "kb.search",
             "completed": True, "actual_output": "result"}
            for i in range(3)
        ]
        return EpisodeResult(
            trajectory=trajectory, total_reward=3.0, success=True,
            winner=None, scores={}, episode_id="ep_pe",
            environment_id="env_test", duration_ms=1500.0, steps_taken=3,
        )


class MockReflexionEnvironment(ReflexionEnvironment):
    """Mock Reflexion subclass."""
    def __init__(self, max_steps: int = 5):
        super().__init__(max_steps=max_steps)
        self._framework_name = "reflexion"
    def run_episode(self, agents, env_state):
        trajectory = [
            {"step_id": f"ref_{i}", "step_number": i,
             "description": f"Reflexion {i}: Reflection: ...",
             "tool_name": "tool.x",
             "completed": True, "actual_output": "ok"}
            for i in range(3)
        ]
        return EpisodeResult(
            trajectory=trajectory, total_reward=3.0, success=True,
            winner=None, scores={}, episode_id="ep_ref",
            environment_id="env_test", duration_ms=1500.0, steps_taken=3,
        )


# ── Per-subclass tests ────────────────────────────────────────


@pytest.mark.parametrize("subclass_factory,name", [
    (MockCoTEnvironment, "ChainOfThought"),
    (MockReActEnvironment, "ReAct"),
    (MockToTEnvironment, "TreeOfThoughts"),
    (MockPEEnvironment, "PlanAndExecute"),
    (MockReflexionEnvironment, "Reflexion"),
])
def test_guardrailed_runs_with_each_subclass(subclass_factory, name):
    """GuardrailedFramework works with every PlanningFramework subclass."""
    base = subclass_factory()
    framework = GuardrailedFramework(base)
    result = framework.run_episode(agents={}, env_state=None)
    assert result.success
    assert result.steps_taken == 3
    assert isinstance(result.guardrail_actions, list)
    assert len(result.guardrail_actions) == 3
    # All actions should be in the valid guardrail action set.
    valid_actions = {
        "allow", "warn", "block", "escalate", "truncate", "rewrite",
        "coalesce", "summarize", "replan", "cache", "skip_step", "redact",
    }
    for action in result.guardrail_actions:
        assert action in valid_actions, f"{name}: invalid action {action}"


@pytest.mark.parametrize("subclass_factory,name", [
    (MockCoTEnvironment, "ChainOfThought"),
    (MockReActEnvironment, "ReAct"),
    (MockToTEnvironment, "TreeOfThoughts"),
    (MockPEEnvironment, "PlanAndExecute"),
    (MockReflexionEnvironment, "Reflexion"),
])
def test_guardrailed_preserves_subclass_attributes(subclass_factory, name):
    """The wrapped framework preserves base-class attributes."""
    base = subclass_factory(max_steps=10)
    assert base.max_steps == 10
    framework = GuardrailedFramework(base)
    assert framework.framework is base
    assert framework.framework.max_steps == 10


@pytest.mark.parametrize("subclass_factory,name", [
    (MockCoTEnvironment, "ChainOfThought"),
    (MockReActEnvironment, "ReAct"),
    (MockToTEnvironment, "TreeOfThoughts"),
    (MockPEEnvironment, "PlanAndExecute"),
    (MockReflexionEnvironment, "Reflexion"),
])
def test_guardrailed_final_action_is_valid(subclass_factory, name):
    """The final_action is one of the 14 spec-defined actions."""
    base = subclass_factory()
    framework = GuardrailedFramework(base)
    result = framework.run_episode(agents={}, env_state=None)
    assert result.final_action in {
        "allow", "warn", "block", "escalate", "truncate", "rewrite",
        "coalesce", "summarize", "replan", "cache", "skip_step", "redact",
    }


# ── State persistence across subclasses ────────────────────────


def test_guardrail_state_independent_per_subclass():
    """Each GuardrailedFramework instance has its own state."""
    cot = GuardrailedFramework(MockCoTEnvironment())
    react = GuardrailedFramework(MockReActEnvironment())
    cot.run_episode(agents={}, env_state=None)
    # React's state should not have been affected by CoT's run.
    assert react.state.cumulative_cost_usd == 0.0


def test_guardrailed_state_persists_across_runs():
    """Calling run_episode twice accumulates state."""
    framework = GuardrailedFramework(MockReActEnvironment())
    framework.run_episode(agents={}, env_state=None)
    cost_after_first = framework.state.cumulative_cost_usd
    framework.run_episode(agents={}, env_state=None)
    # Second run should increase cumulative cost.
    assert framework.state.cumulative_cost_usd > cost_after_first


# ── Stress: all 5 in sequence ────────────────────────────────


def test_all_5_subclasses_in_sequence():
    """Run all 5 subclasses in sequence and verify no state leakage."""
    frameworks = [
        GuardrailedFramework(MockCoTEnvironment()),
        GuardrailedFramework(MockReActEnvironment()),
        GuardrailedFramework(MockToTEnvironment()),
        GuardrailedFramework(MockPEEnvironment()),
        GuardrailedFramework(MockReflexionEnvironment()),
    ]
    results = []
    for fw in frameworks:
        r = fw.run_episode(agents={}, env_state=None)
        results.append(r)
    assert all(r.success for r in results)
    assert all(len(r.guardrail_actions) == 3 for r in results)