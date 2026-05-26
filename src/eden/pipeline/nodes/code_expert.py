"""Code Expert node for LangGraph pipeline."""

from eden.agents.experts.code_expert.agent import CodeExpertAgent
from eden.pipeline.state import EdenJobState


async def code_expert_node(state: EdenJobState) -> dict:
    """Run the Code Expert agent and provide code optimization expertise.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Code Expert agent
    """
    agent = CodeExpertAgent()
    result = await agent.run(state)
    return result