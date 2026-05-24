"""Unit tests for pipeline state management."""

import pytest
from eden.pipeline.state import EdenJobState, create_initial_state


class TestEdenJobState:
    def test_create_initial_state(self):
        """Test creating initial state for a new job."""
        state = create_initial_state(
            job_id="test-123",
            request={
                "description": "CartPole with reward shaping",
                "tags": ["rl", "gymnasium", "classic_control"],
                "framework": "gymnasium",
            },
        )

        assert state["job_id"] == "test-123"
        assert state["request"]["description"] == "CartPole with reward shaping"
        assert state["request"]["tags"] == ["rl", "gymnasium", "classic_control"]
        assert state["edp_history"] == []
        assert state["critic_decisions"] == []
        assert state["code_history"] == []
        assert state["outcome_tier"] is None
        assert state["current_stage"] == "planning"
        assert state["executor_iterations"] == 0
        assert state["critic_replan_count"] == 0

    def test_state_is_typeddict(self):
        """Test that EdenJobState is a proper TypedDict."""
        state: EdenJobState = {
            "job_id": "test-456",
            "request": {"description": "Test"},
            "edp_history": [],
            "critic_decisions": [],
            "routing_history": [],
            "res": None,
            "fact_check_report": None,
            "code_history": [],
            "quality_reports": [],
            "verifier_report": None,
            "tester_results": None,
            "kb_reads": [],
            "agent_proposals": [],
            "outcome_tier": None,
            "archivist_summary": None,
            "executor_iterations": 0,
            "code_quality_iterations": 0,
            "critic_replan_count": 0,
            "critic_reresearch_count": 0,
            "current_stage": "planning",
            "routing_target": None,
            "routing_reason": None,
        }

        assert state["job_id"] == "test-456"
        assert state["current_stage"] == "planning"