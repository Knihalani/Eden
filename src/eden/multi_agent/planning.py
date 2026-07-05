"""Planning & reflection frameworks for multi-agent environments.

Supports:
  • ReAct (Reasoning + Acting)
  • Tree-of-Thoughts (ToT)
  • Plan-and-Execute
  • Reflexion (self-critique)

Ref: eden-multi-agent-orchestration-architecture.md §7
"""

from __future__ import annotations

import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any

# ──────────────────────────────────────────────────────────────────────────
# Core data structures
# ──────────────────────────────────────────────────────────────────────────

@dataclass
class PlanStep:
    """A single step in a plan."""

    step_id: str
    description: str
    tool_name: str | None = None
    expected_output: str = ""
    completed: bool = False
    actual_output: str = ""
    step_number: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "step_id": self.step_id,
            "description": self.description,
            "tool_name": self.tool_name,
            "expected_output": self.expected_output,
            "completed": self.completed,
            "actual_output": self.actual_output,
            "step_number": self.step_number,
        }


@dataclass
class EpisodeResult:
    """Result of running an episode."""

    trajectory: list[dict[str, Any]] = field(default_factory=list)
    total_reward: float = 0.0
    success: bool = False
    winner: str | None = None
    scores: dict[str, float] = field(default_factory=dict)
    episode_id: str = ""
    environment_id: str = ""
    duration_ms: float = 0.0
    steps_taken: int = 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "trajectory_length": len(self.trajectory),
            "total_reward": self.total_reward,
            "success": self.success,
            "winner": self.winner,
            "scores": self.scores,
            "episode_id": self.episode_id,
            "environment_id": self.environment_id,
            "duration_ms": self.duration_ms,
            "steps_taken": self.steps_taken,
        }


@dataclass
class ThoughtNode:
    """A node in the Tree-of-Thoughts search tree."""

    content: str
    depth: int = 0
    value: float = 0.0
    parent: ThoughtNode | None = None
    children: list[ThoughtNode] = field(default_factory=list)
    visits: int = 0

    def best_child(self) -> ThoughtNode | None:
        if not self.children:
            return None
        return max(self.children, key=lambda c: c.value)

    def best_path(self) -> list[ThoughtNode]:
        path = [self]
        current = self
        while current.children:
            current = current.best_child()
            if current:
                path.append(current)
        return path

    def to_dict(self) -> dict[str, Any]:
        return {
            "content": self.content[:200],
            "depth": self.depth,
            "value": self.value,
            "visits": self.visits,
            "child_count": len(self.children),
        }


@dataclass
class Critique:
    """A critique produced by a critic agent."""

    score: float = 0.0  # 0–1
    issues: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)
    reflection: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "score": self.score,
            "issues": self.issues,
            "suggestions": self.suggestions,
            "reflection": self.reflection,
        }


# ──────────────────────────────────────────────────────────────────────────
# Planning Framework (base)
# ──────────────────────────────────────────────────────────────────────────

class PlanningFramework(ABC):
    """Base class for all planning frameworks.

    Subclasses (ReAct, ChainOfThought, TreeOfThoughts, PlanAndExecute,
    Reflexion) override :meth:`run_episode` and optionally
    :meth:`to_dict`. Direct instantiation raises ``TypeError`` because
    of the ``@abstractmethod`` decorator — this is the standard ABC
    pattern and replaces the previous ``raise NotImplementedError`` so
    that misuse is caught at construction time, not at first call.
    """

    def __init__(self, max_steps: int = 50):
        self.max_steps = max_steps
        self._framework_name = "base"

    @abstractmethod
    def run_episode(self, agents: dict[str, Any], env_state: Any) -> EpisodeResult:
        ...

    def to_dict(self) -> dict[str, Any]:
        return {"framework": self._framework_name, "max_steps": self.max_steps}


# ─────────────────────────────────────────────────────────────────────────────
# Phase 6.8.4: Chain-of-Thought (CoT)
# ─────────────────────────────────────────────────────────────────────────────
# Pure CoT (vs the ReAct variant that combines reasoning+acting).
# Each turn produces a single thought, then optionally an action
# (if a tool_call is part of the thought). The thought chain is
# accumulated and exposed for inspection.

class ChainOfThoughtEnvironment(PlanningFramework):
    """Pure chain-of-thought: each turn is a single thought.

    Differs from :class:`ReActEnvironment` in that there's no
    explicit Thought / Action / Observation split — the LLM emits a
    single string per turn, and the environment executes an
    optional tool call if the thought contains one. The full thought
    chain is recorded and exposed via :attr:`thought_chain`.

    Useful for tasks that benefit from explicit scratchpad reasoning
    (math, logic, multi-step planning) without interleaved
    observation. The completion is the thought chain itself when no
    action was taken.
    """

    def __init__(self, max_steps: int = 20):
        super().__init__(max_steps)
        self._framework_name = "chain_of_thought"
        self.thought_chain: list[str] = []
        self.last_thought: str = ""
        self.completion_action: dict[str, Any] | None = None

    def _format_thought(self, raw: str) -> str:
        """Strip optional ``Action:`` trailer and surface a clean thought.

        LLM outputs often include ``Thought: ... Action: ...``. We
        persist only the thought, but if an ``Action:`` line is
        present we capture it for execution.
        """
        thought = raw
        action: dict[str, Any] | None = None
        if "Action:" in raw:
            thought, _, action_str = raw.partition("Action:")
            action_str = action_str.strip()
            try:
                import json as _json
                action = _json.loads(action_str)
            except Exception:
                # Not parseable as JSON — treat as a no-op action with the
                # raw text for downstream tools to handle.
                action = {"type": "raw", "value": action_str}
        self.thought_chain.append(thought.strip())
        self.last_thought = thought.strip()
        self.completion_action = action
        return thought.strip()

    def _step_through_agents(
        self,
        agents: dict[str, Any],
        env_state: Any,
    ) -> tuple[Any, float, bool, dict[str, Any]]:
        """Drive one CoT step. Returns the new state, reward, done flag, info."""
        # The single agent (or designated "main" agent) generates a thought
        agent_id = next(iter(agents.keys()))
        agent = agents[agent_id]

        observation = self._observe(env_state, agent_id)
        raw_thought = self._agent_think(agent, observation)
        thought = self._format_thought(raw_thought)

        if self.completion_action is not None:
            next_state, reward, done, info = self._step(env_state, self.completion_action, agent_id)
        else:
            # Pure thought — no state transition. Award a small intrinsic
            # reward for producing a non-empty thought so the episode
            # doesn't stall.
            next_state, reward, done, info = env_state, 0.0, False, {"thought": thought}

        return next_state, reward, done, info

    def run_episode(self, agents: dict[str, Any], env_state: Any) -> EpisodeResult:
        self.thought_chain = []
        self.last_thought = ""
        self.completion_action = None
        trajectory: list[dict[str, Any]] = []
        total_reward = 0.0
        done = False

        for step in range(self.max_steps):
            next_state, reward, done, info = self._step_through_agents(agents, env_state)
            total_reward += reward
            trajectory.append({
                "step": step,
                "thought": self.last_thought,
                "reward": reward,
                "info": info,
            })
            env_state = next_state
            if done:
                break

        return EpisodeResult(
            steps=trajectory,
            total_reward=total_reward,
            success=self._evaluate_success(trajectory),
            metadata={
                "framework": "chain_of_thought",
                "thought_chain": list(self.thought_chain),
                "max_steps": self.max_steps,
            },
        )

    def _agent_think(self, agent: Any, observation: dict[str, Any]) -> str:
        """Ask the agent for a single thought. Falls back to a stub."""
        if hasattr(agent, "think"):
            return agent.think(observation, self.thought_chain)
        # Stub: produce a no-op thought so the loop terminates gracefully
        return f"Thought #{len(self.thought_chain) + 1}: (no-op)"

    def to_dict(self) -> dict[str, Any]:
        return {
            "framework": "chain_of_thought",
            "max_steps": self.max_steps,
            "thought_chain": list(self.thought_chain),
        }


# ──────────────────────────────────────────────────────────────────────────
# ReAct Environment
# ──────────────────────────────────────────────────────────────────────────

class ReActEnvironment(PlanningFramework):
    """Reasoning + Acting loop with tool use."""

    def __init__(self, max_steps: int = 50):
        super().__init__(max_steps)
        self._framework_name = "react"

    def run_episode(self, agents: dict[str, Any], env_state: Any) -> EpisodeResult:
        start = time.time()
        trajectory = []
        total_reward = 0.0

        for step in range(self.max_steps):
            for agent_id, agent in agents.items():
                # Agent observes
                observation = self._get_observation(env_state, agent_id)
                # Agent thinks and acts
                thought, action = self._react_step(agent, observation, trajectory)
                # Environment processes
                next_state, reward, done, info = self._step(env_state, action, agent_id)
                trajectory.append({
                    "step": step,
                    "agent_id": agent_id,
                    "thought": thought,
                    "action": action,
                    "observation": observation,
                    "reward": reward,
                })
                total_reward += reward
                env_state = next_state

                if done:
                    break
            if done:
                break

        return EpisodeResult(
            trajectory=trajectory,
            total_reward=total_reward,
            success=self._evaluate_success(trajectory),
            duration_ms=(time.time() - start) * 1000,
            steps_taken=len(trajectory),
        )

    def _get_observation(self, env_state: Any, agent_id: str) -> dict[str, Any]:
        # Stub: return env state as-is
        if hasattr(env_state, "to_observable"):
            return env_state.to_observable(agent_id)
        return {"state": str(env_state)}

    def _react_step(self, agent: Any, observation: dict[str, Any], trajectory: list[dict[str, Any]]) -> tuple[str, dict[str, Any]]:
        if hasattr(agent, "react_step"):
            return agent.react_step(observation, trajectory)
        # Stub: agent just echoes observation
        return f"Observed: {observation}", {"type": "noop"}

    def _step(self, state: Any, action: dict[str, Any], agent_id: str) -> tuple[Any, float, bool, dict[str, Any]]:
        if hasattr(state, "apply_action"):
            return state.apply_action(agent_id, action)
        return state, 0.0, False, {}

    def _evaluate_success(self, trajectory: list[dict[str, Any]]) -> bool:
        # Stub: success if any positive reward
        return any(s.get("reward", 0) > 0 for s in trajectory)


# ──────────────────────────────────────────────────────────────────────────
# Tree-of-Thoughts Environment
# ──────────────────────────────────────────────────────────────────────────

class TreeOfThoughtsEnvironment(PlanningFramework):
    """Explore multiple reasoning paths via tree search."""

    def __init__(self, branching_factor: int = 3, max_depth: int = 5, max_steps: int = 50):
        super().__init__(max_steps)
        self.branching_factor = branching_factor
        self.max_depth = max_depth
        self._framework_name = "tree_of_thoughts"

    def run_search(self, agent: Any, problem: str) -> ThoughtNode:
        root = ThoughtNode(content=problem, depth=0)
        frontier = [root]
        all_nodes = [root]

        while frontier:
            node = frontier.pop(0)
            if node.depth >= self.max_depth:
                continue

            # Agent generates candidate thoughts
            candidates = self._generate_thoughts(agent, node, k=self.branching_factor)

            for candidate in candidates:
                child = ThoughtNode(
                    content=candidate,
                    depth=node.depth + 1,
                    parent=node,
                )
                node.children.append(child)
                all_nodes.append(child)

                # Evaluate thought quality
                child.value = self._evaluate_thought(child)
                child.visits += 1

                if not self._is_terminal(child):
                    frontier.append(child)

        return self._select_best_path(root)

    def _generate_thoughts(self, agent: Any, node: ThoughtNode, k: int) -> list[str]:
        if hasattr(agent, "generate_thoughts"):
            return agent.generate_thoughts(node, k=k)
        # Stub: return k generic thoughts
        return [f"Thought {i+1} at depth {node.depth}" for i in range(k)]

    def _evaluate_thought(self, node: ThoughtNode) -> float:
        # Stub: higher depth = slightly better (exploration reward)
        base = 0.5
        depth_bonus = node.depth * 0.05
        # Content heuristic: longer thoughts get small bonus
        length_bonus = min(len(node.content) / 500.0, 0.2)
        return min(base + depth_bonus + length_bonus, 1.0)

    def _is_terminal(self, node: ThoughtNode) -> bool:
        # Stub: terminal if content contains "answer" or "conclusion"
        return "answer" in node.content.lower() or "conclusion" in node.content.lower()

    def _select_best_path(self, root: ThoughtNode) -> ThoughtNode:
        path = root.best_path()
        return path[-1] if path else root

    def run_episode(self, agents: dict[str, Any], env_state: Any) -> EpisodeResult:
        start = time.time()
        # In ToT, one agent does the thinking
        agent = next(iter(agents.values()))
        problem = getattr(env_state, "problem", "Solve the task")
        best_node = self.run_search(agent, problem)
        return EpisodeResult(
            trajectory=[{"best_path": [n.to_dict() for n in best_node.best_path()]}],
            total_reward=best_node.value,
            success=best_node.value > 0.7,
            duration_ms=(time.time() - start) * 1000,
            steps_taken=len(best_node.best_path()),
        )


# ──────────────────────────────────────────────────────────────────────────
# Plan-and-Execute Environment
# ──────────────────────────────────────────────────────────────────────────

class PlanAndExecuteEnvironment(PlanningFramework):
    """Generate full plan, then execute sequentially."""

    def __init__(self, max_steps: int = 50):
        super().__init__(max_steps)
        self._framework_name = "plan_and_execute"

    def run_episode(self, agents: dict[str, Any], env_state: Any) -> EpisodeResult:
        start = time.time()
        # Step 1: Planner generates full plan
        planner = next(iter(agents.values()))
        plan = self._generate_plan(planner, env_state)

        # Step 2: Execute plan step-by-step
        trajectory = []
        total_reward = 0.0
        for step in plan:
            agent_id = step.get("agent_id", next(iter(agents)))
            executor = agents.get(agent_id)
            if not executor:
                continue
            observation = self._get_observation(env_state, agent_id)
            action = self._execute_step(executor, step, observation)
            next_state, reward, done, info = self._step(env_state, action, agent_id)
            trajectory.append({
                "step": step,
                "action": action,
                "reward": reward,
            })
            total_reward += reward
            env_state = next_state
            if done:
                break

        return EpisodeResult(
            trajectory=trajectory,
            total_reward=total_reward,
            success=self._evaluate_success(trajectory),
            duration_ms=(time.time() - start) * 1000,
            steps_taken=len(trajectory),
        )

    def _generate_plan(self, planner: Any, env_state: Any) -> list[dict[str, Any]]:
        if hasattr(planner, "generate_plan"):
            return planner.generate_plan(env_state)
        # Stub: 5-step generic plan
        return [
            {"step_id": f"s{i}", "description": f"Step {i+1}", "agent_id": "agent_1"}
            for i in range(5)
        ]

    def _execute_step(self, executor: Any, step: dict[str, Any], observation: dict[str, Any]) -> dict[str, Any]:
        if hasattr(executor, "execute_step"):
            return executor.execute_step(step, observation)
        return {"type": "execute", "step": step}

    def _get_observation(self, env_state: Any, agent_id: str) -> dict[str, Any]:
        if hasattr(env_state, "to_observable"):
            return env_state.to_observable(agent_id)
        return {"state": str(env_state)}

    def _step(self, state: Any, action: dict[str, Any], agent_id: str) -> tuple[Any, float, bool, dict[str, Any]]:
        if hasattr(state, "apply_action"):
            return state.apply_action(agent_id, action)
        return state, 0.0, False, {}

    def _evaluate_success(self, trajectory: list[dict[str, Any]]) -> bool:
        return any(s.get("reward", 0) > 0 for s in trajectory)


# ──────────────────────────────────────────────────────────────────────────
# Reflexion Environment
# ──────────────────────────────────────────────────────────────────────────

class ReflexionEnvironment(PlanningFramework):
    """Agent critiques and improves its own behavior over iterations."""

    def __init__(self, max_iterations: int = 3, max_steps: int = 50):
        super().__init__(max_steps)
        self.max_iterations = max_iterations
        self._framework_name = "reflexion"

    def run_episode(self, agents: dict[str, Any], env_state: Any) -> EpisodeResult:
        start = time.time()
        agent = next(iter(agents.values()))
        critic = agents.get("critic", agent)  # May be same agent or separate
        best_result: EpisodeResult | None = None
        all_trajectories = []

        for _iteration in range(self.max_iterations):
            # Run episode
            result = self._run_single_episode(agent, env_state)
            all_trajectories.append(result.trajectory)

            # Critic reviews
            critique = self._critic_review(critic, result)

            if critique.score >= 0.9:
                best_result = result
                break

            # Agent reflects and improves
            self._reflect_and_improve(agent, result, critique)

            if best_result is None or result.total_reward > best_result.total_reward:
                best_result = result

        if best_result is None:
            best_result = EpisodeResult()

        best_result.duration_ms = (time.time() - start) * 1000
        best_result.trajectory = all_trajectories[-1] if all_trajectories else []
        return best_result

    def _run_single_episode(self, agent: Any, env_state: Any) -> EpisodeResult:
        trajectory = []
        total_reward = 0.0
        for step in range(self.max_steps):
            observation = self._get_observation(env_state, "agent_1")
            action = self._agent_act(agent, observation)
            next_state, reward, done, info = self._step(env_state, action, "agent_1")
            trajectory.append({
                "step": step,
                "action": action,
                "reward": reward,
            })
            total_reward += reward
            env_state = next_state
            if done:
                break
        return EpisodeResult(
            trajectory=trajectory,
            total_reward=total_reward,
            success=self._evaluate_success(trajectory),
            steps_taken=len(trajectory),
        )

    def _get_observation(self, env_state: Any, agent_id: str) -> dict[str, Any]:
        if hasattr(env_state, "to_observable"):
            return env_state.to_observable(agent_id)
        return {"state": str(env_state)}

    def _agent_act(self, agent: Any, observation: dict[str, Any]) -> dict[str, Any]:
        if hasattr(agent, "act"):
            return agent.act(observation)
        return {"type": "noop"}

    def _step(self, state: Any, action: dict[str, Any], agent_id: str) -> tuple[Any, float, bool, dict[str, Any]]:
        if hasattr(state, "apply_action"):
            return state.apply_action(agent_id, action)
        return state, 0.0, False, {}

    def _critic_review(self, critic: Any, result: EpisodeResult) -> Critique:
        if hasattr(critic, "review"):
            return critic.review(result)
        # Stub: score based on total reward
        score = min(max(result.total_reward / 10.0, 0.0), 1.0)
        return Critique(
            score=score,
            issues=["No critic available"] if score < 0.5 else [],
            suggestions=["Try a different approach"] if score < 0.7 else [],
        )

    def _reflect_and_improve(self, agent: Any, result: EpisodeResult, critique: Critique) -> None:
        if hasattr(agent, "reflect"):
            agent.reflect(result, critique)

    def _evaluate_success(self, trajectory: list[dict[str, Any]]) -> bool:
        return any(s.get("reward", 0) > 0 for s in trajectory)
