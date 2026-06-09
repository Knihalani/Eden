"""Tests for Critic agent — B.2 Devil's Advocate Integration."""

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from eden.agents.critic.agent import CriticAgent, DevilAdvocateAgent


class TestDevilAdvocateAgent:
    """Tests for the Devil's Advocate agent."""

    @pytest.fixture
    def mock_llm(self):
        """Mock LLM client."""
        client = MagicMock()
        # OpenRouterClient.call is sync; use MagicMock, not AsyncMock.
        client.call = MagicMock(return_value=MagicMock(
            content='{"issues": [{"type": "reward_hacking", "description": "Agent could exploit terminal reward"}], "risks": ["Difficulty miscalibrated"]}'
        ))
        return client

    @pytest.fixture
    def sample_edp(self):
        """Sample EDP for testing."""
        return {
            "meta": {
                "environment_class": "rl_training",
                "novelty_assessment": "novel",
                "design_confidence": 0.5,
            },
            "environment": {
                "observation_space": {"type": "Box", "shape": [4]},
                "action_space": {"type": "Discrete", "n": 2},
                "reward_structure": {"type": "dense"},
            },
        }

    @pytest.mark.asyncio
    async def test_devil_advocate_runs_and_parses(self, mock_llm, sample_edp):
        """Test Devil's Advocate runs and returns parsed issues."""
        agent = DevilAdvocateAgent(mock_llm)
        result = await agent.run(sample_edp)

        assert "issues" in result
        assert isinstance(result["issues"], list)
        mock_llm.call.assert_called_once()

    @pytest.mark.asyncio
    async def test_devil_advocate_calls_with_correct_slot(self, mock_llm, sample_edp):
        """Test Devil's Advocate uses reasoning slot."""
        agent = DevilAdvocateAgent(mock_llm)
        await agent.run(sample_edp)

        call_kwargs = mock_llm.call.call_args[1]
        assert call_kwargs["slot"] == "reasoning"
        assert call_kwargs["agent"] == "critic_devil_advocate"


class TestCriticAgentDevilAdvocateIntegration:
    """Tests for Critic agent with Devil's Advocate integration."""

    @pytest.fixture
    def mock_llm(self):
        """Mock LLM client."""
        client = MagicMock()
        # OpenRouterClient.call is sync (returns LLMResponse); the test
        # fixture is in async context but the call method isn't async,
        # so use MagicMock (not AsyncMock) for the return value.
        client.call = MagicMock(return_value=MagicMock(
            content='{"routing": "approve", "routing_reason": "Design is sound", "dimensions": {}}'
        ))
        return client

    @pytest.fixture
    def sample_state(self):
        """Sample EdenJobState for testing."""
        return {
            "job_id": "test-job-123",
            "edp_history": [{
                "meta": {
                    "novelty_assessment": "novel",
                    "design_confidence": 0.5,
                },
                "environment": {
                    "observation_space": {"type": "Box", "shape": [4]},
                    "action_space": {"type": "Discrete", "n": 2},
                },
            }],
            "critic_replan_count": 0,
            "critic_reresearch_count": 0,
        }

    @pytest.mark.asyncio
    async def test_critic_triggers_devil_advocate_for_novel_edp(self, mock_llm, sample_state):
        """Test Critic spawns Devil's Advocate when EDP is novel."""
        agent = CriticAgent(mock_llm)

        with patch.object(DevilAdvocateAgent, 'run', new=AsyncMock(return_value={"issues": [], "risks": []})) as mock_da:
            result = await agent.run(sample_state)

            assert mock_da.call_count == 1
            assert result["current_stage"] == "refining"

    @pytest.mark.asyncio
    async def test_critic_triggers_devil_advocate_for_low_confidence(self, mock_llm):
        """Test Critic spawns Devil's Advocate when design_confidence < 0.7."""
        agent = CriticAgent(mock_llm)

        low_confidence_state = {
            "job_id": "test-job-456",
            "edp_history": [{
                "meta": {
                    "novelty_assessment": "standard",
                    "design_confidence": 0.6,
                },
                "environment": {},
            }],
            "critic_replan_count": 0,
            "critic_reresearch_count": 0,
        }

        with patch.object(DevilAdvocateAgent, 'run', new=AsyncMock(return_value={"issues": [], "risks": []})) as mock_da:
            result = await agent.run(low_confidence_state)
            assert mock_da.call_count == 1

    @pytest.mark.asyncio
    async def test_critic_skips_devil_advocate_for_standard_edp(self, mock_llm):
        """Test Critic skips Devil's Advocate for standard, high-confidence EDP."""
        agent = CriticAgent(mock_llm)

        standard_state = {
            "job_id": "test-job-789",
            "edp_history": [{
                "meta": {
                    "novelty_assessment": "standard",
                    "design_confidence": 0.85,
                },
                "environment": {},
            }],
            "critic_replan_count": 0,
            "critic_reresearch_count": 0,
        }

        with patch.object(DevilAdvocateAgent, 'run', new=AsyncMock()) as mock_da:
            result = await agent.run(standard_state)
            assert mock_da.call_count == 0

    @pytest.mark.asyncio
    async def test_critic_incorporates_devil_advocate_in_critique(self, mock_llm, sample_state):
        """Test Critic passes Devil's Advocate review to main LLM."""
        agent = CriticAgent(mock_llm)

        mock_da_response = {
            "issues": [{"type": "specification_gaming", "description": "Literal reward without intent"}],
            "risks": ["Agent might find shortcuts"],
        }

        with patch.object(DevilAdvocateAgent, 'run', new=AsyncMock(return_value=mock_da_response)) as mock_da:
            await agent.run(sample_state)

            # Verify prompt includes devil's advocate review
            call_kwargs = mock_llm.call.call_args[1]
            prompt = call_kwargs["prompt"]
            assert "DEVIL'S ADVOCATE CONTRARIAN REVIEW" in prompt
            assert "Literal reward without intent" in prompt


class TestCriticRouting:
    """Tests for Critic agent routing logic."""

    @pytest.fixture
    def mock_llm(self):
        """Mock LLM client."""
        return MagicMock()

    @pytest.fixture
    def base_state(self):
        """Base state for routing tests."""
        return {
            "job_id": "test-job-routing",
            "edp_history": [{
                "meta": {"novelty_assessment": "standard", "design_confidence": 0.9},
                "environment": {},
            }],
            "critic_replan_count": 0,
            "critic_reresearch_count": 0,
        }

    @pytest.mark.asyncio
    async def test_routing_approve_leads_to_refining(self, mock_llm, base_state):
        """Test approve routing sends to refining stage."""
        mock_llm.call = AsyncMock(return_value=MagicMock(
            content='{"routing": "approve", "routing_reason": "Looks good", "dimensions": {}}'
        ))
        agent = CriticAgent(mock_llm)
        result = await agent.run(base_state)

        assert result["current_stage"] == "refining"

    @pytest.mark.asyncio
    async def test_routing_targeted_replan_increments_count(self, mock_llm, base_state):
        """Test targeted_replan increments critic_replan_count."""
        mock_llm.call = AsyncMock(return_value=MagicMock(
            content='{"routing": "targeted_replan", "routing_reason": "Fix reward spec", "dimensions": {}}'
        ))
        agent = CriticAgent(mock_llm)
        result = await agent.run(base_state)

        assert result["current_stage"] == "planning"
        assert result["critic_replan_count"] == 1

    @pytest.mark.asyncio
    async def test_routing_full_reresearch_increments_count(self, mock_llm, base_state):
        """Test full_reresearch increments critic_reresearch_count."""
        mock_llm.call = AsyncMock(return_value=MagicMock(
            content='{"routing": "full_reresearch", "routing_reason": "Need more research", "dimensions": {}}'
        ))
        agent = CriticAgent(mock_llm)
        result = await agent.run(base_state)

        assert result["current_stage"] == "planning"
        assert result["critic_reresearch_count"] == 1

    @pytest.mark.asyncio
    async def test_routing_reject_goes_to_human_review(self, mock_llm, base_state):
        """Test reject/escalate routing sends to human_review."""
        mock_llm.call = AsyncMock(return_value=MagicMock(
            content='{"routing": "reject", "routing_reason": "Fundamental flaw", "dimensions": {}}'
        ))
        agent = CriticAgent(mock_llm)
        result = await agent.run(base_state)

        assert result["current_stage"] == "human_review"