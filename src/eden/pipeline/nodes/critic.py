"""Critic node for LangGraph pipeline."""

from eden.agents.critic.agent import CriticAgent
from eden.pipeline.state import EdenJobState


async def critic_node(state: EdenJobState) -> dict:
    """Run the Critic agent and update state with critique.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Critic agent
    """
    agent = CriticAgent()
    result = await agent.run(state)
    return result