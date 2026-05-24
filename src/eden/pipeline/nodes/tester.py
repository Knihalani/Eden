"""Tester node for LangGraph pipeline."""

from eden.agents.tester.agent import TesterAgent
from eden.pipeline.state import EdenJobState


async def tester_node(state: EdenJobState) -> dict:
    """Run the Tester agent and update state with test results.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Tester agent
    """
    agent = TesterAgent()
    result = await agent.run(state)
    return result