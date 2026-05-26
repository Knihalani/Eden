"""Sandbox Expert node for LangGraph pipeline."""

from eden.agents.experts.sandbox_expert.agent import SandboxExpertAgent
from eden.pipeline.state import EdenJobState


async def sandbox_expert_node(state: EdenJobState) -> dict:
    """Run the Sandbox Expert agent and update state with guidance.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Sandbox Expert agent
    """
    agent = SandboxExpertAgent()
    result = await agent.run(state)
    return result