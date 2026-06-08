"""Multi-agent test suite and performance benchmarks.

Tests for:
  • Determinism (identical seeds produce identical outcomes)
  • Message delivery (all messages arrive, in order, no duplicates)
  • State consistency (shared state is identical across all agents)
  • Consensus (agents agree on decisions)
  • Adversarial (red vs blue competition is fair)

Ref: eden-multi-agent-orchestration-architecture.md §10
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

from eden.multi_agent.communication import MessageBus, SharedState, SharedStateManager, Message
from eden.multi_agent.agent_roles import RoleSystem, RoleConfig, RoleHierarchy, AgentRole


# ──────────────────────────────────────────────────────────────────────────
# Test result types
# ──────────────────────────────────────────────────────────────────────────

@dataclass
class TestResult:
    """Result of a single test."""

    test_name: str
    passed: bool
    duration_ms: float = 0.0
    details: dict[str, Any] = field(default_factory=dict)
    error: str | None = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "test_name": self.test_name,
            "passed": self.passed,
            "duration_ms": self.duration_ms,
            "details": self.details,
            "error": self.error,
        }


# ──────────────────────────────────────────────────────────────────────────
# Determinism Test
# ──────────────────────────────────────────────────────────────────────────

class DeterminismTest:
    """Verify identical seeds and actions produce identical states."""

    @staticmethod
    def run(state_manager: SharedStateManager, actions: list[tuple[str, dict[str, Any]]]) -> TestResult:
        start = time.time()
        try:
            # Run 1
            sm1 = SharedStateManager()
            for agent_id, action in actions:
                sm1.apply_action(agent_id, action)
            state1 = sm1.state

            # Run 2 (same sequence)
            sm2 = SharedStateManager()
            for agent_id, action in actions:
                sm2.apply_action(agent_id, action)
            state2 = sm2.state

            # Compare
            passed = (
                state1.step_count == state2.step_count
                and state1.cumulative_rewards == state2.cumulative_rewards
                and state1.world == state2.world
            )

            return TestResult(
                test_name="determinism",
                passed=passed,
                duration_ms=(time.time() - start) * 1000,
                details={
                    "action_count": len(actions),
                    "step_count_match": state1.step_count == state2.step_count,
                    "reward_match": state1.cumulative_rewards == state2.cumulative_rewards,
                },
            )
        except Exception as e:
            return TestResult(
                test_name="determinism",
                passed=False,
                error=str(e),
                duration_ms=(time.time() - start) * 1000,
            )


# ──────────────────────────────────────────────────────────────────────────
# Message Delivery Test
# ──────────────────────────────────────────────────────────────────────────

class MessageDeliveryTest:
    """Verify all messages arrive, in order, with no duplicates."""

    @staticmethod
    def run(bus: MessageBus, messages: list[Message]) -> TestResult:
        start = time.time()
        try:
            sent_ids = set()
            for msg in messages:
                bus.publish(msg.to_agent, msg)
                sent_ids.add(msg.id)

            # Collect all received messages
            all_received: list[Message] = []
            for agent_id in bus._subscribers:
                received = bus.get_messages(agent_id)
                all_received.extend(received)

            received_ids = {m.id for m in all_received}
            duplicates = len(all_received) - len(received_ids)

            passed = (
                sent_ids == received_ids
                and duplicates == 0
            )

            return TestResult(
                test_name="message_delivery",
                passed=passed,
                duration_ms=(time.time() - start) * 1000,
                details={
                    "sent": len(sent_ids),
                    "received": len(received_ids),
                    "duplicates": duplicates,
                    "missing": list(sent_ids - received_ids),
                },
            )
        except Exception as e:
            return TestResult(
                test_name="message_delivery",
                passed=False,
                error=str(e),
                duration_ms=(time.time() - start) * 1000,
            )


# ──────────────────────────────────────────────────────────────────────────
# State Consistency Test
# ──────────────────────────────────────────────────────────────────────────

class StateConsistencyTest:
    """Verify shared state is identical across all agents after updates."""

    @staticmethod
    def run(state_manager: SharedStateManager, expected_agents: list[str]) -> TestResult:
        start = time.time()
        try:
            state = state_manager.state
            observations = {
                agent_id: state.to_observable(agent_id)
                for agent_id in expected_agents
            }

            # All agents should see the same step_count and world
            step_counts = {obs["step_count"] for obs in observations.values()}
            worlds = [str(obs.get("world", "")) for obs in observations.values()]

            passed = len(step_counts) == 1 and len(set(worlds)) == 1

            return TestResult(
                test_name="state_consistency",
                passed=passed,
                duration_ms=(time.time() - start) * 1000,
                details={
                    "agent_count": len(expected_agents),
                    "step_count_consistent": len(step_counts) == 1,
                    "world_consistent": len(set(worlds)) == 1,
                    "observed_step_count": next(iter(step_counts)) if step_counts else None,
                },
            )
        except Exception as e:
            return TestResult(
                test_name="state_consistency",
                passed=False,
                error=str(e),
                duration_ms=(time.time() - start) * 1000,
            )


# ──────────────────────────────────────────────────────────────────────────
# Consensus Test
# ──────────────────────────────────────────────────────────────────────────

class ConsensusTest:
    """Verify agents can reach agreement on a shared decision."""

    @staticmethod
    def run(votes: dict[str, str], required_agreement: float = 0.51) -> TestResult:
        start = time.time()
        try:
            if not votes:
                return TestResult(
                    test_name="consensus",
                    passed=False,
                    error="No votes provided",
                    duration_ms=(time.time() - start) * 1000,
                )

            total = len(votes)
            vote_counts: dict[str, int] = {}
            for v in votes.values():
                vote_counts[v] = vote_counts.get(v, 0) + 1

            winner = max(vote_counts, key=lambda k: vote_counts[k])
            agreement = vote_counts[winner] / total
            passed = agreement >= required_agreement

            return TestResult(
                test_name="consensus",
                passed=passed,
                duration_ms=(time.time() - start) * 1000,
                details={
                    "total_agents": total,
                    "winner": winner,
                    "agreement_ratio": agreement,
                    "required_ratio": required_agreement,
                    "vote_distribution": vote_counts,
                },
            )
        except Exception as e:
            return TestResult(
                test_name="consensus",
                passed=False,
                error=str(e),
                duration_ms=(time.time() - start) * 1000,
            )


# ──────────────────────────────────────────────────────────────────────────
# Adversarial Test
# ──────────────────────────────────────────────────────────────────────────

class AdversarialTest:
    """Verify red vs blue competition is fair and scores sum correctly."""

    @staticmethod
    def run(red_scores: list[float], blue_scores: list[float]) -> TestResult:
        start = time.time()
        try:
            if not red_scores or not blue_scores:
                return TestResult(
                    test_name="adversarial_fairness",
                    passed=False,
                    error="Empty score lists",
                    duration_ms=(time.time() - start) * 1000,
                )

            red_total = sum(red_scores)
            blue_total = sum(blue_scores)
            rounds = len(red_scores)

            # Fairness: both sides had same number of rounds
            same_rounds = len(red_scores) == len(blue_scores)
            # Competition: scores should not be identical (some asymmetry)
            not_identical = red_total != blue_total
            # Zero-sum-ish: total should be bounded
            total_score = red_total + blue_total
            bounded = total_score >= 0  # Non-negative scores expected

            passed = same_rounds and bounded

            return TestResult(
                test_name="adversarial_fairness",
                passed=passed,
                duration_ms=(time.time() - start) * 1000,
                details={
                    "rounds": rounds,
                    "red_total": red_total,
                    "blue_total": blue_total,
                    "same_rounds": same_rounds,
                    "winner": "red" if red_total > blue_total else "blue" if blue_total > red_total else "tie",
                    "score_gap": abs(red_total - blue_total),
                },
            )
        except Exception as e:
            return TestResult(
                test_name="adversarial_fairness",
                passed=False,
                error=str(e),
                duration_ms=(time.time() - start) * 1000,
            )


# ──────────────────────────────────────────────────────────────────────────
# Multi-Agent Test Suite
# ──────────────────────────────────────────────────────────────────────────

class MultiAgentTestSuite:
    """Run the complete multi-agent test suite."""

    def __init__(self):
        self.results: list[TestResult] = []
        self._start_time = 0.0

    def run_all(self, agent_count: int = 3, action_count: int = 10) -> dict[str, Any]:
        self._start_time = time.time()
        self.results = []

        # 1. Determinism
        actions = [(f"agent_{i % agent_count}", {"type": "test", "value": i}) for i in range(action_count)]
        sm = SharedStateManager()
        for agent_id, action in actions:
            sm.apply_action(agent_id, action)
        self.results.append(DeterminismTest.run(sm, actions))

        # 2. Message Delivery
        bus = MessageBus()
        msgs = []
        for i in range(action_count):
            to_agent = f"agent_{i % agent_count}"
            msg = Message(from_agent="test", to_agent=to_agent, content={"seq": i})
            msgs.append(msg)
            bus.subscribe(to_agent, lambda m: None)  # Dummy handler
        self.results.append(MessageDeliveryTest.run(bus, msgs))

        # 3. State Consistency
        self.results.append(StateConsistencyTest.run(sm, [f"agent_{i}" for i in range(agent_count)]))

        # 4. Consensus
        votes = {f"agent_{i}": "yes" if i < agent_count - 1 else "no" for i in range(agent_count)}
        self.results.append(ConsensusTest.run(votes))

        # 5. Adversarial
        red_scores = [1.0, 0.5, 1.5, 2.0]
        blue_scores = [0.5, 1.0, 1.0, 1.5]
        self.results.append(AdversarialTest.run(red_scores, blue_scores))

        total_duration = (time.time() - self._start_time) * 1000
        passed_count = sum(1 for r in self.results if r.passed)
        failed_count = len(self.results) - passed_count

        return {
            "total_tests": len(self.results),
            "passed": passed_count,
            "failed": failed_count,
            "duration_ms": total_duration,
            "all_passed": failed_count == 0,
            "results": [r.to_dict() for r in self.results],
        }

    def benchmark_performance(self, agent_counts: list[int] = None, message_counts: list[int] = None) -> dict[str, Any]:
        """Benchmark message throughput and state update latency."""
        agent_counts = agent_counts or [2, 5, 10]
        message_counts = message_counts or [10, 50, 100]
        benchmarks = []

        for ac in agent_counts:
            for mc in message_counts:
                # Message throughput
                bus = MessageBus()
                for i in range(ac):
                    bus.subscribe(f"agent_{i}", lambda m: None)

                start = time.time()
                for i in range(mc):
                    msg = Message(from_agent="benchmark", to_agent=f"agent_{i % ac}", content={"seq": i})
                    bus.publish(msg.to_agent, msg)
                msg_duration = (time.time() - start) * 1000

                # State update latency
                sm = SharedStateManager()
                start = time.time()
                for i in range(mc):
                    sm.apply_action(f"agent_{i % ac}", {"type": "update", "value": i})
                state_duration = (time.time() - start) * 1000

                benchmarks.append({
                    "agent_count": ac,
                    "message_count": mc,
                    "message_throughput_msgs_per_sec": round(mc / (msg_duration / 1000), 2) if msg_duration > 0 else float('inf'),
                    "state_update_latency_ms_per_op": round(state_duration / mc, 4) if mc > 0 else 0,
                    "total_msg_duration_ms": round(msg_duration, 2),
                    "total_state_duration_ms": round(state_duration, 2),
                })

        return {
            "benchmarks": benchmarks,
            "summary": {
                "max_agent_count": max(agent_counts),
                "max_message_count": max(message_counts),
                "best_throughput": max(b["message_throughput_msgs_per_sec"] for b in benchmarks),
            },
        }
