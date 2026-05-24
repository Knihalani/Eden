"""Fact Checker node for LangGraph pipeline."""

from eden.agents.fact_checker.agent import FactCheckerAgent
from eden.pipeline.state import EdenJobState


async def fact_checker_node(state: EdenJobState) -> dict:
    """Run the Fact Checker agent and update state with fact check report.

    Args:
        state: Current pipeline state

    Returns:
        State updates from Fact Checker agent
    """
    agent = FactCheckerAgent()
    result = await agent.run(state)
    return result