"""Testing Expert node for LangGraph pipeline."""

from eden.pipeline.state import EdenJobState


async def testing_expert_node(state: EdenJobState) -> dict:
    """Run the Testing Expert agent and update state with guidance.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Testing Expert agent
    """
    from eden.agents.experts.testing_expert.agent import TestingExpertAgent

    agent = TestingExpertAgent()
    result = await agent.run(state)
    return result